/**
 * Scheduled area monitoring. The host's task scheduler runs `AreaMonitor.poll` every few minutes for the
 * areas set in Settings, so the police heatmap keeps filling while nobody has the map open. Opt-in: with no
 * areas set, no task is registered and nothing is polled.
 *
 * A poll asks the harvester through the same 60 s cache the map uses, so a map view and the monitor share one
 * scan per grid cell. It keeps an answer only when the answer is fresh, as the alerts route does.
 */
import { fetchWazeAlertsCached, validateWazeBounds, type FetchFn, type Harvester, type ScanCache, type WazeBoundingBox, type WazeFetchResult } from './feed.js';
import type { SightingKeeper } from './sightings.js';

/** The task id the plugin registers with the host. */
export const MONITOR_TASK_ID = 'area-monitor';
export const MONITOR_DEFAULT_MINUTES = 5;
export const MONITOR_MIN_MINUTES = 1;
export const MONITOR_MAX_MINUTES = 1440;
export const MONITOR_MAX_AREAS = 10;
/** Asks per area while the harvester has it queued or scanning. A queued area is not a failure. */
const MAX_ASKS = 3;
const MIN_WAIT_MS = 1000;
const MAX_WAIT_MS = 30000;
/** No new area starts after this much of one poll, so a slow harvester cannot hold the task for long. */
const RUN_BUDGET_MS = 120000;

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

export interface ParsedAreas {
  areas: WazeBoundingBox[];
  /** One line per entry that was ignored, for the admin's log. */
  problems: string[];
}

/**
 * The monitored areas from the settings text. Each area is minLng,minLat,maxLng,maxLat (the map's bounding box
 * order), and areas are separated by semicolons or new lines. Entries that do not parse, are out of range, are
 * duplicates or pass the limit are ignored and reported; the valid ones are still monitored.
 */
export function parseMonitorAreas(text: unknown): ParsedAreas {
  const out: ParsedAreas = { areas: [], problems: [] };
  if (typeof text !== 'string') return out;
  const seen = new Set<string>();
  for (const piece of text.split(/[;\n]/).map(p => p.trim()).filter(Boolean)) {
    const parts = piece.split(',').map(p => p.trim());
    if (parts.length !== 4 || !parts.every(p => NUMBER.test(p))) {
      out.problems.push(`"${piece}" is not four numbers, minLng,minLat,maxLng,maxLat`);
      continue;
    }
    const [minLng, minLat, maxLng, maxLat] = parts.map(Number);
    const bbox = { minLng, minLat, maxLng, maxLat };
    try {
      validateWazeBounds(bbox);
    } catch {
      out.problems.push(`"${piece}" needs min below max, with longitude -180..180 and latitude -90..90`);
      continue;
    }
    const key = describeArea(bbox);
    if (seen.has(key)) { out.problems.push(`"${piece}" is listed twice`); continue; }
    if (out.areas.length >= MONITOR_MAX_AREAS) { out.problems.push(`"${piece}" is past the limit of ${MONITOR_MAX_AREAS} areas`); continue; }
    seen.add(key);
    out.areas.push(bbox);
  }
  return out;
}

/**
 * The interval in whole minutes, kept between the minimum and the maximum. A missing or unreadable value is the
 * default. The settings form enforces the same range when it is saved; this covers a value that got past it.
 */
export function intervalMinutesOf(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return MONITOR_DEFAULT_MINUTES;
  return Math.min(MONITOR_MAX_MINUTES, Math.max(MONITOR_MIN_MINUTES, Math.round(n)));
}

export interface MonitorSettings extends ParsedAreas {
  intervalMinutes: number;
}

/** Both monitor settings, read from the plugin's settings (raw or with the manifest defaults applied). */
export function monitorSettingsOf(settings: Record<string, unknown>): MonitorSettings {
  return { ...parseMonitorAreas(settings.monitorAreas), intervalMinutes: intervalMinutesOf(settings.monitorIntervalMinutes) };
}

export function describeArea(bbox: WazeBoundingBox): string {
  return `${bbox.minLng},${bbox.minLat},${bbox.maxLng},${bbox.maxLat}`;
}

export interface MonitorOptions {
  keeper: SightingKeeper;
  cache: ScanCache;
  fetchFn: FetchFn;
  /** The harvester the settings name now, or why there is none. Read on every poll, so a changed address applies at once. */
  harvester: () => { harvester: Harvester | null; problem: string | null };
  now?: () => number;
  /** The wait between asks of a queued area. Tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
}

export interface MonitorRunResult { ok: boolean; message: string }

type Answer = WazeFetchResult & { fromCache: boolean };

export class AreaMonitor {
  private cursor = 0;
  private stopped = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: MonitorOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  }

  /** Called on deactivate. A poll still running stops before its next area and records nothing more. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * One pass over the areas, starting where the last failed pass stopped. A failure (the harvester is down, busy
   * or answers badly) ends the pass, and the next pass starts after the failing area, so one area that keeps
   * failing cannot keep the others from being polled. Every error is a result, not a throw.
   */
  async poll(areas: readonly WazeBoundingBox[], log: (line: string) => void): Promise<MonitorRunResult> {
    if (this.stopped) return { ok: false, message: 'The plugin has stopped' };
    if (areas.length === 0) return { ok: true, message: 'Skipped: no areas are set' };
    const { harvester, problem } = this.opts.harvester();
    if (!harvester) return { ok: false, message: problem ?? 'The harvester is not set up' };
    try {
      const started = this.now();
      const first = this.cursor % areas.length;
      let polled = 0;
      let recorded = 0;
      for (let step = 0; step < areas.length; step++) {
        const index = (first + step) % areas.length;
        const label = describeArea(areas[index]);
        if (this.stopped) return { ok: false, message: 'The plugin stopped during the poll' };
        if (this.now() - started >= RUN_BUDGET_MS) {
          this.cursor = index;
          return { ok: true, message: `${polled} of ${areas.length} areas polled; the rest wait for the next poll` };
        }
        let answer: Answer | null;
        try {
          answer = await this.ask(harvester, areas[index]);
        } catch (err) {
          this.cursor = (index + 1) % areas.length;
          const reason = err instanceof Error ? err.message : 'Waze report bridge failed';
          log(`${label}: ${reason}`);
          return { ok: false, message: `${polled} of ${areas.length} areas polled; stopped at ${label}: ${reason}` };
        }
        // The plugin may have stopped while the harvester was answering: such an answer is not recorded.
        // The plugin may have stopped while the harvester was answering: such an answer is not recorded.
        if (this.stopped) return { ok: false, message: 'The plugin stopped during the poll' };
        if (!answer) {
          log(`${label}: still queued at the harvester after ${MAX_ASKS} asks; the next poll asks again`);
          continue;
        }
        const count = this.opts.keeper.keep(answer, answer.fromCache, this.now());
        polled++;
        recorded += count;
        log(answer.fromCache
          ? `${label}: ${answer.alerts.length} reports from the 60 s cache, already recorded`
          : `${label}: ${answer.alerts.length} reports, ${count} police recorded`);
      }
      this.cursor = 0;
      return { ok: true, message: `${polled} of ${areas.length} areas polled, ${recorded} police reports recorded` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'The area poll failed' };
    }
  }

  /** The area's answer when the harvester has it fresh or stale, or null after MAX_ASKS while it is still queued. */
  private async ask(harvester: Harvester, bbox: WazeBoundingBox): Promise<Answer | null> {
    for (let ask = 1; ask <= MAX_ASKS && !this.stopped; ask++) {
      // 'map' is the only non-navigation priority the harvester accepts, and it shares the map's cache entries.
      const answer = await fetchWazeAlertsCached(harvester, bbox, { cache: this.opts.cache, fetchFn: this.opts.fetchFn, now: this.now(), priority: 'map' });
      if (answer.state === 'fresh' || answer.state === 'stale') return answer;
      if (ask < MAX_ASKS) await this.sleep(Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, answer.retryAfterMs)));
    }
    return null;
  }
}
