/**
 * Scheduled area monitoring. The host's task scheduler runs the monitor's task every few minutes. While the
 * "Monitor my areas on a schedule" setting is on, each run scans the instance's configured Areas (read through
 * ctx.areas()), so the police heatmap keeps filling while nobody has the map open. Off by default: with the
 * setting off, a run returns at once and asks nothing.
 *
 * A poll asks the harvester through the same 60 s cache the map uses, so a map view and the monitor share one
 * scan per grid cell. It keeps an answer only when the answer is fresh, as the alerts route does.
 */
import type { PluginArea } from './sdk/server-api.js';
import { fetchWazeAlertsCached, validateWazeBounds, type FetchFn, type Harvester, type ScanCache, type WazeBoundingBox, type WazeFetchResult } from './feed.js';
import type { SightingKeeper } from './sightings.js';

/** The task id the plugin registers with the host. */
export const MONITOR_TASK_ID = 'area-monitor';
/** The boolean setting that turns monitoring on. */
export const MONITOR_SETTING = 'monitorMyAreas';
export const MONITOR_DEFAULT_MINUTES = 5;
export const MONITOR_MIN_MINUTES = 1;
export const MONITOR_MAX_MINUTES = 1440;
/** The most Areas one run scans. ctx.areas() lists the home area first, so it is always among them. */
export const MONITOR_MAX_AREAS = 10;
/** Asks per area while the harvester has it queued or scanning. A queued area is not a failure. */
const MAX_ASKS = 3;
const MIN_WAIT_MS = 1000;
const MAX_WAIT_MS = 30000;
/** No new area starts after this much of one poll, so a slow harvester cannot hold the task for long. */
const RUN_BUDGET_MS = 120000;
/** Kilometres per degree of latitude, as the box conversion uses it. */
const KM_PER_DEG_LAT = 111.32;
/** At a cosine of latitude below this (about 0.000001 degrees from a pole) an Area spans every longitude. */
const POLE_COS = 1e-6;

/** Whether monitoring is on. Only the boolean true turns it on; anything else is off. */
export function monitorOn(settings: Record<string, unknown>): boolean {
  return settings[MONITOR_SETTING] === true;
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

/**
 * The bounding box round one Area: its centre, and radiusKm each way. The longitude reach is widened by
 * 1 / cos(latitude), so the box is about as wide in kilometres as it is tall. A box that runs past the world's
 * edge is trimmed to it. Throws, with the reason, when the Area cannot be scanned.
 */
export function areaBox(area: PluginArea): WazeBoundingBox {
  const { lat, lng, radiusKm } = area;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error('its centre is not a valid latitude and longitude');
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) throw new Error('its radius is not above zero');
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLng = cos < POLE_COS ? 180 : radiusKm / (KM_PER_DEG_LAT * cos);
  const box: WazeBoundingBox = {
    minLng: Math.max(-180, lng - dLng),
    minLat: Math.max(-90, lat - dLat),
    maxLng: Math.min(180, lng + dLng),
    maxLat: Math.min(90, lat + dLat),
  };
  try {
    validateWazeBounds(box);
  } catch {
    throw new Error('the box it makes is too small to scan at this latitude');
  }
  return box;
}

/** One Area to poll: its name for the log, and the box it covers. */
export interface MonitorTarget { label: string; box: WazeBoundingBox }

export interface MonitorTargets {
  targets: MonitorTarget[];
  /** One line per Area that was skipped, for the admin's log. */
  problems: string[];
}

/** The Area's name for the log, or its place in the list when it has none. */
function labelOf(area: PluginArea, index: number): string {
  const name = typeof area?.name === 'string' ? area.name.trim() : '';
  return name || `area ${index + 1}`;
}

function boxKey(bbox: WazeBoundingBox): string {
  return `${bbox.minLng},${bbox.minLat},${bbox.maxLng},${bbox.maxLat}`;
}

/**
 * The Areas as boxes to poll, in the order given. An Area that cannot be scanned is skipped and reported, and so is
 * one whose box an earlier Area already has. At most MONITOR_MAX_AREAS are kept; the rest are reported.
 */
export function monitorTargets(areas: readonly PluginArea[]): MonitorTargets {
  const out: MonitorTargets = { targets: [], problems: [] };
  const seen = new Map<string, string>();
  areas.forEach((area, index) => {
    const label = labelOf(area, index);
    let box: WazeBoundingBox;
    try {
      box = areaBox(area);
    } catch (err) {
      out.problems.push(`${label}: ${err instanceof Error ? err.message : 'it cannot be read'}. It is not scanned.`);
      return;
    }
    const earlier = seen.get(boxKey(box));
    if (earlier !== undefined) {
      out.problems.push(`${label} has the same box as ${earlier}. It is not scanned.`);
      return;
    }
    if (out.targets.length >= MONITOR_MAX_AREAS) {
      out.problems.push(`${label} is past the limit of ${MONITOR_MAX_AREAS} areas. It is not scanned.`);
      return;
    }
    seen.set(boxKey(box), label);
    out.targets.push({ label, box });
  });
  return out;
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
   * One pass over the targets, starting where the last failed pass stopped. A failure (the harvester is down, busy
   * or answers badly) ends the pass, and the next pass starts after the failing area, so one area that keeps
   * failing cannot keep the others from being polled. Every error is a result, not a throw.
   */
  async poll(targets: readonly MonitorTarget[], log: (line: string) => void): Promise<MonitorRunResult> {
    if (this.stopped) return { ok: false, message: 'The plugin has stopped' };
    if (targets.length === 0) return { ok: true, message: 'Skipped: no areas to scan' };
    const { harvester, problem } = this.opts.harvester();
    if (!harvester) return { ok: false, message: problem ?? 'The harvester is not set up' };
    try {
      const started = this.now();
      const first = this.cursor % targets.length;
      let polled = 0;
      let recorded = 0;
      for (let step = 0; step < targets.length; step++) {
        const index = (first + step) % targets.length;
        const { label, box } = targets[index];
        if (this.stopped) return { ok: false, message: 'The plugin stopped during the poll' };
        if (this.now() - started >= RUN_BUDGET_MS) {
          this.cursor = index;
          return { ok: true, message: `${polled} of ${targets.length} areas polled; the rest wait for the next poll` };
        }
        let answer: Answer | null;
        try {
          answer = await this.ask(harvester, box);
        } catch (err) {
          this.cursor = (index + 1) % targets.length;
          const reason = err instanceof Error ? err.message : 'Waze report bridge failed';
          log(`${label}: ${reason}`);
          return { ok: false, message: `${polled} of ${targets.length} areas polled; stopped at ${label}: ${reason}` };
        }
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
      return { ok: true, message: `${polled} of ${targets.length} areas polled, ${recorded} police reports recorded` };
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
