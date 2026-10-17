// The Drive source (PhotoScout 2.0.0 drive API): what it registers, the banner, the spoken warning, the status line,
// the pins and taps on the Drive map. Run against a fake host and a fake Drive context (test/web-harness.ts).
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DriveAlert, LngLat, PluginMapClick } from '../src/sdk/web-api.js';
import plugin from '../src/web.js';
import { announceNearest, DRIVE_ERROR_TEXT, driveStatusFor, DRIVE_TICK_MS, formatDistance, nearestAhead, SPEAK_WITHIN_M } from '../src/web/drive.js';
import type { WazeAlertsResponse, WazeReport } from '../src/web/types.js';
import { DRIVE_PREFIX, fakeDriveContext, fakeHost, installFakeDom, textOf, type FakeEl, type PollRecord } from './web-harness.js';

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

/** Run `fn` with a DOM (the icons are drawn with one). */
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
  assert.equal(source.tuning, undefined, 'no tuning: the host\'s own rules (800 m, 100 m on the route, 1500 m ahead, 10 s and 75 m for speech) apply');
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
  assert.deepEqual(announceNearest(drive.ctx, alerts), { spoken: true });
  assert.deepEqual(drive.spoken, [{ text: 'Police reported ahead, in 400 m.', key: 'near' }], 'said once, keyed by the alert id');

  const far = fakeDriveContext({ routeAhead: () => SPEAK_WITHIN_M + 1 });
  assert.equal(announceNearest(far.ctx, [alerts[0]]), null, 'a report 800 m or more away is not spoken, and not offered to the host');
  assert.equal(far.spoken.length, 0);

  const none = fakeDriveContext({ routeAhead: () => null });
  assert.equal(announceNearest(none.ctx, alerts), null, 'nothing ahead, nothing said');
});

test('speak answers with a result: a refusal says why, and is not a success', () => {
  const drive = fakeDriveContext({ routeAhead: () => 200, speakRefusal: 'voice-off' });
  const said = announceNearest(drive.ctx, [{ id: 'p1', point: [0, 51], title: 'Police reported' }]);
  assert.deepEqual(said, { spoken: false, reason: 'voice-off' });
  assert.equal(said?.spoken, false, 'a refusal is read from `spoken`, never as a truthy object');
  assert.equal(drive.spoken.length, 1, 'it was offered to the host, which refused');
});

test('start draws the pins on the Drive map under its own ids, with icons the host adds, and claims their taps', () => {
  const { source } = driveSource();
  withDom(() => {
    const drive = fakeDriveContext();
    const stop = source.start(drive.ctx) as () => void;
    try {
      assert.deepEqual(drive.map.layers.map((l) => [l.id, l.type]), [[`${DRIVE_PREFIX}reports`, 'circle'], [`${DRIVE_PREFIX}labels`, 'symbol']]);
      assert.ok(drive.map.sources.has(`${DRIVE_PREFIX}reports-src`));
      assert.equal(drive.images.length, 7, 'one icon per report type, added through the host');
      assert.ok(drive.images.every((name) => name.startsWith('icon-')));
      assert.equal(drive.map.images.length, 0, 'nothing is added to the Drive map directly');
      const labels = drive.map.layers[1];
      assert.deepEqual(labels.layout?.['icon-image'], ['concat', `${DRIVE_PREFIX}icon-`, ['get', 'iconType']], 'the icon ids are the ones the host scopes');
      assert.equal(labels.layout?.['icon-size'], 0.5, 'half size: the host adds the icons at pixel ratio 1, so they show at 32 px');
      assert.deepEqual(drive.claims.map((c) => c.layers), [[`${DRIVE_PREFIX}reports`, `${DRIVE_PREFIX}labels`]]);
    } finally {
      stop();
    }
    assert.equal(drive.claims.length, 0, 'the claim ends with the source');
  });
});

test('the host removes a source\'s icons when it stops, so every start adds them again', () => {
  const { source } = driveSource();
  withDom(() => {
    const drive = fakeDriveContext();
    (source.start(drive.ctx) as () => void)();
    (source.start(drive.ctx) as () => void)();
    assert.equal(drive.images.length, 14, 'seven icons on each start');
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

      // A queued/scanning answer carries no reports yet: it sets the status line but leaves the pins and
      // warnings as they are, so panning into an unscanned area does not blink them away.
      poll.options.onData(feed('queued', alerts));
      assert.deepEqual(drive.statuses.at(-1), { state: 'waiting', text: 'Waiting to check reports for this area…' });
      assert.equal(drive.map.features(`${DRIVE_PREFIX}reports-src`).length, 0, 'nothing is drawn while a scan is queued');

      poll.options.onData(feed('scanning', alerts));
      assert.equal(drive.statuses.at(-1)?.state, 'checking');
      assert.equal(drive.map.features(`${DRIVE_PREFIX}reports-src`).length, 0, 'still nothing while scanning');

      poll.options.onData(feed('stale', alerts));
      assert.deepEqual(drive.reports.at(-1)?.map((a) => a.id), ['p1'], 'the jam is for the map only');
      assert.equal(drive.reports.at(-1)?.[0].detail, 'George St');
      assert.equal(drive.statuses.at(-1)?.state, 'stale');
      assert.equal(drive.map.features(`${DRIVE_PREFIX}reports-src`).length, 2, 'the map shows every type, the jam too');

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

test('a host refusal is logged once when its reason changes, not on every check', () => {
  const { source, rec } = driveSource();
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    withDom(() => {
      const drive = fakeDriveContext({ routeAhead: () => 300, speakRefusal: 'voice-off' });
      const stop = source.start(drive.ctx) as () => void;
      try {
        const poll = rec.polls.at(-1) as PollRecord;
        poll.options.onData(feed('fresh', [report('p1', 'POLICE')]));
        mock.timers.tick(DRIVE_TICK_MS * 2);
        assert.equal(drive.spoken.length, 3, 'offered to the host on each check');
        assert.deepEqual(rec.logs, ['Drive warning not spoken: voice-off'], 'logged once');
      } finally {
        stop();
      }
    });
  } finally {
    mock.timers.reset();
  }
});

test('a duplicate, the normal answer once a warning has been said, is not logged', () => {
  const { source, rec } = driveSource();
  withDom(() => {
    const drive = fakeDriveContext({ routeAhead: () => 300, speakRefusal: 'duplicate' });
    const stop = source.start(drive.ctx) as () => void;
    try {
      (rec.polls.at(-1) as PollRecord).options.onData(feed('fresh', [report('p1', 'POLICE')]));
      assert.equal(drive.spoken.length, 1);
      assert.deepEqual(rec.logs, []);
    } finally {
      stop();
    }
  });
});

test('a tap on a Drive pin asks the host for its popup, picks no destination, and listens to no map event of its own', () => {
  const { source } = driveSource();
  withDom(() => {
    const drive = fakeDriveContext();
    const stop = source.start(drive.ctx) as () => void;
    try {
      const tap = (title: string, street: string) => drive.claims[0].onTap?.({
        lngLat: [0.5, 51], point: { x: 1, y: 2 }, layerId: `${DRIVE_PREFIX}reports`, map: drive.map as unknown as PluginMapClick['map'],
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0.5, 51] }, properties: { title, street, description: '', reportTime: NOW } }],
      } as PluginMapClick);

      tap('Police reported', 'George St');
      assert.equal(drive.popups.length, 1, 'the popup is the host\'s: the plugin shows it through ctx.showPopup');
      assert.deepEqual(drive.popups[0].at, [0.5, 51], 'placed at the report');
      const first = drive.popups[0].content as FakeEl;
      assert.match(textOf(first), /^Police reported/);
      assert.ok(textOf(first).includes('George St'));

      tap('Traffic jam reported', '');
      assert.equal(drive.popups.length, 2, 'a second tap asks again; the host keeps one popup per source');
      assert.match(textOf(drive.popups[1].content as FakeEl), /^Traffic jam reported/);

      assert.equal(drive.map.listenerCount('click'), 0, 'no map click listener of its own: the host closes the popup on a click');
      assert.equal(drive.map.listenerCount('move'), 0, 'and no move listener: the host places it');
    } finally {
      stop();
    }
    assert.equal(drive.claims.length, 0, 'the tap claim ends with the source');
  });
});
