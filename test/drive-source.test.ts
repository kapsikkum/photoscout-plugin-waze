// The Drive source (PhotoScout 1.1.0 drive API): what it registers, the banner, the spoken warning, the status line,
// the pins and taps on the Drive map. Run against a fake host and a fake Drive context (test/web-harness.ts).
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DriveAlert, LngLat, PluginMapClick } from '../src/sdk/web-api.js';
import plugin from '../src/web.js';
import { announceNearest, DRIVE_ERROR_TEXT, driveStatusFor, DRIVE_TICK_MS, formatDistance, nearestAhead, SPEAK_WITHIN_M } from '../src/web/drive.js';
import type { WazeAlertsResponse, WazeReport } from '../src/web/types.js';
import {
  descendants, DRIVE_PREFIX, FakeEl, fakeDriveContext, fakeHost, FakeMap, installFakeDom, textOf, type PollRecord,
} from './web-harness.js';

const NOW = Date.now();
const MINUTE = 60_000;

const report = (id: string, type: string, over: Partial<WazeReport> = {}): WazeReport => ({
  id, type, reportTime: NOW - 5 * MINUTE, point: [0, 51], ...over,
});

function feed(state: WazeAlertsResponse['state'], alerts: WazeReport[]): WazeAlertsResponse {
  return { configured: true, alerts, coverage: 'viewport', observedAt: NOW, state, retryAfterMs: 5000 };
}

/** The Drive source as the plugin registers it, with the poll it starts on the Drive map. */
function driveSource() {
  const { host, rec } = fakeHost(() => feed('fresh', []));
  plugin.activate(host);
  return { rec, source: rec.driveSources[0] };
}

/** Run `fn` with a DOM (the icons and the popup are drawn with one). */
function withDom<T>(fn: () => T): T {
  const restore = installFakeDom();
  try {
    return fn();
  } finally {
    restore();
  }
}

test('the Drive source is "Reports": on by default, the route ahead, and running while planning', () => {
  const { source } = driveSource();
  assert.equal(source.id, 'reports');
  assert.equal(source.label, 'Reports', 'the on/off button reads "Reports on" or "Reports off", as core does');
  assert.equal(source.title, 'Warn about police and hazard reports ahead');
  assert.equal(source.defaultOn, true);
  assert.equal(source.filter, 'route-ahead');
  assert.equal(source.runs, 'always');
});

test('the status hints, and the distances spoken, read as core reads them', () => {
  assert.deepEqual(driveStatusFor('queued'), { state: 'waiting', text: 'Waiting to check reports for this area…' });
  assert.deepEqual(driveStatusFor('scanning'), { state: 'checking', text: 'Checking reports for this area…' });
  assert.deepEqual(driveStatusFor('stale'), { state: 'stale', text: 'Showing older reports while they refresh…' });
  assert.equal(driveStatusFor('fresh'), null, 'a fresh feed shows nothing');
  assert.equal(DRIVE_ERROR_TEXT, "Police and hazard reports can't load right now");

  assert.equal(formatDistance(42), '40 m');
  assert.equal(formatDistance(430), '450 m');
  assert.equal(formatDistance(1234), '1.2 km');
  assert.equal(formatDistance(14_600), '15 km');
  assert.equal(formatDistance(-1), '');
});

test('the warning is the nearest report on the road ahead, and nothing is said beyond 800 m', () => {
  const alerts: DriveAlert[] = [
    { id: 'far', point: [0, 51], title: 'Hazard reported' },
    { id: 'near', point: [0.001, 51], title: 'Police reported', detail: 'George St' },
    { id: 'behind', point: [0.002, 51], title: 'Crash reported' },
  ];
  const ahead: Record<string, number | null> = { far: 1300, near: 420, behind: null };
  const routeAhead = (point: LngLat) => ahead[alerts.find((a) => a.point === point)?.id ?? ''] ?? null;

  assert.deepEqual(nearestAhead(alerts, routeAhead)?.alert.id, 'near', 'the one nearest along the route wins');

  const drive = fakeDriveContext({ routeAhead });
  assert.equal(announceNearest(drive.ctx, alerts), true);
  assert.deepEqual(drive.spoken, [{ text: 'Police reported ahead, in 400 m.', key: 'near' }], 'said once, keyed by the alert id');

  const far = fakeDriveContext({ routeAhead: () => SPEAK_WITHIN_M + 1 });
  assert.equal(announceNearest(far.ctx, [alerts[0]]), false, 'a report 800 m or more away is not spoken');
  assert.equal(far.spoken.length, 0);

  const none = fakeDriveContext({ routeAhead: () => null });
  assert.equal(announceNearest(none.ctx, alerts), false, 'nothing ahead, nothing said');
});

test('the host decides whether a warning is said; a refused one reports so and is not counted as said', () => {
  const drive = fakeDriveContext({ routeAhead: () => 200, speakAnswer: false });
  assert.equal(announceNearest(drive.ctx, [{ id: 'p1', point: [0, 51], title: 'Police reported' }]), false);
  assert.equal(drive.spoken.length, 1, 'it was offered to the host, which said no (voice off, stale fix or already said)');
});

test('start draws the pins on the Drive map under its own ids, and claims their taps', () => {
  const { source } = driveSource();
  withDom(() => {
    const drive = fakeDriveContext();
    const stop = source.start(drive.ctx) as () => void;
    try {
      assert.deepEqual(drive.map.layers.map((l) => [l.id, l.type]), [[`${DRIVE_PREFIX}reports`, 'circle'], [`${DRIVE_PREFIX}labels`, 'symbol']]);
      assert.ok(drive.map.sources.has(`${DRIVE_PREFIX}reports-src`));
      assert.equal(drive.map.images.length, 7, 'one icon per report type, on this map');
      assert.ok(drive.map.images.every((id) => id.startsWith(`${DRIVE_PREFIX}icon-`)));
      assert.deepEqual(drive.claims.map((c) => c.layers), [[`${DRIVE_PREFIX}reports`, `${DRIVE_PREFIX}labels`]]);
    } finally {
      stop();
    }
    assert.equal(drive.claims.length, 0, 'the claim ends with the source');
  });
});

test('a restart on the same Drive map does not add the icons a second time', () => {
  const { source } = driveSource();
  withDom(() => {
    const map = new FakeMap();
    const first = source.start(fakeDriveContext({ map }).ctx) as () => void;
    first();
    const second = source.start(fakeDriveContext({ map }).ctx) as () => void;
    try {
      assert.equal(map.images.length, 7);
    } finally {
      second();
    }
  });
});

test('the banner gets the reports a driver is warned about (no traffic jams), and the feed state shows as a status line', () => {
  const { source, rec } = driveSource();
  withDom(() => {
    const drive = fakeDriveContext();
    const stop = source.start(drive.ctx) as () => void;
    try {
      const poll = rec.polls.at(-1) as PollRecord;
      const alerts = [report('p1', 'POLICE', { street: 'George St' }), report('j1', 'JAM')];

      poll.options.onData(feed('queued', alerts));
      assert.deepEqual(drive.reports.at(-1)?.map((a) => a.id), ['p1'], 'the jam is for the map only');
      assert.equal(drive.reports.at(-1)?.[0].detail, 'George St');
      assert.deepEqual(drive.statuses.at(-1), { state: 'waiting', text: 'Waiting to check reports for this area…' });
      assert.equal(drive.map.features(`${DRIVE_PREFIX}reports-src`).length, 2, 'the map shows every type, the jam too');

      poll.options.onData(feed('scanning', alerts));
      assert.equal(drive.statuses.at(-1)?.state, 'checking');
      poll.options.onData(feed('stale', alerts));
      assert.equal(drive.statuses.at(-1)?.state, 'stale');
      poll.options.onData(feed('fresh', alerts));
      assert.equal(drive.statuses.at(-1), null, 'a fresh feed clears the line');
    } finally {
      stop();
    }
  });
});

test('a failing feed says so, clears the banner and the pins, and the line goes when the source stops', () => {
  const { source, rec } = driveSource();
  withDom(() => {
    const drive = fakeDriveContext();
    const stop = source.start(drive.ctx) as () => void;
    try {
      const poll = rec.polls.at(-1) as PollRecord;
      poll.options.onData(feed('fresh', [report('p1', 'POLICE')]));
      assert.equal(drive.map.features(`${DRIVE_PREFIX}reports-src`).length, 1);

      poll.options.onError?.(new Error('down'));
      assert.deepEqual(drive.statuses.at(-1), { state: 'error', text: DRIVE_ERROR_TEXT });
      assert.deepEqual(drive.reports.at(-1), []);
      assert.equal(drive.map.features(`${DRIVE_PREFIX}reports-src`).length, 0);

      poll.options.onStop?.();
      assert.equal(drive.statuses.at(-1), null, 'the line is cleared when the source stops');
    } finally {
      stop();
    }
  });
});

test('the nearest report ahead is spoken as the car comes to it, keyed for once-per-drive (every 2 s, as core)', () => {
  const { source, rec } = driveSource();
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    withDom(() => {
      const drive = fakeDriveContext({ routeAhead: () => 300 });
      const stop = source.start(drive.ctx) as () => void;
      try {
        const poll = rec.polls.at(-1) as PollRecord;
        poll.options.onData(feed('fresh', [report('p1', 'POLICE')]));
        assert.equal(drive.spoken.length, 1, 'spoken at once when the data arrives');
        mock.timers.tick(DRIVE_TICK_MS);
        assert.equal(drive.spoken.length, 2, 'and checked again on each two-second tick');
        assert.ok(drive.spoken.every((s) => s.key === 'p1' && s.text === 'Police reported ahead, in 300 m.'));
      } finally {
        stop();
      }
      mock.timers.tick(DRIVE_TICK_MS * 3);
      assert.equal(drive.spoken.length, 2, 'the checks stop when the source stops');
    });
  } finally {
    mock.timers.reset();
  }
});

test('a tap on a Drive pin opens its popup over the map, picks no destination, and closes on a map click', () => {
  const { source } = driveSource();
  withDom(() => {
    const drive = fakeDriveContext();
    const stop = source.start(drive.ctx) as () => void;
    try {
      tapFlow(drive);
    } finally {
      stop();
    }
    assert.equal(drive.map.container.children.length, 0, 'the popup goes when the source stops');
    assert.equal(drive.claims.length, 0);
  });
});

/** The tap sequence, kept apart so the test can stop the source whatever happens in it. */
function tapFlow(drive: ReturnType<typeof fakeDriveContext>): void {
  {
    const tap = (title: string) => drive.claims[0].onTap?.({
      lngLat: [0.5, 51], point: { x: 1, y: 2 }, layerId: `${DRIVE_PREFIX}reports`, map: drive.map as unknown as PluginMapClick['map'],
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0.5, 51] }, properties: { title, street: 'George St', description: '', reportTime: NOW } }],
    } as PluginMapClick);

    tap('Police reported');
    const popup = drive.map.container.children.at(-1) as FakeEl | undefined;
    assert.ok(popup, 'the popup is on the map');
    assert.match(textOf(popup), /^Police reported/);
    assert.ok(textOf(popup).includes('George St'));
    assert.equal(popup.style.left, '0.5px', 'placed at the report');

    tap('Traffic jam reported');
    assert.equal(drive.map.container.children.length, 1, 'a second tap replaces the first popup');

    drive.map.fire('click');
    assert.equal(drive.map.container.children.length, 0, 'a click on the map closes it');
    assert.equal(drive.map.listenerCount('move'), 0);

    tap('Police reported');
    const close = descendants(drive.map.container.children[0]).find((e) => e.getAttribute('aria-label') === 'Close');
    assert.ok(close);
    close.click();
    assert.equal(drive.map.container.children.length, 0, 'the close button closes it');

    tap('Police reported');
    assert.equal(drive.map.container.children.length, 1, 'a tap after closing opens a new popup');
  }
}
