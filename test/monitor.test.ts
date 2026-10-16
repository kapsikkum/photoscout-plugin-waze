// The scheduled area monitor: area and interval parsing, opt-in, the registered task, what a run records, failures,
// deactivation and timers. Runs through the plugin's own activation against a fake host, and through AreaMonitor directly.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import plugin from '../src/server.js';
import { AreaMonitor, intervalMinutesOf, monitorSettingsOf, parseMonitorAreas, MONITOR_MAX_AREAS, MONITOR_TASK_ID } from '../src/monitor.js';
import { createScanCache, declaredHarvesterHosts, resolveHarvester, type WazeBoundingBox } from '../src/feed.js';
import { openSightings, recordPoliceSightings, SightingKeeper, SIGHTING_RETENTION_MS, PRUNE_EVERY_MS } from '../src/sightings.js';
import { activatePlugin, BOX, call, json, manifest, tempDataDir, type FetchLike } from './harness.js';

const temps: { cleanup(): void }[] = [];
after(() => temps.forEach(t => t.cleanup()));

const NOW = Date.now();
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const AREA_A = '151.10,-33.95,151.30,-33.80';
const AREA_B = '144.90,-37.85,145.05,-37.75';
const SETTINGS = { harvesterUrl: 'http://127.0.0.1:8098', harvesterKey: 'test-key' };
const BOX_A: WazeBoundingBox = { minLng: 151.1, minLat: -33.95, maxLng: 151.3, maxLat: -33.8 };
const BOX_B: WazeBoundingBox = { minLng: 144.9, minLat: -37.85, maxLng: 145.05, maxLat: -37.75 };

/** Every area's scan returns these; each area keeps only the reports inside its own box. */
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

function startPlugin(settings: Record<string, unknown>, fetchFn?: FetchLike) {
  const temp = tempDataDir();
  temps.push(temp);
  return activatePlugin({ settings, fetchFn, dataDir: temp.dataDir });
}

function rowCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM waze_police_sightings').get() as { n: number }).n;
}

const harvesterFor = () => resolveHarvester(SETTINGS.harvesterUrl, SETTINGS.harvesterKey, declaredHarvesterHosts(manifest.permissions)).harvester!;

// Parsing

test('areas parse from semicolon- or newline-separated boxes, with spaces allowed', () => {
  const parsed = parseMonitorAreas(`${AREA_A}; ${AREA_B}\n-0.2,51.4,0.1,51.6;`);
  assert.equal(parsed.areas.length, 3);
  assert.deepEqual(parsed.areas[0], BOX_A);
  assert.deepEqual(parsed.problems, []);
});

test('a bad area is reported and skipped; the good ones are still monitored', () => {
  const parsed = parseMonitorAreas(`151.3,-33.95,151.1,-33.8; 151,-33; abc,1,2,3; ${AREA_A}; 181,0,182,1; ${AREA_A}`);
  assert.deepEqual(parsed.areas, [BOX_A]);
  assert.equal(parsed.problems.length, 5, 'min above max, too few numbers, not numbers, out of range, listed twice');
  assert.match(parsed.problems[3], /needs min below max/);
  assert.match(parsed.problems[4], /listed twice/);
});

test('no more than the area limit is monitored, and the rest are reported', () => {
  const many = Array.from({ length: MONITOR_MAX_AREAS + 2 }, (_, i) => `${10 + i},0,${11 + i},1`).join(';');
  const parsed = parseMonitorAreas(many);
  assert.equal(parsed.areas.length, MONITOR_MAX_AREAS);
  assert.equal(parsed.problems.length, 2);
  assert.match(parsed.problems[0], /past the limit/);
});

test('missing or empty areas parse to nothing and report nothing', () => {
  for (const text of [undefined, null, '', ' ; \n ']) {
    assert.deepEqual(parseMonitorAreas(text), { areas: [], problems: [] });
  }
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

// Opt-in and the settings it declares

test('monitoring is opt-in: no areas by default, and the interval setting declares its default and range', () => {
  const areas = (manifest.settings ?? []).find(f => f.key === 'monitorAreas') as { type: string; default?: unknown } | undefined;
  assert.equal(areas?.type, 'string');
  assert.equal(areas?.default, undefined, 'no area is set by default');
  assert.deepEqual(monitorSettingsOf({}).areas, []);
  const interval = (manifest.settings ?? []).find(f => f.key === 'monitorIntervalMinutes') as { type: string; default?: number; min?: number; max?: number } | undefined;
  assert.equal(interval?.type, 'number');
  assert.equal(interval?.default, 5);
  assert.equal(interval?.min, 1);
  assert.equal(interval?.max, 1440);
});

test('the manifest discloses the background poll as a tasks permission', () => {
  assert.ok((manifest.permissions ?? []).some(p => p.kind === 'tasks' && /record police sightings/.test(p.detail ?? '')));
});

test('with no areas set, no task is registered and the harvester is never asked', async () => {
  const h = fakeHarvester();
  const p = await startPlugin({ ...SETTINGS, monitorAreas: '' }, h.fetchFn);
  assert.equal(p.registered.length, 0);
  assert.equal(h.requests.length, 0);
});

test('with areas set but no harvester, the task is registered and its run says the harvester is not set up', async () => {
  const p = await startPlugin({ monitorAreas: AREA_A });
  assert.equal(p.registered.length, 1);
  const result = await p.registered[0].run(() => {});
  assert.equal(result.ok, false);
  assert.match(result.message, /Set up Waze/);
});

// Scheduling

test('with areas set, one task is registered at the chosen interval; a run polls each area and records its police reports', async () => {
  const h = fakeHarvester();
  const p = await startPlugin({ ...SETTINGS, monitorAreas: `${AREA_A}; ${AREA_B}`, monitorIntervalMinutes: 10 }, h.fetchFn);
  assert.equal(p.registered.length, 1);
  assert.equal(p.registered[0].id, MONITOR_TASK_ID);
  assert.equal(p.registered[0].intervalMinutes, 10);
  const log: string[] = [];
  const result = await p.registered[0].run(line => { log.push(line); });
  assert.deepEqual(result, { ok: true, message: '2 of 2 areas polled, 2 police reports recorded' });
  assert.equal(log.length, 2, 'one line per area');
  assert.equal(h.requests.length, 2);
  assert.equal(rowCount(p.db), 2);
  const heat = await call(p.router, '/heatmap', BOX);
  assert.deepEqual(heat.json.points.map((x: { point: number[] }) => x.point), [[151.2, -33.9]], 'the heatmap now has the monitored sighting');
});

test('an interval below one minute is raised to one, and a missing one is five', async () => {
  const low = await startPlugin({ ...SETTINGS, monitorAreas: AREA_A, monitorIntervalMinutes: 0 }, fakeHarvester().fetchFn);
  assert.equal(low.registered[0].intervalMinutes, 1);
  const missing = await startPlugin({ ...SETTINGS, monitorAreas: AREA_A }, fakeHarvester().fetchFn);
  assert.equal(missing.registered[0].intervalMinutes, 5);
});

test('areas are read again on every run, so a changed area is polled at the next run', async () => {
  const h = fakeHarvester();
  const p = await startPlugin({ ...SETTINGS, monitorAreas: AREA_A }, h.fetchFn);
  p.changeSettings({ ...SETTINGS, monitorAreas: AREA_B });
  await p.registered[0].run(() => {});
  assert.equal(h.requests.length, 1);
  assert.equal(Number(h.requests[0].searchParams.get('minLng')), 144.9, 'asked for the area on the 0.05 degree grid');
  assert.equal(p.registered.length, 1, 'changing the areas does not register a second task');
});

test('a changed interval does not re-register the task; it says the new interval applies after a restart', async () => {
  const p = await startPlugin({ ...SETTINGS, monitorAreas: AREA_A, monitorIntervalMinutes: 5 }, fakeHarvester().fetchFn);
  p.changeSettings({ ...SETTINGS, monitorAreas: AREA_A, monitorIntervalMinutes: 30 });
  assert.equal(p.registered.length, 1);
  assert.equal(p.registered[0].intervalMinutes, 5, 'the registered interval is fixed');
  assert.ok(p.lines.some(l => l.level === 'info' && /keeps its 5-minute schedule until the plugin restarts; 30 minutes applies then/.test(l.msg)));
});

test('areas added after activation register the task then, with the interval set at that moment', async () => {
  const p = await startPlugin({ ...SETTINGS }, fakeHarvester().fetchFn);
  assert.equal(p.registered.length, 0);
  p.changeSettings({ ...SETTINGS, monitorAreas: AREA_A, monitorIntervalMinutes: 15 });
  assert.equal(p.registered.length, 1);
  assert.equal(p.registered[0].intervalMinutes, 15);
});

test('invalid areas are logged at activation and again on each run, and the valid ones are still polled', async () => {
  const h = fakeHarvester();
  const p = await startPlugin({ ...SETTINGS, monitorAreas: `junk; ${AREA_A}` }, h.fetchFn);
  assert.ok(p.lines.some(l => l.level === 'warn' && /Monitored areas: "junk" is not four numbers/.test(l.msg)));
  const log: string[] = [];
  const result = await p.registered[0].run(line => { log.push(line); });
  assert.equal(result.ok, true);
  assert.ok(log.some(line => /^Ignored: "junk"/.test(line)));
  assert.equal(h.requests.length, 1);
});

// The shared cache and what is kept

test('a map view and the monitor share the 60 s cache: the monitor is answered from it and records nothing twice', async () => {
  const h = fakeHarvester();
  const p = await startPlugin({ ...SETTINGS, monitorAreas: AREA_A }, h.fetchFn);
  await call(p.router, '/alerts', BOX);
  assert.equal(rowCount(p.db), 1);
  const before = h.requests.length;
  const result = await p.registered[0].run(() => {});
  assert.equal(result.ok, true);
  assert.equal(h.requests.length, before, 'the monitor asked the harvester for nothing new');
  assert.equal(rowCount(p.db), 1, 'the same police report is not counted again');
});

test('a monitor poll fills the cache, so a map view that follows is served from it', async () => {
  const h = fakeHarvester();
  const p = await startPlugin({ ...SETTINGS, monitorAreas: AREA_A }, h.fetchFn);
  await p.registered[0].run(() => {});
  const before = h.requests.length;
  const map = await call(p.router, '/alerts', BOX);
  assert.equal(map.json.fromCache, true);
  assert.equal(h.requests.length, before);
});

// Failures

test('a harvester that is down stops the run at the first area, and the message says why', async () => {
  const h = fakeHarvester({ down: true });
  const p = await startPlugin({ ...SETTINGS, monitorAreas: `${AREA_A}; ${AREA_B}` }, h.fetchFn);
  const log: string[] = [];
  const result = await p.registered[0].run(line => { log.push(line); });
  assert.equal(result.ok, false);
  assert.equal(result.message, '0 of 2 areas polled; stopped at 151.1,-33.95,151.3,-33.8: fetch failed');
  assert.equal(h.requests.length, 1, 'the second area is not asked once the first has failed');
  assert.equal(rowCount(p.db), 0);
  assert.equal(log.length, 1);
});

test('after a failing area, the next run starts with the area after it, so no area is starved', async () => {
  const h = fakeHarvester({ failIf: minLng => minLng > 150 });
  const p = await startPlugin({ ...SETTINGS, monitorAreas: `${AREA_A}; ${AREA_B}` }, h.fetchFn);
  const first = await p.registered[0].run(() => {});
  assert.equal(first.ok, false);
  assert.match(first.message, /stopped at 151\.1,-33\.95,151\.3,-33\.8: Waze report bridge returned HTTP 503/);
  const before = h.requests.length;
  h.state.failIf = () => false;
  const second = await p.registered[0].run(() => {});
  assert.equal(second.ok, true);
  assert.equal(Number(h.requests[before].searchParams.get('minLng')), 144.9, 'the next run asks area B first');
  assert.equal(rowCount(p.db), 2);
});

// Deactivation and timers

test('deactivation stops the monitor: a later run asks nothing and records nothing', async () => {
  const h = fakeHarvester();
  const p = await startPlugin({ ...SETTINGS, monitorAreas: AREA_A }, h.fetchFn);
  plugin.deactivate?.();
  const result = await p.registered[0].run(() => {});
  assert.deepEqual(result, { ok: false, message: 'The plugin has stopped' });
  assert.equal(h.requests.length, 0);
});

test('a poll still in flight when the plugin is deactivated records nothing from the answer it was waiting for', async () => {
  const h = fakeHarvester();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const p = await startPlugin({ ...SETTINGS, monitorAreas: AREA_A }, async (input, init) => {
    await gate;
    return h.fetchFn(input, init);
  });
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
  const p = await startPlugin({ ...SETTINGS, monitorAreas: AREA_A }, fakeHarvester().fetchFn);
  await p.registered[0].run(() => {});
  plugin.deactivate?.();
  assert.equal(interval.mock.callCount(), 0);
  assert.equal(timeout.mock.callCount(), 0, 'a fresh harvester answer needs no wait');
});

// AreaMonitor directly: queued waits and the time budget

test('a queued area is asked again after the harvester asks to wait, and is skipped without failing the run when it stays queued', async () => {
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
  const result = await monitor.poll([BOX_A], () => {});
  assert.deepEqual(result, { ok: true, message: '1 of 1 areas polled, 1 police reports recorded' });
  assert.deepEqual(waits, [5000, 5000], 'the harvester asked for five seconds each time');

  const stuck = new AreaMonitor({ keeper: new SightingKeeper(db), cache: createScanCache(),
    fetchFn: async () => json({ alerts: [], state: 'queued', observedAt: null, mock: false }, 202),
    harvester: () => ({ harvester: harvesterFor(), problem: null }), sleep: async () => {} });
  const lines: string[] = [];
  const skipped = await stuck.poll([BOX_B], line => { lines.push(line); });
  assert.deepEqual(skipped, { ok: true, message: '0 of 1 areas polled, 0 police reports recorded' });
  assert.match(lines[0], /still queued at the harvester after 3 asks/);
});

test('one poll never starts a new area after its time budget is spent', async () => {
  const db = new DatabaseSync(':memory:');
  openSightings(db);
  let clock = NOW;
  const fetchFn: FetchLike = async () => {
    clock += 130 * 1000;
    return json({ alerts: ALERTS, coverage: 'viewport', observedAt: Date.now(), mock: false, connected: true, state: 'fresh' });
  };
  const monitor = new AreaMonitor({ keeper: new SightingKeeper(db), cache: createScanCache(), fetchFn,
    harvester: () => ({ harvester: harvesterFor(), problem: null }), now: () => clock, sleep: async () => {} });
  const result = await monitor.poll([BOX_A, BOX_B], () => {});
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
