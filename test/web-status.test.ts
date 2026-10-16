// The harvester status wording for the web half's Settings tab and the map's activity log. The pure
// functions of src/web/status.ts, ported from the core app's WazeSettings.tsx and MapPage.tsx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionText, coverageNote, reportsActivity, setupNeedsPolling } from '../src/web/status.js';
import type { WazeStatusResponse } from '../src/web/types.js';

const status = (over: Partial<WazeStatusResponse> = {}): WazeStatusResponse => ({
  configured: true,
  liveMapStatus: { endpoint: 'Android police/hazard report bridge', accessible: false, status: null, message: 'Waze report bridge returned HTTP 503' },
  checked: true,
  alertCount: null,
  coverage: null,
  observedAt: null,
  canDisplayOnMap: false,
  attribution: 'Waze / Google',
  setup: { state: 'ready', message: 'Waze reports are ready', updatedAt: null },
  ...over,
});

test('a first-run screen tells the admin to finish it, and a visitor only that reports are being set up', () => {
  const waiting = status({ setup: { state: 'needs_first_run', message: 'Waze needs its first-run screen', updatedAt: null } });
  assert.match(connectionText(waiting, true).text, /first-run screen/);
  assert.equal(connectionText(waiting, false).text, 'Police & hazard reports are being set up.');
});

test('an unset harvester says where to set it, to an admin; a visitor is told only that it is not set up', () => {
  const unset = status({ configured: false, checked: false });
  assert.equal(connectionText(unset, true).text, 'Not set up yet. Add the harvester address and key in this plugin\'s settings.');
  assert.equal(connectionText(unset, false).text, 'Not set up on this server yet.');
});

test('an unchecked feed says to test it, with no tone', () => {
  assert.deepEqual(connectionText(status({ checked: false }), false), { tone: '', text: 'Not checked yet. Press Test connection to check.' });
});

test('a connected feed says how many reports it has, and a zero count is never an all-clear', () => {
  const live = { endpoint: 'bridge', accessible: true, status: 200, message: 'ok' };
  assert.deepEqual(connectionText(status({ liveMapStatus: live, alertCount: 3 }), false), { tone: 'ok', text: 'Connected. 3 reports are available right now.' });
  assert.deepEqual(connectionText(status({ liveMapStatus: live, alertCount: 0 }), false), {
    tone: 'ok', text: 'Connected. No reports are available right now, which does not mean the roads are clear.',
  });
});

test('a feed that cannot be reached shows the harvester\'s message to admins only', () => {
  const down = status();
  assert.deepEqual(connectionText(down, false), { tone: 'error', text: 'Not connected. Reports can\'t load right now.' });
  assert.match(connectionText(down, true).text, /\(Waze report bridge returned HTTP 503\)$/);
});

test('the Settings tab asks again while the harvester is setting up, and not once it is ready or has failed', () => {
  for (const state of ['installing', 'starting', 'needs_first_run']) assert.equal(setupNeedsPolling(state), true, state);
  for (const state of ['ready', 'failed', 'not_started']) assert.equal(setupNeedsPolling(state), false, state);
});

test('the activity log states a scan, a queue and a stale answer plainly, and writes a fresh one up as a success only with reports', () => {
  assert.deepEqual(reportsActivity('queued', 0), { message: 'Waiting to check reports for this area', level: 'info' });
  assert.deepEqual(reportsActivity('scanning', 0), { message: 'Checking reports for this area…', level: 'info' });
  assert.deepEqual(reportsActivity('stale', 4), { message: 'Showing older reports while they refresh…', level: 'info' });
  assert.deepEqual(reportsActivity('fresh', 2), { message: '2 reports for this area', level: 'success' });
  assert.deepEqual(reportsActivity('fresh', 0), {
    message: 'No reports for this area right now; that does not mean the roads are clear', level: 'info',
  });
});

test('the coverage note says what the harvester covers, and says nothing when it covers no particular area', () => {
  assert.match(coverageNote('route') ?? '', /Only reports along the route/);
  assert.match(coverageNote('viewport') ?? '', /areas you look at on the map/);
  assert.equal(coverageNote(null), null);
});
