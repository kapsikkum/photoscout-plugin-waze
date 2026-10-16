import { HEAT_WINDOWS, type HeatWindowStore } from './heat.js';
import { coverageNote, connectionText, setupNeedsPolling, type ActivityLevel } from './status.js';
import type { WazeStatusResponse } from './types.js';

/**
 * The plugin's DOM: the heatmap window selector (the map corner and the Settings tab), the report popup
 * and the Settings tab. Plain elements, no React. Text is set with textContent, never as HTML, because
 * the first-run instructions and the report fields come from outside the app.
 */

const SETUP_POLL_MS = 5000;

type Child = Node | string | false | null | undefined;

/** Build an element. `text` sets its text; every other attribute is set as an attribute. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'text') el.textContent = value;
    else el.setAttribute(name, value);
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

/**
 * The police heatmap's time window as a segmented control. Shows the store's window and follows it, so
 * the corner and the Settings tab stay in step. Returns the cleanup that stops following it.
 */
export function renderRangeSelector(el: HTMLElement, store: HeatWindowStore): () => void {
  const buttons = HEAT_WINDOWS.map((w) => {
    const button = h('button', { type: 'button', text: w.label });
    button.addEventListener('click', () => store.set(w.ms));
    return { ms: w.ms, button };
  });
  const paint = (ms: number): void => {
    for (const { ms: windowMs, button } of buttons) {
      const on = windowMs === ms;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    }
  };
  paint(store.get());
  const release = store.subscribe(paint);
  el.replaceChildren(h('div', { class: 'seg', role: 'group', 'aria-label': 'Police heatmap time window' }, ...buttons.map((b) => b.button)));
  return () => release();
}

/** The report popup: a bold title, then one line each for the street, the description, the time and the source. */
export function reportPopupElement(title: string, lines: readonly string[]): HTMLElement {
  return h('div', {}, h('strong', { text: title }), ...lines.map((text) => h('p', { text })));
}

export interface StatusSettingsDeps {
  isAdmin: boolean;
  fetchStatus(check: boolean): Promise<WazeStatusResponse>;
  activity(message: string, level: ActivityLevel): void;
  windowStore: HeatWindowStore;
}

/**
 * The Police & hazards Settings tab: the harvester's connection, the first-run instructions for an admin
 * (the only place a person can see them), a Test connection button, and the heatmap's time window.
 * While the harvester is still setting itself up, its status is asked again every few seconds.
 */
export function renderStatusSettings(el: HTMLElement, deps: StatusSettingsDeps): () => void {
  let status: WazeStatusResponse | null = null;
  let busy = true;
  let error: string | null = null;
  let alive = true;
  let timer: ReturnType<typeof setInterval> | undefined;

  const statusBox = h('div', { class: 'waze-status-card' });
  const firstRunBox = h('div', { class: 'waze-status-card' });
  firstRunBox.hidden = true;
  const errorLine = h('p', { class: 'status-line error', role: 'alert' });
  errorLine.hidden = true;
  const testButton = h('button', { type: 'button', class: 'primary mt-12', text: 'Test connection' });
  testButton.addEventListener('click', () => void load(true));
  const rangeHost = h('div');
  const releaseRange = renderRangeSelector(rangeHost, deps.windowStore);

  function statusChildren(): Node[] {
    if (!status) return [h('p', { class: 'hint', text: busy ? 'Checking…' : 'Status unavailable' })];
    const conn = connectionText(status, deps.isAdmin);
    const out: Node[] = [
      h('h3', { text: 'Connection' }),
      h('p', { class: conn.tone ? `status-line ${conn.tone}` : 'status-line', text: conn.text }),
    ];
    if (status.checked && status.observedAt) {
      out.push(h('p', { class: 'hint', text: `Last read from Waze: ${new Date(status.observedAt).toLocaleString()}` }));
    }
    const note = coverageNote(status.coverage);
    if (note) out.push(h('p', { class: 'hint', text: note }));
    if (deps.isAdmin && status.setup.message) out.push(h('p', { class: 'hint', text: `Setup: ${status.setup.message}` }));
    return out;
  }

  function paint(): void {
    statusBox.replaceChildren(...statusChildren());
    // The instructions are written only for an admin: a visitor's page never holds them, even hidden.
    const firstRun = deps.isAdmin && status?.setup.state === 'needs_first_run';
    firstRunBox.hidden = !firstRun;
    firstRunBox.replaceChildren(...(firstRun ? [
      h('h3', { text: 'Finish Waze\'s first-run screen' }),
      h('p', { class: 'hint', text: 'Waze shows a welcome screen the first time it runs on this server. Someone with server access completes it once; the result is kept, and reports start after that.' }),
      h('pre', {}, h('code', { text: status?.setup.first_run?.how ?? 'Waze needs its first-run screen completed once. See the harvester README for the steps.' })),
    ] : []));
    errorLine.hidden = error === null;
    errorLine.textContent = error ?? '';
    testButton.disabled = busy;
    testButton.textContent = busy ? 'Checking…' : 'Test connection';
  }

  /** Keep asking while the harvester is still setting itself up, and stop once it is not. */
  function keepPolling(): void {
    const want = status !== null && setupNeedsPolling(status.setup.state);
    if (want && timer === undefined && alive) timer = setInterval(() => void load(false), SETUP_POLL_MS);
    if (!want && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  async function load(check: boolean): Promise<void> {
    if (!alive) return;
    busy = true;
    error = null;
    paint();
    try {
      status = await deps.fetchStatus(check);
      if (check) {
        deps.activity(
          status.liveMapStatus.accessible
            ? `Police and hazards: connected; ${status.alertCount ?? 0} reports returned`
            : 'Police and hazards: not connected; reports unavailable',
          status.liveMapStatus.accessible ? 'success' : 'error',
        );
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Status unavailable';
    }
    busy = false;
    if (!alive) return;
    paint();
    keepPolling();
  }

  el.replaceChildren(
    h('section', {},
      h('h2', { text: '👮 Police & hazards' }),
      h('p', { class: 'hint', text: 'Community reports from Waze: police, crashes, hazards and roadworks. They show on the map when you turn them on, and Drive warns you about nearby ones.' }),
      errorLine,
      firstRunBox,
      statusBox,
      testButton,
      h('div', { class: 'waze-status-card' },
        h('h3', { text: 'Police heatmap time window' }),
        h('p', { class: 'hint', text: 'How far back the heatmap looks. Pick it here, or in the bottom-right corner of the map while the heatmap is on.' }),
        rangeHost),
      h('p', { class: 'hint', text: 'Showing reports sends the map area you look at to Waze. Turn them off on the map or in Drive to stop. Data: Waze / Google.' }),
    ),
  );
  paint();
  void load(false);

  return () => {
    alive = false;
    if (timer !== undefined) clearInterval(timer);
    releaseRange();
  };
}
