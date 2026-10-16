/**
 * Waze police and hazard reports, read from a self-hosted harvester.
 *
 * Ported from PhotoScout server/src/feeds/waze.ts. What changed:
 *  - the harvester address and key come from this plugin's settings, not env vars;
 *  - every call goes through the host's ctx.fetch (passed in as `fetchFn`), so the
 *    declared `network` permission is what lets it reach a loopback or compose host;
 *  - the harvester must be one of the hosts plugin.json declares, so the API key is
 *    never sent to any other address (ctx.fetch alone would allow a public one);
 *  - the 60 s grid cache is a value the plugin owns, not module state.
 */

export interface WazeBoundingBox { minLng: number; minLat: number; maxLng: number; maxLat: number }

export interface WazeAlert {
  id: string; type: string; subType?: string; reportTime: number | null;
  point: [number, number]; street?: string; city?: string; description?: string; thumbsUp?: number;
}

export type WazePriority = 'map' | 'navigation';
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const TYPES = new Set(['POLICE', 'HAZARD', 'CONSTRUCTION', 'CAMERA', 'ROAD_CLOSED', 'ACCIDENT', 'JAM']);

export const WORLD: WazeBoundingBox = { minLng: -180, minLat: -90, maxLng: 180, maxLat: 90 };

export const SETUP_MESSAGE = 'Set up Waze police and hazard reports in Settings';
export const BAD_ADDRESS_MESSAGE = 'The harvester address must be an http or https URL with no username or password';
export const UNDECLARED_MESSAGE = 'The harvester address is not a host this plugin declares. Its network permissions in plugin.json list the only hosts it may call';

export function validateWazeBounds(bbox: WazeBoundingBox): void {
  const { minLng, minLat, maxLng, maxLat } = bbox;
  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite) || minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90 || minLng >= maxLng || minLat >= maxLat) {
    throw new Error('A valid bounding box within longitude -180..180 and latitude -90..90 is required');
  }
}

/** A harvester the plugin may call. Built only by resolveHarvester, so it is always a declared host. */
export interface Harvester {
  /** As configured, without a trailing slash, e.g. http://127.0.0.1:8098. */
  base: string;
  alertsUrl: string;
  healthUrl: string;
  /** hostname:port as URL normalises it. */
  host: string;
  apiKey: string;
}

/** One `network` entry from plugin.json: an exact host, and a port when one is given. */
export interface DeclaredHost { host: string; port: number | null }

/** The exact host entries in a plugin's `network` permissions. Wildcards and unparseable entries open nothing, as in ctx.fetch. */
export function declaredHarvesterHosts(permissions: readonly { kind: string; detail?: string }[] = []): DeclaredHost[] {
  const out: DeclaredHost[] = [];
  for (const p of permissions) {
    if (p.kind !== 'network' || !p.detail) continue;
    const m = /^(\[[^\]]+\]|[^:*]+)(?::(\d{1,5}))?$/.exec(p.detail.trim().toLowerCase());
    if (!m) continue;
    out.push({ host: m[1].replace(/^\[|\]$/g, ''), port: m[2] ? Number(m[2]) : null });
  }
  return out;
}

function effectivePort(url: URL): number {
  return url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
}

/** Whether `url` is a declared host: same hostname, and the same port when the declaration has one. */
export function isDeclared(url: URL, declared: readonly DeclaredHost[]): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = effectivePort(url);
  return declared.some((d) => d.host === host && (d.port === null || d.port === port));
}

/**
 * Turn the configured address into a harvester, or say why there is none. The address may be the
 * base (http://127.0.0.1:8098) or the alerts URL the core app stores (http://127.0.0.1:8098/alerts);
 * both are reduced to the same base.
 */
export function resolveHarvester(
  address: string | null | undefined,
  apiKey: string | null | undefined,
  declared: readonly DeclaredHost[],
): { harvester: Harvester | null; problem: string | null } {
  const text = typeof address === 'string' ? address.trim() : '';
  if (!text) return { harvester: null, problem: SETUP_MESSAGE };
  let url: URL;
  try { url = new URL(text); } catch { return { harvester: null, problem: BAD_ADDRESS_MESSAGE }; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return { harvester: null, problem: BAD_ADDRESS_MESSAGE };
  if (!isDeclared(url, declared)) return { harvester: null, problem: UNDECLARED_MESSAGE };
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(alerts|health)$/, '').replace(/\/+$/, '');
  const base = `${url.origin}${path}`;
  return {
    harvester: { base, alertsUrl: `${base}/alerts`, healthUrl: `${base}/health`, host: url.host, apiKey: typeof apiKey === 'string' ? apiKey : '' },
    problem: null,
  };
}

export interface WazeWorkerHealth {
  setupStage: string | null;
  firstRun: { detectedAt: number | null; how: string | null } | null;
}

/** The worker's setup stage and, while Waze waits for a person, its first-run instructions. Health is public, so no key is sent. */
export async function fetchWazeWorkerHealth(harvester: Harvester, fetchFn: FetchFn): Promise<WazeWorkerHealth | null> {
  const response = await fetchFn(harvester.healthUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
  if (!response.ok) return null;
  const data = await response.json() as { setup_stage?: unknown; first_run?: unknown };
  const firstRun = data.first_run && typeof data.first_run === 'object' ? data.first_run as Record<string, unknown> : null;
  return {
    setupStage: typeof data.setup_stage === 'string' ? data.setup_stage : null,
    firstRun: firstRun ? {
      detectedAt: typeof firstRun.detected_at === 'number' && Number.isFinite(firstRun.detected_at) ? firstRun.detected_at : null,
      how: typeof firstRun.how === 'string' ? firstRun.how.slice(0, 2000) : null,
    } : null,
  };
}

export async function fetchWazeAlerts(harvester: Harvester, bbox: WazeBoundingBox, fetchFn: FetchFn, move = true, priority: WazePriority = 'map') {
  validateWazeBounds(bbox);
  const url = new URL(harvester.alertsUrl);
  if (move) {
    for (const [key, value] of Object.entries(bbox)) url.searchParams.set(key, String(value));
    url.searchParams.set('priority', priority);
  }
  const response = await fetchFn(url.toString(), {
    headers: { Accept: 'application/json', ...(harvester.apiKey ? { 'X-API-Key': harvester.apiKey } : {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Waze report bridge returned HTTP ${response.status}`);
  const data = await response.json() as { alerts?: unknown; coverage?: unknown; observedAt?: unknown; mock?: unknown; connected?: unknown; state?: unknown; queuePosition?: unknown };
  if (response.status === 202 && (data.state === 'queued' || data.state === 'scanning') && data.mock !== true) {
    return { alerts: [] as WazeAlert[], coverage: 'viewport' as const, observedAt: null, state: data.state, queuePosition: typeof data.queuePosition === 'number' ? data.queuePosition : null, retryAfterMs: 5000 };
  }
  if (data.mock === true || data.connected === false || !Array.isArray(data.alerts) || (data.coverage !== 'route' && data.coverage !== 'viewport') || typeof data.observedAt !== 'number' || !Number.isFinite(data.observedAt) || data.observedAt > Date.now() + 60000 || Date.now() - data.observedAt > (data.state === 'stale' ? 360000 : 120000)) {
    throw new Error('Waze report bridge returned invalid or stale data');
  }
  const alerts: WazeAlert[] = [];
  for (const value of data.alerts) {
    if (!value || typeof value !== 'object') continue;
    const a = value as Record<string, unknown>;
    if (typeof a.id !== 'string' || !a.id.trim() || typeof a.type !== 'string' || !TYPES.has(a.type) || !Array.isArray(a.point) || a.point.length !== 2 || !a.point.every(v => typeof v === 'number' && Number.isFinite(v))) continue;
    const point = a.point as [number, number];
    if (point[0] < bbox.minLng || point[0] > bbox.maxLng || point[1] < bbox.minLat || point[1] > bbox.maxLat) continue;
    const alert: WazeAlert = { id: a.id, type: a.type, point,
      reportTime: typeof a.reportTime === 'number' && Number.isFinite(a.reportTime) && a.reportTime > 0 ? a.reportTime : null };
    for (const key of ['subType', 'street', 'city', 'description'] as const) if (typeof a[key] === 'string') alert[key] = a[key];
    if (typeof a.thumbsUp === 'number' && Number.isFinite(a.thumbsUp) && a.thumbsUp >= 0) alert.thumbsUp = a.thumbsUp;
    alerts.push(alert);
  }
  return { alerts, coverage: data.coverage as 'route' | 'viewport', observedAt: data.observedAt,
    state: data.state === 'stale' ? 'stale' as const : 'fresh' as const, retryAfterMs: data.state === 'stale' ? 5000 : 30000 };
}

/** Each harvester scan pans the emulator, so overlapping map polls share one scan per grid cell and TTL. */
export const WAZE_CACHE_GRID_DEG = 0.05;
export const WAZE_CACHE_TTL_MS = 60000;

export type WazeFetchResult = Awaited<ReturnType<typeof fetchWazeAlerts>>;
export type ScanCache = Map<string, { at: number; result: WazeFetchResult }>;
export function createScanCache(): ScanCache { return new Map(); }

/** Widen a box outward to whole grid cells. The epsilon stops a box already on the grid gaining a cell to float error. */
function snapWazeBounds(bbox: WazeBoundingBox): WazeBoundingBox {
  const g = WAZE_CACHE_GRID_DEG, eps = 1e-9;
  const snap = (cells: number) => Number((cells * g).toFixed(6));
  return {
    minLng: snap(Math.floor(bbox.minLng / g + eps)),
    minLat: snap(Math.floor(bbox.minLat / g + eps)),
    maxLng: snap(Math.ceil(bbox.maxLng / g - eps)),
    maxLat: snap(Math.ceil(bbox.maxLat / g - eps)),
  };
}

/**
 * fetchWazeAlerts with a short cache per grid cell. Navigation always asks the
 * harvester and is never stored. Only fresh or stale results are stored, so a
 * queued or scanning result is asked for again on the next poll.
 */
export async function fetchWazeAlertsCached(
  harvester: Harvester,
  bbox: WazeBoundingBox,
  opts: { cache: ScanCache; fetchFn: FetchFn; now?: number; priority?: WazePriority },
): Promise<WazeFetchResult & { fromCache: boolean }> {
  validateWazeBounds(bbox);
  const { cache, fetchFn, now = Date.now(), priority = 'map' } = opts;
  // Drivers need live data, so navigation neither reads nor fills the cache. It asks for the box as given.
  if (priority === 'navigation') return { ...(await fetchWazeAlerts(harvester, bbox, fetchFn, true, priority)), fromCache: false };
  const snapped = snapWazeBounds(bbox);
  const key = `${priority}:${snapped.minLng},${snapped.minLat},${snapped.maxLng},${snapped.maxLat}`;
  const hit = cache.get(key);
  if (hit && now >= hit.at && now - hit.at < WAZE_CACHE_TTL_MS) return { ...hit.result, fromCache: true };
  for (const [k, entry] of cache) if (now < entry.at || now - entry.at >= WAZE_CACHE_TTL_MS) cache.delete(k);
  const result = await fetchWazeAlerts(harvester, snapped, fetchFn, true, priority);
  if (result.state === 'fresh' || result.state === 'stale') cache.set(key, { at: now, result });
  return { ...result, fromCache: false };
}

export const PROBE_INTERVAL_MS = 5000;
export const PROBE_MAX_AGE_MS = 60000;

/**
 * The worker's health, refreshed in the background so status requests never wait on the worker.
 * Refreshes are at most every PROBE_INTERVAL_MS, and a reading older than PROBE_MAX_AGE_MS is dropped.
 */
export class WorkerProbe {
  private worker: { at: number; health: WazeWorkerHealth | null } | null = null;
  private probing = false;

  constructor(
    private readonly probeFn: () => Promise<WazeWorkerHealth | null>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  refresh(configured: boolean): void {
    if (this.probing || !configured) return;
    if (this.worker && this.now() - this.worker.at < PROBE_INTERVAL_MS) return;
    this.probing = true;
    this.probeFn()
      .then(health => { this.worker = { at: this.now(), health }; }, () => { this.worker = { at: this.now(), health: null }; })
      .finally(() => { this.probing = false; });
  }

  current(): WazeWorkerHealth | null {
    return this.worker && this.now() - this.worker.at < PROBE_MAX_AGE_MS ? this.worker.health : null;
  }

  reset(): void { this.worker = null; }
}
