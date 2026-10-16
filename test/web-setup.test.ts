// The Settings tab's "Set up Waze reports" card (core's Settings button, ported): admins only, POST /setup,
// the busy state while the helper works, and the error line when the server refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RenderFn, SettingsTabProps } from '../src/sdk/web-api.js';
import plugin from '../src/web.js';
import type { WazeSetupView, WazeStatusResponse } from '../src/web/types.js';
import { buttonNamed, descendants, FakeEl, fakeHost, installFakeDom, settle, textOf } from './web-harness.js';

const NOW = Date.now();

function status(setup: WazeSetupView): WazeStatusResponse {
  return {
    configured: false,
    liveMapStatus: { endpoint: 'bridge', accessible: false, status: null, message: 'not set up' },
    checked: false, alertCount: null, coverage: null, observedAt: null, canDisplayOnMap: false, attribution: 'Waze / Google',
    setup,
  };
}

/** The plugin's Settings tab, rendered for a viewer, with the server's answers for the status and the setup. */
function renderTab(opts: { setup: WazeSetupView; post?: () => unknown }) {
  let current = opts.setup;
  const { host, rec } = fakeHost((path, init) => {
    if (init?.method === 'POST') {
      if (path !== '/setup') throw new Error(`unexpected POST ${path}`);
      if (!opts.post) throw new Error('no POST answer set');
      return opts.post();
    }
    if (path.startsWith('/status')) return status(current);
    throw new Error(`unexpected request ${path}`);
  });
  plugin.activate(host);
  const tab = rec.tabs[0];
  const el = new FakeEl('div');
  const end = (tab.render as RenderFn<SettingsTabProps>)(el as never, { isAdmin: true }) as () => void;
  return {
    el, rec, end,
    become(next: WazeSetupView) { current = next; },
  };
}

test('the setup card is for admins: an admin sees the button, a visitor sees none of it', async () => {
  const restore = installFakeDom();
  const made: Array<() => void> = [];
  try {
    const { host, rec } = fakeHost((path) => { if (path.startsWith('/status')) return status({ state: 'not_started', message: 'Waze report setup has not run', updatedAt: null }); throw new Error(path); });
    plugin.activate(host);
    const admin = new FakeEl('div');
    made.push(rec.tabs[0].render?.(admin as never, { isAdmin: true }) as () => void);
    const visitor = new FakeEl('div');
    made.push(rec.tabs[0].render?.(visitor as never, { isAdmin: false }) as () => void);
    await settle();

    buttonNamed(admin, 'Set up Waze reports');
    const adminCard = descendants(admin).find((e) => e.tagName === 'H3' && e.textContent === 'Set up reports')?.parent;
    assert.equal(adminCard?.hidden, false, 'the card is shown to an admin');

    const visitorCard = descendants(visitor).find((e) => e.tagName === 'H3' && e.textContent === 'Set up reports')?.parent;
    assert.equal(visitorCard?.hidden, true, 'the card is hidden from a visitor');
    assert.equal(textOf(visitor).includes('Set up Waze reports'), true, 'its button is still in the tree, hidden, as the first-run card is');
  } finally {
    for (const end of made) end();
    restore();
  }
});

test('Set up Waze reports posts to /setup, then reads the status again, and the button waits while the helper works', async () => {
  const restore = installFakeDom();
  const t = renderTab({ setup: { state: 'not_started', message: 'Waze report setup has not run', updatedAt: null }, post: () => ({ state: 'starting', message: 'Starting Waze setup', updatedAt: NOW }) });
  try {
    await settle();
    t.become({ state: 'starting', message: 'Starting Waze setup', updatedAt: NOW });
    buttonNamed(t.el, 'Set up Waze reports').click();
    await settle();

    assert.deepEqual(t.rec.posts, ['/setup'], 'one POST to the plugin\'s setup route');
    assert.ok(textOf(t.el).includes('Starting Waze setup'), 'the setup message is shown');
    const button = descendants(t.el).find((e) => e.tagName === 'BUTTON' && e.textContent === 'Setting up…');
    assert.ok(button, 'the button now says it is setting up');
    assert.equal(button.disabled, true, 'and is off while the helper works');
  } finally {
    t.end();
    restore();
  }
});

test('a refused setup shows the server\'s message and leaves the button on', async () => {
  const restore = installFakeDom();
  const t = renderTab({
    setup: { state: 'not_started', message: 'Waze report setup has not run', updatedAt: null },
    post: () => { throw new Error('This installation does not include the Waze setup helper'); },
  });
  try {
    await settle();
    buttonNamed(t.el, 'Set up Waze reports').click();
    await settle();

    const alert = descendants(t.el).find((e) => e.getAttribute('role') === 'alert');
    assert.equal(alert?.hidden, false);
    assert.equal(alert?.textContent, 'This installation does not include the Waze setup helper');
    assert.equal(buttonNamed(t.el, 'Set up Waze reports').disabled, false, 'the admin may try again');
    assert.deepEqual(t.rec.requests.filter((p) => p.startsWith('/status')).length, 1, 'no status reload after a refusal');
  } finally {
    t.end();
    restore();
  }
});

test('a finished setup is shown as ready, and a failed one as failed', async () => {
  const restore = installFakeDom();
  const t = renderTab({ setup: { state: 'ready', message: 'Waze police and hazard reports are ready', updatedAt: NOW } });
  try {
    await settle();
    const line = descendants(t.el).find((e) => e.getAttribute('role') === 'status' && e.textContent === 'Waze police and hazard reports are ready');
    assert.ok(line, 'the setup message is the status line in the card');
    assert.equal(line.getAttribute('class'), 'status-line ok');

    t.become({ state: 'failed', message: 'Setup helper could not start', updatedAt: NOW });
    buttonNamed(t.el, 'Test connection').click();
    await settle();
    const failed = descendants(t.el).find((e) => e.getAttribute('role') === 'status' && e.textContent === 'Setup helper could not start');
    assert.ok(failed, 'the failure message is shown');
    assert.equal(failed.getAttribute('class'), 'status-line error');
    assert.equal(buttonNamed(t.el, 'Set up Waze reports').disabled, false, 'a failed setup can be tried again');
  } finally {
    t.end();
    restore();
  }
});
