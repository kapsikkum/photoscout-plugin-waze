// Ported from PhotoScout server/test/wazeRoutes.test.ts and wazeHeatmapRoute.test.ts, run against the
// plugin's routes through a fake router and a fake ctx.fetch (no HTTP server, no core app).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UNDECLARED_MESSAGE } from '../src/feed.js';
import { activatePlugin, BOX, call, json, tempDataDir, type FetchLike } from './harness.js';

const temps: { cleanup(): void }[] = [];
after(() => temps.forEach(t => t.cleanup()));

const NOW = Date.now();
const SETTINGS = { harvesterUrl: 'http://127.0.0.1:8098', harvesterKey: 'test-key' };

/** A harvester the test controls: its mode, a log of every request it got, and each request's key. */
function harvester(mode: { value: 'fresh' | 'pending' | 'mock' | 'down' | 'first-run' } = { value: 'fresh' }) {
  const requests: { url: URL; key: string | null }[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/health') {
      return json(mode.value === 'first-run'
        ? { setup_stage: 'needs_first_run', first_run: { detected_at: 5, how: 'adb connect 127.0.0.1:5556' } }
        : { setup_stage: 'connecting_waze', alerts: [] });
    }
    requests.push({ url, key: new Headers(init?.headers).get('X-API-Key') });
    if (mode.value === 'down') return json({}, 503);
    if (mode.value === 'pending') return json({ alerts: [], state: 'queued', observedAt: null, mock: false }, 202);
    if (mode.value === 'mock') return json({ alerts: [], coverage: 'viewport', observedAt: Date.now(), mock: true, connected: true });
    return json({
      alerts: [
        { id: 'police-1', type: 'POLICE', subType: 'POLICE_MOBILE_CAMERA', point: [151.2, -33.9], reportTime: NOW, thumbsUp: 2 },
        { id: 'hazard-1', type: 'HAZARD', point: [151.25, -33.85], reportTime: NOW },
        { id: 'police-far', type: 'POLICE', point: [149.5, -33.4], reportTime: NOW },
      ],
      coverage: 'viewport', observedAt: Date.now(), mock: false, connected: true, state: 'fresh',
    });
  };
  return { fetchFn, requests };
}

function startPlugin(settings: Record<string, unknown> = SETTINGS, fetchFn?: FetchLike, dataDir?: string) {
  const temp = tempDataDir();
  temps.push(temp);
  return activatePlugin({ settings, fetchFn, dataDir: dataDir ?? temp.dataDir });
}

test('the alerts route records only the police reports of a fresh scan, and a cache hit records nothing', async () => {
  const h = harvester();
  const p = await startPlugin(SETTINGS, h.fetchFn);
  const first = await call(p.router, '/alerts', BOX);
  assert.equal(first.status, 200);
  assert.equal(first.json.configured, true);
  assert.equal(first.json.fromCache, false);
  assert.equal(first.json.alerts.length, 2, 'the police and hazard inside the box; the far police report is outside it');
  const again = await call(p.router, '/alerts', BOX);
  assert.equal(again.json.fromCache, true);
  assert.equal(h.requests.length, 1, 'the second poll is served from the cache');
  const ids = (p.db.prepare('SELECT id FROM waze_police_sightings').all() as { id: string }[]).map(r => r.id);
  assert.deepEqual(ids, ['police-1']);
});

test('the heatmap answers from the plugin database with weighted points, without asking the harvester', async () => {
  const h = harvester();
  const p = await startPlugin(SETTINGS, h.fetchFn);
  await call(p.router, '/alerts', BOX);
  const before = h.requests.length;
  const visitor = await call(p.router, '/heatmap', BOX);
  assert.equal(visitor.status, 200);
  assert.equal(visitor.json.configured, true);
  assert.equal(visitor.json.windowMs, 7200000);
  assert.equal(typeof visitor.json.observedAt, 'number');
  assert.equal(visitor.json.points.length, 1);
  assert.deepEqual(visitor.json.points[0].point, [151.2, -33.9]);
  // Two thumbs-up, seen just now: (1 + 2) x just under 1.
  assert.ok(visitor.json.points[0].weight > 2.99 && visitor.json.points[0].weight <= 3, `weight ${visitor.json.points[0].weight}`);
  assert.equal(h.requests.length, before, 'the heatmap never asks the harvester');
});

test('the heatmap window is clamped to one hour to seven days, and defaults to two hours', async () => {
  const p = await startPlugin();
  const windowOf = async (extra: string) => (await call(p.router, '/heatmap', { ...BOX, ...parseExtra(extra) })).json.windowMs;
  assert.equal(await windowOf('&windowMs=1'), 3600000);
  assert.equal(await windowOf('&windowMs=86400000'), 86400000);
  assert.equal(await windowOf('&windowMs=99999999999'), 604800000);
  assert.equal(await windowOf('&windowMs=abc'), 7200000);
  assert.equal(await windowOf('&windowMs='), 7200000);
  assert.equal(await windowOf(''), 7200000);
});

function parseExtra(extra: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(extra.replace(/^&/, '')));
}

test('the heatmap and alerts reject a missing or invalid box with 400', async () => {
  const p = await startPlugin();
  assert.equal((await call(p.router, '/heatmap', { minLng: '151' })).status, 400);
  assert.equal((await call(p.router, '/heatmap', { minLng: '151.3', minLat: '-33.95', maxLng: '151.1', maxLat: '-33.8' })).status, 400);
  assert.equal((await call(p.router, '/heatmap', { minLng: '151.1', minLat: '-33.95', maxLng: '181', maxLat: '-33.8' })).status, 400);
  assert.equal((await call(p.router, '/alerts', {})).status, 400);
  assert.notEqual((await call(p.router, '/alerts', { minLng: '151', minLat: '-34', maxLng: '152', maxLat: '-33' })).status, 400, 'a complete valid box passes validation');
});

test('pending scans are returned as queued, record nothing, and are asked for again', async () => {
  const mode = { value: 'pending' as const };
  const h = harvester(mode);
  const p = await startPlugin(SETTINGS, h.fetchFn);
  const queued = await call(p.router, '/alerts', BOX);
  assert.equal(queued.status, 200);
  assert.equal(queued.json.state, 'queued');
  assert.equal(queued.json.observedAt, null);
  await call(p.router, '/alerts', BOX);
  assert.equal(h.requests.length, 2, 'a queued result is not cached');
  assert.equal((p.db.prepare('SELECT COUNT(*) AS n FROM waze_police_sightings').get() as { n: number }).n, 0);
});

test('a visitor asking for navigation priority is served as a map poll; a signed-in member gets navigation', async () => {
  const h = harvester();
  const p = await startPlugin(SETTINGS, h.fetchFn);
  await call(p.router, '/alerts', { ...BOX, priority: 'navigation' });
  assert.equal(h.requests.at(-1)!.url.searchParams.get('priority'), 'map');
  await call(p.router, '/alerts', { ...BOX, priority: 'navigation' }, { role: 'member' });
  assert.equal(h.requests.at(-1)!.url.searchParams.get('priority'), 'navigation');
});

test('a bridge that is down, or returns mock data, answers 503 and records nothing', async () => {
  const mode = { value: 'down' as 'down' | 'mock' };
  const h = harvester(mode);
  const p = await startPlugin(SETTINGS, h.fetchFn);
  const down = await call(p.router, '/alerts', BOX);
  assert.equal(down.status, 503);
  assert.equal(down.json.configured, false);
  assert.match(down.json.error, /HTTP 503/);
  mode.value = 'mock';
  const mocked = await call(p.router, '/alerts', BOX);
  assert.equal(mocked.status, 503);
  assert.equal((p.db.prepare('SELECT COUNT(*) AS n FROM waze_police_sightings').get() as { n: number }).n, 0);
});

test('nothing configured: alerts say so, and the status check moves nothing', async () => {
  const h = harvester();
  const p = await startPlugin({}, h.fetchFn);
  const alerts = await call(p.router, '/alerts', BOX);
  assert.equal(alerts.status, 503);
  assert.match(alerts.json.error, /Set up Waze/);
  assert.equal(h.requests.length, 0);
  const status = await call(p.router, '/status', { check: '1' });
  assert.equal(status.json.configured, false);
  assert.equal(status.json.liveMapStatus.status, null);
  assert.equal(status.json.liveMapStatus.message.startsWith('Set up Waze'), true);
});

test('an address the manifest does not declare is refused before any request, so the key is never sent to it', async () => {
  const h = harvester();
  const p = await startPlugin({ harvesterUrl: 'https://example.com', harvesterKey: 'test-key' }, h.fetchFn);
  const alerts = await call(p.router, '/alerts', BOX);
  assert.equal(alerts.status, 503);
  assert.equal(alerts.json.error, UNDECLARED_MESSAGE);
  assert.equal(h.requests.length, 0, 'no request left the plugin');
});

test('the status route reports unchecked by default, and a checked status reads without bounds', async () => {
  const h = harvester();
  const p = await startPlugin(SETTINGS, h.fetchFn);
  const unchecked = await call(p.router, '/status');
  assert.equal(unchecked.json.checked, false);
  assert.equal(unchecked.json.liveMapStatus.status, null);
  assert.equal(h.requests.length, 0);
  const checked = await call(p.router, '/status', { check: '1' });
  assert.equal(checked.json.canDisplayOnMap, true);
  assert.equal(checked.json.liveMapStatus.status, 200);
  assert.equal(h.requests.at(-1)!.url.search, '', 'checking status must not move the emulator');
  assert.equal(h.requests.at(-1)!.key, 'test-key');
});

test('instructions for the first-run screen reach the status of an admin only', async () => {
  const h = harvester({ value: 'first-run' });
  const p = await startPlugin(SETTINGS, h.fetchFn);
  await call(p.router, '/status'); // starts the background probe
  await new Promise(r => setTimeout(r, 20));
  const visitor = await call(p.router, '/status');
  assert.equal(visitor.json.setup.state, 'needs_first_run');
  assert.equal(JSON.stringify(visitor.json).includes('adb connect'), false);
  const admin = await call(p.router, '/status', {}, { role: 'admin' });
  assert.match(admin.json.setup.first_run.how, /adb connect/);
});

test('changing the settings clears the scan cache, so the new harvester is asked', async () => {
  const h = harvester();
  const p = await startPlugin(SETTINGS, h.fetchFn);
  await call(p.router, '/alerts', BOX);
  await call(p.router, '/alerts', BOX);
  assert.equal(h.requests.length, 1);
  p.changeSettings({ ...SETTINGS, harvesterKey: 'rotated-key' });
  await call(p.router, '/alerts', BOX);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests.at(-1)!.key, 'rotated-key');
});

test('with no address in the settings, the core app runtime file supplies the address and key', async () => {
  const temp = tempDataDir();
  temps.push(temp);
  fs.mkdirSync(temp.wazeDir, { recursive: true });
  fs.writeFileSync(path.join(temp.wazeDir, 'runtime.json'), JSON.stringify({ url: 'http://127.0.0.1:8098/alerts', key: 'migrated-key' }));
  const h = harvester();
  const p = await startPlugin({}, h.fetchFn, temp.dataDir);
  const alerts = await call(p.router, '/alerts', BOX);
  assert.equal(alerts.status, 200);
  assert.equal(h.requests[0].key, 'migrated-key');
  assert.equal(h.requests[0].url.pathname, '/alerts');
});
