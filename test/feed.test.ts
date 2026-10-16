// Ported from PhotoScout server/test/waze.test.ts and wazeCache.test.ts, plus the harvester-address rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAD_ADDRESS_MESSAGE, createScanCache, declaredHarvesterHosts, fetchWazeAlerts, fetchWazeAlertsCached, fetchWazeWorkerHealth,
  resolveHarvester, SETUP_MESSAGE, UNDECLARED_MESSAGE, validateWazeBounds, WAZE_CACHE_TTL_MS, WorkerProbe,
  type Harvester, type WazeBoundingBox,
} from '../src/feed.js';
import { manifest } from './harness.js';

const DECLARED = declaredHarvesterHosts(manifest.permissions);
const bbox: WazeBoundingBox = { minLng: 151.1, minLat: -33.95, maxLng: 151.3, maxLat: -33.8 };

function harvesterAt(address = 'http://127.0.0.1:8098', key = 'test-key'): Harvester {
  const r = resolveHarvester(address, key, DECLARED);
  assert.ok(r.harvester, `expected ${address} to resolve: ${r.problem}`);
  return r.harvester;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fresh = (alerts: unknown[] = []) => ({ alerts, coverage: 'viewport', observedAt: Date.now(), mock: false, connected: true });

/** A harvester that answers with `reply(callNumber)` and records every URL and key it was asked with. */
function harvester(reply: (call: number) => Response = () => json({ ...fresh(), state: 'fresh' })) {
  const urls: URL[] = [];
  const keys: (string | null)[] = [];
  const fetchFn = async (input: string, init?: RequestInit) => {
    urls.push(new URL(input));
    keys.push(new Headers(init?.headers).get('X-API-Key'));
    return reply(urls.length);
  };
  return { fetchFn, urls, keys };
}

test('report bounds reject missing, reversed and non-geographic coordinates', () => {
  for (const invalid of [{ ...bbox, minLng: NaN }, { ...bbox, maxLat: 91 }, { ...bbox, minLat: bbox.maxLat }, { ...bbox, minLng: -181 }]) {
    assert.throws(() => validateWazeBounds(invalid));
  }
  assert.doesNotThrow(() => validateWazeBounds(bbox));
});

test('map requests carry bounds and priority, and the key; status checks carry no bounds', async () => {
  const h = harvesterAt();
  const { fetchFn, urls, keys } = harvester();
  await fetchWazeAlerts(h, bbox, fetchFn, true, 'navigation');
  await fetchWazeAlerts(h, bbox, fetchFn, false);
  assert.equal(urls[0].searchParams.get('priority'), 'navigation');
  assert.equal(urls[0].searchParams.get('minLng'), '151.1');
  assert.equal(urls[1].search, '');
  assert.deepEqual(keys, ['test-key', 'test-key']);
  assert.equal(urls[0].pathname, '/alerts');
});

test('a harvester with no key is asked without one, and the harvester decides', async () => {
  const h = harvesterAt('http://127.0.0.1:8098', '');
  const { fetchFn, keys } = harvester();
  await fetchWazeAlerts(h, bbox, fetchFn);
  assert.deepEqual(keys, [null]);
});

test('pending scans have no observation time and cannot masquerade as a fresh empty feed', async () => {
  const response = async () => json({ alerts: [], state: 'queued', observedAt: null, mock: false }, 202);
  const result = await fetchWazeAlerts(harvesterAt(), bbox, response);
  assert.equal(result.state, 'queued');
  assert.equal(result.observedAt, null);
  assert.equal(result.retryAfterMs, 5000);
});

test('mock, disconnected, stale, invalid and failed harvester responses remain failures', async () => {
  const h = harvesterAt();
  for (const body of [{ ...fresh(), mock: true }, { ...fresh(), connected: false }, { ...fresh(), observedAt: Date.now() - 200000 }, { ...fresh(), observedAt: null }, { ...fresh(), coverage: 'world' }]) {
    await assert.rejects(fetchWazeAlerts(h, bbox, async () => json(body)));
  }
  await assert.rejects(fetchWazeAlerts(h, bbox, async () => json({}, 503)), /HTTP 503/);
  await assert.rejects(fetchWazeAlerts(h, bbox, async () => json({}, 429)), /HTTP 429/);
});

test('area filtering and the report field allowlist keep other locations and private metadata out', async () => {
  const h = harvesterAt();
  const result = await fetchWazeAlerts(h, bbox, async () => json(fresh([
    { id: 'police', type: 'POLICE', point: [151.2, -33.9], subType: 'POLICE_MOBILE_CAMERA', street: 'Example', reporter: 'private', sessionToken: 'private', reportTime: null },
    { id: 'other-area', type: 'POLICE', point: [149.56, -33.42] },
    { id: 'bad', type: 'POLICE', point: ['151.2', -33.9] },
    { id: 'unknown', type: 'NEW_EVENT', point: [151.2, -33.9] },
  ])));
  assert.deepEqual(result.alerts, [{ id: 'police', type: 'POLICE', point: [151.2, -33.9], subType: 'POLICE_MOBILE_CAMERA', street: 'Example', reportTime: null }]);
});

test('cached stale reports stay marked stale and keep their original observation time', async () => {
  const time = Date.now() - 200000;
  const result = await fetchWazeAlerts(harvesterAt(), bbox, async () => json({ ...fresh(), state: 'stale', observedAt: time }));
  assert.equal(result.state, 'stale');
  assert.equal(result.observedAt, time);
});

test('overlapping map polls within the TTL share one harvester scan', async () => {
  const t0 = Date.now();
  const h = harvesterAt();
  const cache = createScanCache();
  const { fetchFn, urls } = harvester();
  const first = await fetchWazeAlertsCached(h, bbox, { cache, fetchFn, now: t0 });
  const second = await fetchWazeAlertsCached(h, { minLng: 151.13, minLat: -33.92, maxLng: 151.27, maxLat: -33.83 }, { cache, fetchFn, now: t0 + 1000 });
  assert.equal(urls.length, 1);
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(second.observedAt, first.observedAt, 'a cache hit keeps the harvester observation time');
  assert.equal(second.state, 'fresh');
});

test('the harvester is asked for the grid cells around the box, with map priority', async () => {
  const { fetchFn, urls } = harvester();
  await fetchWazeAlertsCached(harvesterAt(), bbox, { cache: createScanCache(), fetchFn, now: Date.now() });
  const q = urls[0].searchParams;
  assert.equal(q.get('minLng'), '151.1');
  assert.equal(q.get('minLat'), '-33.95');
  assert.equal(q.get('maxLng'), '151.3');
  assert.equal(q.get('maxLat'), '-33.8');
  assert.equal(q.get('priority'), 'map');
});

test('a box already on the grid is not widened by a cell', async () => {
  const { fetchFn, urls } = harvester();
  await fetchWazeAlertsCached(harvesterAt(), { minLng: 151.1, minLat: -33.95, maxLng: 151.3, maxLat: -33.8 }, { cache: createScanCache(), fetchFn, now: Date.now() });
  assert.equal(urls[0].searchParams.get('maxLng'), '151.3');
  assert.equal(urls[0].searchParams.get('maxLat'), '-33.8');
  assert.equal(urls[0].searchParams.get('minLng'), '151.1');
});

test('after the TTL the harvester is asked again', async () => {
  const t0 = Date.now();
  const cache = createScanCache();
  const { fetchFn, urls } = harvester();
  await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0 });
  const justBefore = await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0 + WAZE_CACHE_TTL_MS - 1 });
  assert.equal(justBefore.fromCache, true);
  assert.equal(urls.length, 1);
  const atTtl = await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0 + WAZE_CACHE_TTL_MS });
  assert.equal(atTtl.fromCache, false);
  assert.equal(urls.length, 2);
});

test('navigation always asks the harvester and never fills the cache', async () => {
  const t0 = Date.now();
  const cache = createScanCache();
  const { fetchFn, urls } = harvester();
  const a = await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0, priority: 'navigation' });
  const b = await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0, priority: 'navigation' });
  assert.equal(a.fromCache, false);
  assert.equal(b.fromCache, false);
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get('priority'), 'navigation');
  // The navigation scans stored nothing, so the first map poll still has to scan.
  const map = await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0 });
  assert.equal(map.fromCache, false);
  assert.equal(urls.length, 3);
  const mapAgain = await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0 + 1 });
  assert.equal(mapAgain.fromCache, true);
  assert.equal(urls.length, 3);
});

test('a navigation request is not answered from a map cache entry', async () => {
  const t0 = Date.now();
  const cache = createScanCache();
  const { fetchFn, urls } = harvester();
  await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0 });
  const nav = await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0 + 1, priority: 'navigation' });
  assert.equal(nav.fromCache, false);
  assert.equal(urls.length, 2);
});

test('queued and scanning results are returned but not cached, so the next poll asks again', async () => {
  const t0 = Date.now();
  const cache = createScanCache();
  const { fetchFn, urls } = harvester((call) => call === 1
    ? json({ alerts: [], state: 'queued', observedAt: null, mock: false, queuePosition: 2 }, 202)
    : json({ ...fresh(), state: 'fresh' }));
  const queued = await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0 });
  assert.equal(queued.state, 'queued');
  assert.equal(queued.observedAt, null);
  assert.equal(queued.fromCache, false);
  const next = await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0 });
  assert.equal(next.state, 'fresh');
  assert.equal(next.fromCache, false);
  assert.equal(urls.length, 2);
  const hit = await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0 });
  assert.equal(hit.fromCache, true);
  assert.equal(urls.length, 2);
});

test('stale results are cached with their original observation time', async () => {
  const t0 = Date.now();
  const observedAt = t0 - 200000;
  const cache = createScanCache();
  const { fetchFn, urls } = harvester(() => json({ ...fresh(), state: 'stale', observedAt }));
  const first = await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0 });
  const again = await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0 + 1000 });
  assert.equal(first.state, 'stale');
  assert.equal(again.fromCache, true);
  assert.equal(again.observedAt, observedAt);
  assert.equal(urls.length, 1);
});

test('a failed harvester call is thrown, not cached', async () => {
  const t0 = Date.now();
  const cache = createScanCache();
  const { fetchFn, urls } = harvester((call) => call === 1 ? json({}, 503) : json({ ...fresh(), state: 'fresh' }));
  await assert.rejects(fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0 }), /HTTP 503/);
  const recovered = await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0 });
  assert.equal(recovered.fromCache, false);
  assert.equal(urls.length, 2);
});

test('different priorities or distant boxes do not share an entry', async () => {
  const t0 = Date.now();
  const cache = createScanCache();
  const { fetchFn, urls } = harvester();
  await fetchWazeAlertsCached(harvesterAt(), bbox, { cache, fetchFn, now: t0 });
  await fetchWazeAlertsCached(harvesterAt(), { minLng: 149.0, minLat: -34.5, maxLng: 149.2, maxLat: -34.3 }, { cache, fetchFn, now: t0 });
  assert.equal(urls.length, 2);
});

test('invalid bounds are rejected before anything is fetched', async () => {
  const { fetchFn, urls } = harvester();
  await assert.rejects(fetchWazeAlertsCached(harvesterAt(), { ...bbox, minLat: NaN }, { cache: createScanCache(), fetchFn }));
  assert.equal(urls.length, 0);
});

test('a worker probe refreshes in the background and never more than once per interval', async () => {
  let clock = 1_000_000;
  let calls = 0;
  const probe = new WorkerProbe(async () => { calls++; return { setupStage: 'connecting_waze', firstRun: null }; }, () => clock);
  probe.refresh(true);
  probe.refresh(true); // in flight: ignored
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 1);
  assert.deepEqual(probe.current(), { setupStage: 'connecting_waze', firstRun: null });
  clock += 1000;
  probe.refresh(true);
  assert.equal(calls, 1, 'within the probe interval');
  clock += 120_000;
  assert.equal(probe.current(), null, 'a reading older than the max age is dropped');
  probe.refresh(false);
  assert.equal(calls, 1, 'an unconfigured plugin probes nothing');
});

test('harvester health is read from /health without sending the key', async () => {
  const seen: { url: string; key: string | null }[] = [];
  const health = await fetchWazeWorkerHealth(harvesterAt(), async (url, init) => {
    seen.push({ url, key: new Headers(init?.headers).get('X-API-Key') });
    return json({ setup_stage: 'needs_first_run', first_run: { detected_at: 99, how: 'adb connect 127.0.0.1:5556' }, alerts: [] });
  });
  assert.deepEqual(health, { setupStage: 'needs_first_run', firstRun: { detectedAt: 99, how: 'adb connect 127.0.0.1:5556' } });
  assert.equal(seen[0].url, 'http://127.0.0.1:8098/health');
  assert.equal(seen[0].key, null);
});

test('health probes ignore failed and malformed responses', async () => {
  assert.equal(await fetchWazeWorkerHealth(harvesterAt(), async () => json({}, 503)), null);
  const malformed = await fetchWazeWorkerHealth(harvesterAt(), async () => json({ setup_stage: 7, first_run: { how: 9, detected_at: 'x' } }));
  assert.deepEqual(malformed, { setupStage: null, firstRun: { detectedAt: null, how: null } });
});

// --- Harvester address: the plugin only ever calls a host its manifest declares ---

test('the manifest declares exactly the three standard harvester hosts, and no wildcard', () => {
  assert.deepEqual(DECLARED, [
    { host: '127.0.0.1', port: 18199 },
    { host: '127.0.0.1', port: 8098 },
    { host: 'waze-reports', port: 8088 },
  ]);
  for (const p of manifest.permissions ?? []) {
    if (p.kind === 'network') assert.ok(p.detail && /^[^*]+:\d+$/.test(p.detail), `${p.detail} must be an exact host:port`);
  }
});

test('declaredHarvesterHosts opens nothing for wildcards, other kinds, or unparseable entries', () => {
  assert.deepEqual(declaredHarvesterHosts([
    { kind: 'network', detail: '*.example.com' },
    { kind: 'secrets', detail: '10.0.0.1:80' },
    { kind: 'network', detail: '10.0.0.1' },
    { kind: 'network', detail: 'http://10.0.0.2:80/x' },
  ]), [{ host: '10.0.0.1', port: null }]);
});

test('the base address and the alerts address the core app stores resolve to the same harvester', () => {
  const base = harvesterAt('http://127.0.0.1:8098');
  const alerts = harvesterAt('http://127.0.0.1:8098/alerts/');
  assert.equal(base.base, 'http://127.0.0.1:8098');
  assert.equal(alerts.base, 'http://127.0.0.1:8098');
  assert.equal(alerts.alertsUrl, 'http://127.0.0.1:8098/alerts');
  assert.equal(alerts.healthUrl, 'http://127.0.0.1:8098/health');
  assert.equal(harvesterAt('http://waze-reports:8088/waze/').base, 'http://waze-reports:8088/waze');
});

test('an address the plugin does not declare is refused, so no key is sent to it', () => {
  const refused = [
    'http://192.168.1.5:8098',      // private, undeclared
    'https://example.com/alerts',   // public, undeclared: ctx.fetch would allow it, the plugin does not
    'http://127.0.0.1:9999',        // declared host, undeclared port
    'http://127.0.0.1/alerts',      // declared host, default port 80 is not 8098
  ];
  for (const address of refused) {
    const r = resolveHarvester(address, 'secret', DECLARED);
    assert.equal(r.harvester, null, address);
    assert.equal(r.problem, UNDECLARED_MESSAGE, address);
  }
});

test('an address with credentials, another scheme, or no address at all is refused with a clear reason', () => {
  assert.equal(resolveHarvester('http://user:pw@127.0.0.1:8098', 'k', DECLARED).problem, BAD_ADDRESS_MESSAGE);
  assert.equal(resolveHarvester('ftp://127.0.0.1:8098', 'k', DECLARED).problem, BAD_ADDRESS_MESSAGE);
  assert.equal(resolveHarvester('not a url', 'k', DECLARED).problem, BAD_ADDRESS_MESSAGE);
  assert.equal(resolveHarvester('  ', 'k', DECLARED).problem, SETUP_MESSAGE);
  assert.equal(resolveHarvester(undefined, undefined, DECLARED).problem, SETUP_MESSAGE);
});
