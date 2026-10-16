// The web half, activated against a fake host: what it registers, the layers it adds to the map, the URLs
// it asks the plugin's own routes for, what the poll callbacks do, and how the views draw and respond.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginMapClick, RenderFn, SettingsTabProps } from '../src/sdk/web-api.js';
import plugin from '../src/web.js';
import { alertsPath, heatmapPath, statusPath } from '../src/web/query.js';
import type { WazeAlertsResponse, WazeHeatmapResponse, WazeReport, WazeStatusResponse } from '../src/web/types.js';
import {
  buttonNamed, descendants, FakeEl, fakeDriveContext, fakeHost, FakeMap, installFakeDom, PLUGIN_ID, scoped, settle, textOf, type PollRecord,
} from './web-harness.js';

const BOX = { minLng: -1, minLat: 50, maxLng: 1, maxLat: 52 };
const NOW = Date.now();
const MINUTE = 60_000;
const signal = (): AbortSignal => new AbortController().signal;

const report = (id: string, type: string, over: Partial<WazeReport> = {}): WazeReport => ({
  id, type, reportTime: NOW - 5 * MINUTE, point: [0, 51], ...over,
});

/** The canned answers, changed by a test when it needs another state. */
function answers() {
  const body = {
    alerts: {
      configured: true,
      alerts: [report('p1', 'POLICE', { street: 'George St' }), report('h1', 'HAZARD')],
      coverage: 'viewport',
      observedAt: NOW,
      state: 'fresh',
      retryAfterMs: 30_000,
    } as WazeAlertsResponse,
    heat: { configured: true, windowMs: 7_200_000, observedAt: NOW, points: [{ point: [0, 51] as [number, number], weight: 0.5 }] } as WazeHeatmapResponse,
    status: {
      configured: true,
      liveMapStatus: { endpoint: 'bridge', accessible: false, status: null, message: 'down' },
      checked: false, alertCount: null, coverage: null, observedAt: null, canDisplayOnMap: false, attribution: 'Waze / Google',
      setup: { state: 'ready', message: 'Waze reports are ready', updatedAt: null },
    } as WazeStatusResponse,
  };
  const respond = (path: string): unknown => {
    if (path.startsWith('/alerts')) return body.alerts;
    if (path.startsWith('/heatmap')) return body.heat;
    if (path.startsWith('/status')) return body.status;
    throw new Error(`unexpected request ${path}`);
  };
  return { body, respond };
}

/** Activate the plugin against a fresh host, and run the map's onReady on a fresh map. */
function activated() {
  const a = answers();
  const { host, rec } = fakeHost(a.respond);
  plugin.activate(host);
  const map = new FakeMap();
  const restore = installFakeDom();
  for (const cb of rec.ready) cb(map);
  restore();
  // Polls: heat, then pins, in the order onReady made them.
  const [heatPoll, pinPoll] = rec.polls as [PollRecord, PollRecord];
  return { ...a, host, rec, map, heatPoll, pinPoll };
}

const renderOf = (view: { render?: unknown }): RenderFn<SettingsTabProps> => view.render as RenderFn<SettingsTabProps>;

test('activate registers the two legend toggles, the corner, the Settings tab, the Drive source and the popup click', () => {
  const { rec } = activated();
  assert.deepEqual(rec.legend.map((d) => [d.key, d.menu, d.defaultOn]), [['waze', 'live', false], ['police-heat', 'live', false]]);
  assert.deepEqual(rec.legend[0].layers, [scoped('reports'), scoped('report-labels')]);
  assert.deepEqual(rec.legend[1].layers, [scoped('police-heat')]);
  assert.equal(rec.corners[0].id, 'heat-window');
  assert.equal(rec.corners[0].whileOn, 'police-heat', 'the corner shows only while the heatmap is on');
  assert.equal(rec.tabs[0].id, 'reports');
  assert.equal(rec.tabs[0].group, 'Map');
  assert.equal(rec.tabs[0].admin, false, 'every visitor may open the tab');
  assert.deepEqual(rec.driveSources.map((s) => s.id), ['reports']);
  assert.deepEqual(rec.clicks.map((c) => c.layers), [[scoped('reports')]]);
});

test('on each map the heatmap is added before the report pins, and the icons are registered under the plugin id', () => {
  const { map } = activated();
  assert.deepEqual(map.layers.map((l) => [l.id, l.type]), [
    [scoped('police-heat'), 'heatmap'], [scoped('reports'), 'circle'], [scoped('report-labels'), 'symbol'],
  ]);
  assert.deepEqual(map.layers[2].layout?.['icon-image'], ['concat', scoped('icon-'), ['get', 'iconType']]);
  assert.equal(map.images.length, 7, 'one icon per report type');
  assert.ok(map.images.every((id) => id.startsWith(scoped('icon-'))));
  assert.deepEqual([...map.sources.keys()], [scoped('police-heat-src'), scoped('reports-src')]);
});

test('the heatmap and the pins poll with the view box; Drive polls with navigation priority', async () => {
  const { rec, heatPoll, pinPoll } = activated();
  assert.equal(heatPoll.options.while, rec.entries['police-heat']);
  assert.equal(pinPoll.options.while, rec.entries.waze);
  assert.equal(heatPoll.options.intervalMs, 60_000);
  assert.equal(pinPoll.options.intervalMs, 30_000);
  assert.equal(pinPoll.options.refreshOnMove, true);

  await heatPoll.options.fetch({ signal: signal(), bounds: BOX });
  assert.equal(rec.requests.at(-1), heatmapPath(BOX, 7_200_000));
  await pinPoll.options.fetch({ signal: signal(), bounds: BOX });
  assert.equal(rec.requests.at(-1), alertsPath(BOX, 'map'));

  const restore = installFakeDom();
  try {
    const stopDrive = rec.driveSources[0].start(fakeDriveContext().ctx) as () => void;
    const drivePoll = rec.polls[2];
    await drivePoll.options.fetch({ signal: signal(), bounds: BOX });
    assert.equal(rec.requests.at(-1), alertsPath(BOX, 'navigation'));
    stopDrive();
  } finally {
    restore();
  }
});

test('the view paths are single-slash plugin routes with no .. segment, as the host requires', () => {
  for (const path of [alertsPath(BOX, 'navigation'), heatmapPath(BOX, 3_600_000), statusPath(true)]) {
    assert.match(path, /^\/[a-z]+\?/);
    assert.doesNotMatch(path, /\/\.\./);
  }
  assert.equal(statusPath(false), '/status');
  assert.equal(`/api/plugins/${PLUGIN_ID}${statusPath(false)}`, '/api/plugins/map.24thframe.waze/status');
});

test('reports are drawn on the map and announced once per change; a failing feed is cleared and announced once', async () => {
  const { rec, map, pinPoll, body } = activated();
  const src = scoped('reports-src');

  await pinPoll.options.fetch({ signal: signal(), bounds: BOX });
  pinPoll.options.onData(body.alerts);
  assert.equal(map.features(src).length, 2);
  assert.deepEqual(rec.activity, [{ message: '2 reports for this area', level: 'success' }]);

  pinPoll.options.onData(body.alerts);
  assert.equal(rec.activity.length, 1, 'the same state and count is not announced again');

  pinPoll.options.onError?.(new Error('down'));
  assert.equal(map.features(src).length, 0, 'a failed feed clears the pins');
  assert.equal(rec.activity.length, 2);
  assert.deepEqual(rec.activity[1], { message: 'Reports unavailable; check Police & hazards in Settings', level: 'error' });

  pinPoll.options.onError?.(new Error('still down'));
  assert.equal(rec.activity.length, 2, 'a failure that continues is not announced again');

  pinPoll.options.onData(body.alerts);
  pinPoll.options.onError?.(new Error('down again'));
  assert.equal(rec.activity.length, 4, 'a fresh failure after a recovery is announced');
});

test('a feed still being scanned is asked again after the time the server gives; a fresh one is not', () => {
  const { pinPoll, body } = activated();
  assert.equal(pinPoll.options.retryAfterMs?.({ ...body.alerts, state: 'queued', retryAfterMs: 5000 }), 5000);
  assert.equal(pinPoll.options.retryAfterMs?.({ ...body.alerts, state: 'stale', retryAfterMs: 5000 }), 5000);
  assert.equal(pinPoll.options.retryAfterMs?.(body.alerts), null);
});

test('the heatmap shows its points while it is on, and clears them when it is turned off', async () => {
  const { map, heatPoll, body } = activated();
  const src = scoped('police-heat-src');
  heatPoll.options.onData(body.heat);
  assert.equal(map.features(src).length, 1);
  assert.equal(map.features(src)[0].properties?.weight, 0.5);
  heatPoll.options.onStop?.();
  assert.equal(map.features(src).length, 0);
});

test('a click on a report opens a popup with its title, street, time and source', () => {
  const { rec } = activated();
  const restore = installFakeDom();
  try {
    const click = rec.clicks[0].cb;
    click({
      features: [{ properties: { title: 'Police reported', street: 'George St', description: '', reportTime: NOW } }],
      lngLat: [151.2, -33.87], point: { x: 0, y: 0 }, layerId: scoped('reports'), map: new FakeMap(),
    } as unknown as PluginMapClick);
    const content = rec.popups[0].content as FakeEl;
    const text = textOf(content);
    assert.match(text, /^Police reported/);
    assert.ok(text.includes('George St'));
    assert.match(text, /Reported \S/);
    assert.ok(text.endsWith('Waze community report'));
  } finally {
    restore();
  }
});

test('Drive is told about the recent police and hazard reports, and is cleared when the drive ends', async () => {
  const { rec, body } = activated();
  const restore = installFakeDom();
  try {
    const drive = fakeDriveContext();
    const stop = rec.driveSources[0].start(drive.ctx) as () => void;
    const drivePoll = rec.polls[2];
    body.alerts.alerts.push(report('jam', 'JAM'));
    drivePoll.options.onData(body.alerts);
    const shown = drive.reports.at(-1) as Array<{ id: string; detail?: string }>;
    assert.deepEqual(shown.map((a) => a.id), ['p1', 'h1'], 'the jam is map-only');
    assert.equal(shown[0].detail, 'George St');
    body.alerts.alerts.pop();

    stop();
    assert.equal(drivePoll.stopped, true);
    drivePoll.options.onStop?.();
    assert.deepEqual(drive.reports.at(-1), [], 'the drive ends with nothing to warn about');
  } finally {
    restore();
  }
});

test('the Settings tab is open to visitors, and shows the first-run instructions to admins only', async () => {
  const { rec, body } = activated();
  body.status.setup = { state: 'needs_first_run', message: 'Waze needs its first-run screen', updatedAt: null, first_run: { detected_at: 1, how: 'Tap Get started' } };
  const restore = installFakeDom();
  const ends: Array<() => void> = [];
  try {
    const visitor = new FakeEl('div');
    ends.push(renderOf(rec.tabs[0])(visitor as never, { isAdmin: false }) as () => void);
    await settle();
    const cards = descendants(visitor).filter((e) => e.classes.has('waze-status-card'));
    assert.equal(cards[0].hidden, true, 'the first-run card is hidden from a visitor');
    assert.equal(textOf(visitor).includes('Tap Get started'), false, 'and holds none of the instructions');
    assert.ok(textOf(visitor).includes('Police & hazard reports are being set up.'));

    const admin = new FakeEl('div');
    ends.push(renderOf(rec.tabs[0])(admin as never, { isAdmin: true }) as () => void);
    await settle();
    const adminCards = descendants(admin).filter((e) => e.classes.has('waze-status-card'));
    assert.equal(adminCards[0].hidden, false, 'the first-run card is shown to an admin');
    assert.ok(textOf(admin).includes('Tap Get started'));
  } finally {
    for (const end of ends) end();
    restore();
  }
});

test('Test connection asks the harvester now, shows the answer, and logs it to the Activity panel', async () => {
  const { rec, body } = activated();
  body.status.liveMapStatus = { endpoint: 'bridge', accessible: true, status: 200, message: 'ok' };
  body.status.checked = true;
  body.status.alertCount = 3;
  const restore = installFakeDom();
  let end: (() => void) | undefined;
  try {
    const el = new FakeEl('div');
    end = renderOf(rec.tabs[0])(el as never, { isAdmin: false }) as () => void;
    await settle();
    buttonNamed(el, 'Test connection').click();
    await settle();
    assert.equal(rec.requests.at(-1), '/status?check=1');
    assert.ok(textOf(el).includes('Connected. 3 reports are available right now.'));
    assert.deepEqual(rec.activity.at(-1), { message: 'Police and hazards: connected; 3 reports returned', level: 'success' });
  } finally {
    end?.();
    restore();
  }
});

test('the heatmap window is one choice: picking it in the map corner shows in the Settings tab and refreshes the heatmap', async () => {
  const { rec, heatPoll } = activated();
  const restore = installFakeDom();
  let endTab: (() => void) | undefined;
  try {
    const corner = new FakeEl('div');
    rec.corners[0].render?.(corner as never, {} as never);
    const tab = new FakeEl('div');
    endTab = renderOf(rec.tabs[0])(tab as never, { isAdmin: false }) as () => void;
    await settle();

    buttonNamed(corner, '24h').click();
    assert.equal(buttonNamed(tab, '24h').getAttribute('aria-pressed'), 'true');
    assert.equal(buttonNamed(tab, '2h').getAttribute('aria-pressed'), 'false');
    assert.equal(heatPoll.refreshes, 1, 'the heatmap asks again at once');
    await heatPoll.options.fetch({ signal: signal(), bounds: BOX });
    assert.equal(rec.requests.at(-1), heatmapPath(BOX, 86_400_000));
  } finally {
    endTab?.();
    restore();
  }
});
