// The scheduled area monitor: the checkbox, the Areas it reads from the host, the Area-to-box conversion and skips,
// the registered task, what a run records, failures, deactivation and timers. Runs through the plugin's own activation
// against a fake host (whose ctx.areas() the test sets), and through AreaMonitor directly.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { PluginArea } from '../src/sdk/server-api.js';
import plugin from '../src/server.js';
import { areaBox, AreaMonitor, intervalMinutesOf, monitorOn, monitorTargets, MONITOR_MAX_AREAS, MONITOR_TASK_ID } from '../src/monitor.js';
import { createScanCache, declaredHarvesterHosts, resolveHarvester } from '../src/feed.js';
import { openSightings, recordPoliceSightings, SightingKeeper, SIGHTING_RETENTION_MS, PRUNE_EVERY_MS } from '../src/sightings.js';
import { activatePlugin, BOX, call, json, manifest, tempDataDir, type FetchLike } from './harness.js';

const temps: { cleanup(): void }[] = [];
after(() => temps.forEach(t => t.cleanup()));

const NOW = Date.now();
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const SETTINGS = { harvesterUrl: 'http://127.0.0.1:8098', harvesterKey: 'test-key' };
const ON = { ...SETTINGS, monitorMyAreas: true };

// Two Areas, each a 10 km circle round one of the police reports below. Home is the one the app lists first.
const HOME: PluginArea = { name: 'Home', lat: -33.9, lng: 151.2, radiusKm: 10 };
const COAST: PluginArea = { name: 'Coast', lat: -37.8, lng: 144.95, radiusKm: 10 };
const HOME_BOX = areaBox(HOME);
/** The map's query for the same box as the monitor's, so both reach the same 60 s cache entry. */
const HOME_QUERY = { minLng: String(HOME_BOX.minLng), minLat: String(HOME_BOX.minLat), maxLng: String(HOME_BOX.maxLng), maxLat: String(HOME_BOX.maxLat) };
const COAST_BOX = areaBox(COAST);

/** Every scan returns these; each Area keeps only the reports inside its own box. */
const ALERTS = [
  { id: 'police-a', type: 'POLICE', point: [151.2, -33.9], reportTime: NOW },
  { id: 'police-b', type: 'POLICE', point: [144.95, -37.8], reportTime: NOW },
  { id: 'hazard-a', type: 'HAZARD', point: [151.25, -33.85], reportTime: NOW },
];

/** A harvester the test controls: down, failing for some areas, or answering "queued" a number of times first. */
function fakeHarvester(start: { down?: boolean; failIf?: (minLng: number) => boolean; queued?: number } = {}) {
  const state = { down: start.down ?? false, failIf: start.failIf ?? (() => false), queued: start.queued ?? 0 };
  const requests: URL[] = [];
  const fetchFn: FetchLike = async (input) => {
    const url = new URL(input);
    if (url.pathname === '/health') return json({ setup_stage: 'connecting_waze', alerts: [] });
    requests.push(url);
    if (state.down) throw new TypeError('fetch failed');
    if (state.failIf(Number(url.searchParams.get('minLng')))) return json({}, 503);
    if (state.queued > 0) {
      state.queued -= 1;
      return json({ alerts: [], state: 'queued', observedAt: null, mock: false }, 202);
    }
    return json({ alerts: ALERTS, coverage: 'viewport', observedAt: Date.now(), mock: false, connected: true, state: 'fresh' });
  };
  return { fetchFn, requests, state };
}

function startPlugin(settings: Record<string, unknown>, fetchFn?: FetchLike, areas: PluginArea[] = [HOME]) {
  const temp = tempDataDir();
  temps.push(temp);
  return activatePlugin({ settings, fetchFn, areas, dataDir: temp.dataDir });
}

function rowCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM waze_police_sightings').get() as { n: number }).n;
}

const harvesterFor = () => resolveHarvester(SETTINGS.harvesterUrl, SETTINGS.harvesterKey, declaredHarvesterHosts(manifest.permissions)).harvester!;

// The checkbox and the settings it declares

test('monitoring is a checkbox that is off by default: only the boolean true turns it on', () => {
  const box = (manifest.settings ?? []).find(f => f.key === 'monitorMyAreas') as { type: string; default?: unknown } | undefined;
  assert.equal(box?.type, 'boolean');
  assert.equal(box?.default, false);
  assert.equal(monitorOn({}), false);
  assert.equal(monitorOn({ monitorMyAreas: 'true' }), false, 'a string is not the checkbox');
  assert.equal(monitorOn({ monitorMyAreas: false }), false);
  assert.equal(monitorOn({ monitorMyAreas: true }), true);
});

test('the text list of boxes is gone, and the interval declares its default and range', () => {
  assert.equal((manifest.settings ?? []).some(f => f.key === 'monitorAreas'), false);
  const interval = (manifest.settings ?? []).find(f => f.key === 'monitorIntervalMinutes') as { type: string; default?: number; min?: number; max?: number } | undefined;
  assert.equal(interval?.type, 'number');
  assert.equal(interval?.default, 5);
  assert.equal(interval?.min, 1);
  assert.equal(interval?.max, 1440);
});

test('the plugin needs PhotoScout 1.2, the host version that gives it ctx.areas()', () => {
  assert.equal(manifest.photoscout, '^1.2');
});

test('the manifest discloses the background poll as a tasks permission', () => {
  assert.ok((manifest.permissions ?? []).some(p => p.kind === 'tasks' && /record police sightings/.test(p.detail ?? '')));
});

test('the interval is at least one minute and at most a day, and a missing or unreadable one is five minutes', () => {
  assert.equal(intervalMinutesOf(undefined), 5);
  assert.equal(intervalMinutesOf(''), 5);
  assert.equal(intervalMinutesOf('soon'), 5);
  assert.equal(intervalMinutesOf(0), 1, 'below the floor is raised to one minute');
  assert.equal(intervalMinutesOf(0.4), 1);
  assert.equal(intervalMinutesOf(-3), 1);
  assert.equal(intervalMinutesOf(2.6), 3, 'a fraction of a minute rounds to whole minutes');
  assert.equal(intervalMinutesOf('10'), 10);
  assert.equal(intervalMinutesOf(5000), 1440);
});

// Area to box: the conversion and what is skipped

test('an Area becomes a box about its centre, its radius each way in kilometres', () => {
  assert.deepEqual(areaBox({ name: 'Equator', lat: 0, lng: 0, radiusKm: 111.32 }), { minLng: -1, minLat: -1, maxLng: 1, maxLat: 1 });
  // At 60 degrees a degree of longitude is half as long, so the box reaches twice as far east and west.
  const high = areaBox({ name: 'High', lat: 60, lng: 10, radiusKm: 111.32 });
  assert.equal(high.minLat, 59);
  assert.equal(high.maxLat, 61);
  assert.ok(Math.abs(high.maxLng - 12) < 1e-9 && Math.abs(high.minLng - 8) < 1e-9, JSON.stringify(high));
});

test('near a pole the box spans every longitude, and a box past the world edge is trimmed to it', () => {
  const pole = areaBox({ name: 'Pole', lat: 90, lng: 0, radiusKm: 50 });
  assert.equal(pole.minLng, -180);
  assert.equal(pole.maxLng, 180);
  assert.equal(pole.maxLat, 90, 'trimmed to the north pole');
  assert.ok(Math.abs(pole.minLat - (90 - 50 / 111.32)) < 1e-9);
  const dateline = areaBox({ name: 'Dateline', lat: 0, lng: 179.99, radiusKm: 50 });
  assert.equal(dateline.maxLng, 180);
  assert.ok(dateline.minLng < 179.99);
});

test('an Area that cannot be scanned is skipped with the reason, and the others are still kept', () => {
  const areas: PluginArea[] = [
    { name: 'Zero', lat: -33.9, lng: 151.2, radiusKm: 0 },
    { name: '', lat: 200, lng: 0, radiusKm: 5 },
    { name: 'Nan', lat: 0, lng: 0, radiusKm: Number.NaN },
    HOME,
  ];
  const { targets, problems } = monitorTargets(areas);
  assert.deepEqual(targets.map(t => t.label), ['Home']);
  assert.deepEqual(problems, [
    'Zero: its radius is not above zero. It is not scanned.',
    'area 2: its centre is not a valid latitude and longitude. It is not scanned.',
    'Nan: its radius is not above zero. It is not scanned.',
  ]);
});

test('a box the world cannot hold at that latitude is skipped, as validateWazeBounds rejects it', () => {
  // A radius so small that the box has no height left at 60 degrees: min latitude equals max latitude.
  const { targets, problems } = monitorTargets([{ name: 'Pin', lat: 60, lng: 10, radiusKm: 1e-300 }]);
  assert.deepEqual(targets, []);
  assert.deepEqual(problems, ['Pin: the box it makes is too small to scan at this latitude. It is not scanned.']);
});

test('a large Area, within the 1000 km the app allows, is kept whole: nothing rejects it for its span', () => {
  const { targets, problems } = monitorTargets([{ name: 'Wide', lat: -33.9, lng: 151.2, radiusKm: 1000 }]);
  assert.equal(targets.length, 1);
  assert.deepEqual(problems, []);
  assert.ok(Math.abs((targets[0].box.maxLat - targets[0].box.minLat) - 2000 / 111.32) < 1e-9);
});

test('two Areas with the same box are scanned once, and the second is reported', () => {
  const { targets, problems } = monitorTargets([HOME, { ...HOME, name: 'Home again' }]);
  assert.deepEqual(targets.map(t => t.label), ['Home']);
  assert.deepEqual(problems, ['Home again has the same box as Home. It is not scanned.']);
});

test('no more than the area limit is scanned, home first, and the rest are reported', () => {
  const many: PluginArea[] = Array.from({ length: MONITOR_MAX_AREAS + 2 }, (_, i) => ({ name: `Area ${i + 1}`, lat: -30 - i, lng: 150, radiusKm: 5 }));
  const { targets, problems } = monitorTargets(many);
  assert.equal(targets.length, MONITOR_MAX_AREAS);
  assert.equal(targets[0].label, 'Area 1');
  assert.equal(targets[MONITOR_MAX_AREAS - 1].label, `Area ${MONITOR_MAX_AREAS}`);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^Area 11 is past the limit of 10 areas/);
});

test('no Areas gives nothing to scan and nothing to report', () => {
  assert.deepEqual(monitorTargets([]), { targets: [], problems: [] });
});

// Scheduling: the checkbox registers the task, and each run reads the Areas

test('with the checkbox off, no task is registered, the Areas are not read and the harvester is never asked', async () => {
  const h = fakeHarvester();
  const p = await startPlugin({ ...SETTINGS, monitorMyAreas: false }, h.fetchFn, [HOME, COAST]);
  assert.equal(p.registered.length, 0);
  assert.equal(p.areaReads(), 0);
  assert.equal(h.requests.length, 0);
});

test('with the checkbox on but no harvester, the task is registered and its run says the harvester is not set up', async () => {
  const p = await startPlugin({ monitorMyAreas: true });
  assert.equal(p.registered.length, 1);
  const result = await p.registered[0].run(() => {});
  assert.equal(result.ok, false);
  assert.match(result.message, /Set up Waze/);
});

test('with the checkbox on, one task is registered at the chosen interval, and a run scans each configured Area and records its police reports', async () => {
  const h = fakeHarvester();
  const p = await startPlugin({ ...ON, monitorIntervalMinutes: 10 }, h.fetchFn, [HOME, COAST]);
  assert.equal(p.registered.length, 1);
  assert.equal(p.registered[0].id, MONITOR_TASK_ID);
  assert.equal(p.registered[0].intervalMinutes, 10);
  const log: string[] = [];
  const result = await p.registered[0].run(line => { log.push(line); });
  assert.deepEqual(result, { ok: true, message: '2 of 2 areas polled, 2 police reports recorded' });
  assert.deepEqual(log, ['Home: 2 reports, 1 police recorded', 'Coast: 1 reports, 1 police recorded']);
  assert.equal(h.requests.length, 2);
  assert.equal(rowCount(p.db), 2);
  const heat = await call(p.router, '/heatmap', BOX);
  assert.deepEqual(heat.json.points.map((x: { point: number[] }) => x.point), [[151.2, -33.9]], 'the heatmap now has the monitored sighting');
});

test('an interval below one minute is raised to one, and a missing one is five', async () => {
  const low = await startPlugin({ ...ON, monitorIntervalMinutes: 0 }, fakeHarvester().fetchFn);
  assert.equal(low.registered[0].intervalMinutes, 1);
  const missing = await startPlugin(ON, fakeHarvester().fetchFn);
  assert.equal(missing.registered[0].intervalMinutes, 5);
});

test('the Areas are read on every run, so a changed Area list is polled at the next run', async () => {
  const h = fakeHarvester();
  const p = await startPlugin(ON, h.fetchFn, [HOME]);
  p.setAreas([COAST]);
  const result = await p.registered[0].run(() => {});
  assert.equal(result.ok, true);
  assert.equal(h.requests.length, 1);
  assert.equal(Number(h.requests[0].searchParams.get('minLng')), 144.8, 'asked for the Coast box, on the 0.05 degree grid');
  assert.equal(p.areaReads(), 1);
  await p.registered[0].run(() => {});
  assert.equal(p.areaReads(), 2, 'the Areas are read again on the next run');
  assert.equal(p.registered.length, 1, 'changing the Areas does not register a second task');
});

test('turning the checkbox off makes a run return at once; turning it back on resumes the polls', async () => {
  const h = fakeHarvester();
  const p = await startPlugin(ON, h.fetchFn, [HOME]);
  p.changeSettings({ ...SETTINGS, monitorMyAreas: false });
  const reads = p.areaReads();
  const off = await p.registered[0].run(() => {});
  assert.deepEqual(off, { ok: true, message: 'Skipped: monitoring is off' });
  assert.equal(p.areaReads(), reads, 'no Areas are read while it is off');
  assert.equal(h.requests.length, 0);
  assert.equal(rowCount(p.db), 0);
  assert.equal(p.registered.length, 1, 'the task stays registered; only its run is a no-op');

  p.changeSettings(ON);
  await p.registered[0].run(() => {});
  assert.equal(h.requests.length, 1, 'it polls again once the checkbox is back on');
  assert.equal(p.registered.length, 1, 'turning it back on does not register again');
});

test('ticking the checkbox after activation registers the task then, at the interval set at that moment', async () => {
  const p = await startPlugin({ ...SETTINGS, monitorMyAreas: false }, fakeHarvester().fetchFn);
  assert.equal(p.registered.length, 0);
  p.changeSettings({ ...SETTINGS, monitorMyAreas: true, monitorIntervalMinutes: 15 });
  assert.equal(p.registered.length, 1);
  assert.equal(p.registered[0].intervalMinutes, 15);
});

test('a changed interval does not re-register the task; it says the new interval applies after a restart', async () => {
  const p = await startPlugin({ ...ON, monitorIntervalMinutes: 5 }, fakeHarvester().fetchFn);
  p.changeSettings({ ...ON, monitorIntervalMinutes: 30 });
  assert.equal(p.registered.length, 1);
  assert.equal(p.registered[0].intervalMinutes, 5, 'the registered interval is fixed');
  assert.ok(p.lines.some(l => l.level === 'info' && /keeps its 5-minute schedule until the plugin restarts; 30 minutes applies then/.test(l.msg)));
});

test('no Areas, or an Area list that cannot be read, is a run that does nothing: not an error, and no harvester request', async () => {
  const h = fakeHarvester();
  const p = await startPlugin(ON, h.fetchFn, []);
  const result = await p.registered[0].run(() => {});
  assert.deepEqual(result, { ok: true, message: 'Skipped: no areas to scan' });
  assert.equal(h.requests.length, 0);
  assert.equal(rowCount(p.db), 0);
  assert.equal(p.areaReads(), 1);
});

test('an Area that cannot be scanned is logged on each run, and the others are still polled', async () => {
  const h = fakeHarvester();
  const zero: PluginArea = { name: 'Zero', lat: -33.9, lng: 151.2, radiusKm: 0 };
  const p = await startPlugin(ON, h.fetchFn, [zero, HOME]);
  const log: string[] = [];
  const result = await p.registered[0].run(line => { log.push(line); });
  assert.deepEqual(result, { ok: true, message: '1 of 1 areas polled, 1 police reports recorded' });
  assert.equal(log[0], 'Zero: its radius is not above zero. It is not scanned.');
  assert.equal(h.requests.length, 1);
});

// The shared cache and what is kept

test('a map view and the monitor share the 60 s cache: the monitor is answered from it and records nothing twice', async () => {
  const h = fakeHarvester();
  const p = await startPlugin(ON, h.fetchFn, [HOME]);
  await call(p.router, '/alerts', HOME_QUERY);
  assert.equal(rowCount(p.db), 1);
  const before = h.requests.length;
  const result = await p.registered[0].run(() => {});
  assert.equal(result.ok, true);
  assert.equal(h.requests.length, before, 'the monitor asked the harvester for nothing new');
  assert.equal(rowCount(p.db), 1, 'the same police report is not counted again');
});

test('a monitor poll fills the cache, so a map view that follows is served from it', async () => {
  const h = fakeHarvester();
  const p = await startPlugin(ON, h.fetchFn, [HOME]);
  await p.registered[0].run(() => {});
  const before = h.requests.length;
  const map = await call(p.router, '/alerts', HOME_QUERY);
  assert.equal(map.json.fromCache, true);
  assert.equal(h.requests.length, before);
});

// Failures

test('a harvester that is down stops the run at the first Area, and the message names it', async () => {
  const h = fakeHarvester({ down: true });
  const p = await startPlugin(ON, h.fetchFn, [HOME, COAST]);
  const log: string[] = [];
  const result = await p.registered[0].run(line => { log.push(line); });
  assert.equal(result.ok, false);
  assert.equal(result.message, '0 of 2 areas polled; stopped at Home: fetch failed');
  assert.equal(h.requests.length, 1, 'the second Area is not asked once the first has failed');
  assert.equal(rowCount(p.db), 0);
  assert.equal(log.length, 1);
});

test('after a failing Area, the next run starts with the Area after it, so no Area is starved', async () => {
  const h = fakeHarvester({ failIf: minLng => minLng > 150 });
  const p = await startPlugin(ON, h.fetchFn, [HOME, COAST]);
  const first = await p.registered[0].run(() => {});
  assert.equal(first.ok, false);
  assert.match(first.message, /stopped at Home: Waze report bridge returned HTTP 503/);
  const before = h.requests.length;
  h.state.failIf = () => false;
  const second = await p.registered[0].run(() => {});
  assert.equal(second.ok, true);
  assert.equal(Number(h.requests[before].searchParams.get('minLng')), 144.8, 'the next run asks Coast first');
  assert.equal(rowCount(p.db), 2);
});

// Deactivation and timers

test('deactivation stops the monitor: a later run asks nothing and records nothing', async () => {
  const h = fakeHarvester();
  const p = await startPlugin(ON, h.fetchFn, [HOME]);
  plugin.deactivate?.();
  const result = await p.registered[0].run(() => {});
  assert.deepEqual(result, { ok: false, message: 'The plugin has stopped' });
  assert.equal(h.requests.length, 0);
});

test('a poll still in flight when the plugin is deactivated records nothing from the answer it was waiting for', async () => {
  const h = fakeHarvester();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const p = await startPlugin(ON, async (input, init) => {
    await gate;
    return h.fetchFn(input, init);
  }, [HOME]);
  const running = p.registered[0].run(() => {});
  await new Promise(resolve => setImmediate(resolve));
  plugin.deactivate?.();
  release();
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.message, 'The plugin stopped during the poll');
  assert.equal(rowCount(p.db), 0, 'the answer that arrived after deactivation is not recorded');
});

test('the monitor starts no timers of its own: the host runs the schedule', async (t) => {
  const interval = t.mock.method(globalThis, 'setInterval');
  const timeout = t.mock.method(globalThis, 'setTimeout');
  const p = await startPlugin(ON, fakeHarvester().fetchFn, [HOME]);
  await p.registered[0].run(() => {});
  plugin.deactivate?.();
  assert.equal(interval.mock.callCount(), 0);
  assert.equal(timeout.mock.callCount(), 0, 'a fresh harvester answer needs no wait');
});

// AreaMonitor directly: queued waits and the time budget

test('a queued Area is asked again after the harvester asks to wait, and is skipped without failing the run when it stays queued', async () => {
  const db = new DatabaseSync(':memory:');
  openSightings(db);
  const waits: number[] = [];
  let queued = 2;
  const fetchFn: FetchLike = async () => {
    if (queued > 0) { queued -= 1; return json({ alerts: [], state: 'queued', observedAt: null, mock: false }, 202); }
    return json({ alerts: ALERTS, coverage: 'viewport', observedAt: Date.now(), mock: false, connected: true, state: 'fresh' });
  };
  const monitor = new AreaMonitor({ keeper: new SightingKeeper(db), cache: createScanCache(), fetchFn,
    harvester: () => ({ harvester: harvesterFor(), problem: null }), sleep: async ms => { waits.push(ms); } });
  const result = await monitor.poll([{ label: 'Home', box: HOME_BOX }], () => {});
  assert.deepEqual(result, { ok: true, message: '1 of 1 areas polled, 1 police reports recorded' });
  assert.deepEqual(waits, [5000, 5000], 'the harvester asked for five seconds each time');

  const stuck = new AreaMonitor({ keeper: new SightingKeeper(db), cache: createScanCache(),
    fetchFn: async () => json({ alerts: [], state: 'queued', observedAt: null, mock: false }, 202),
    harvester: () => ({ harvester: harvesterFor(), problem: null }), sleep: async () => {} });
  const lines: string[] = [];
  const skipped = await stuck.poll([{ label: 'Coast', box: COAST_BOX }], line => { lines.push(line); });
  assert.deepEqual(skipped, { ok: true, message: '0 of 1 areas polled, 0 police reports recorded' });
  assert.match(lines[0], /^Coast: still queued at the harvester after 3 asks/);
});

test('one poll never starts a new Area after its time budget is spent', async () => {
  const db = new DatabaseSync(':memory:');
  openSightings(db);
  let clock = NOW;
  const fetchFn: FetchLike = async () => {
    clock += 130 * 1000;
    return json({ alerts: ALERTS, coverage: 'viewport', observedAt: Date.now(), mock: false, connected: true, state: 'fresh' });
  };
  const monitor = new AreaMonitor({ keeper: new SightingKeeper(db), cache: createScanCache(), fetchFn,
    harvester: () => ({ harvester: harvesterFor(), problem: null }), now: () => clock, sleep: async () => {} });
  const result = await monitor.poll([{ label: 'Home', box: HOME_BOX }, { label: 'Coast', box: COAST_BOX }], () => {});
  assert.deepEqual(result, { ok: true, message: '1 of 2 areas polled; the rest wait for the next poll' });
  assert.equal(rowCount(db), 1);
});

// The keeper, which the alerts route and the monitor share

test('the keeper records only fresh or stale police reports, and prunes at most once a minute', () => {
  const db = new DatabaseSync(':memory:');
  openSightings(db);
  const keeper = new SightingKeeper(db);
  const police = { alerts: [{ id: 'p1', type: 'POLICE', point: [151.2, -33.9] as [number, number] }], state: 'fresh' };
  assert.equal(keeper.keep(police, true, NOW), 0, 'a cache hit is not recorded again');
  assert.equal(keeper.keep({ ...police, state: 'queued' }, false, NOW), 0, 'a queued answer carries no reports');
  assert.equal(keeper.keep(police, false, NOW), 1);
  assert.equal(keeper.keep({ ...police, state: 'stale', alerts: [{ id: 'p2', type: 'POLICE', point: [151.2, -33.9] }] }, false, NOW + 1000), 1);

  recordPoliceSightings(db, [{ id: 'old', point: [151.2, -33.9] }], NOW - SIGHTING_RETENTION_MS - DAY);
  keeper.keep({ alerts: [], state: 'fresh' }, false, NOW + 2 * PRUNE_EVERY_MS);
  assert.equal(rowCount(db), 2, 'the row older than the retention is gone');

  recordPoliceSightings(db, [{ id: 'old2', point: [151.2, -33.9] }], NOW - SIGHTING_RETENTION_MS - DAY);
  keeper.keep(police, false, NOW + 2 * PRUNE_EVERY_MS + MINUTE / 2);
  assert.equal(rowCount(db), 3, 'a second prune within the minute is skipped');
  keeper.keep(police, false, NOW + 2 * PRUNE_EVERY_MS + MINUTE + 1);
  assert.equal(rowCount(db), 2, 'the next prune after a minute removes it');
});
