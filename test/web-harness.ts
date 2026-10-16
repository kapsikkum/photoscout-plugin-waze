// Test doubles for the web half, for node:test (no DOM, no browser). A fake plugin host records what
// activate() registers and answers the data calls from canned responses; a fake DOM does only the calls the
// views make; a fake map records the layers it is given. Nothing here runs as a test (the glob is *.test.ts).
import type {
  CornerPanelDef, DriveAlertSourceDef, LegendEntry, LegendEntryDef, PluginHost, PollOptions, PluginMapClick, SettingsTabDef,
} from '../src/sdk/web-api.js';

export const PLUGIN_ID = 'map.24thframe.waze';
export const scoped = (name: string): string => `${PLUGIN_ID}:${name}`;

/** A promise that settles after the pending microtasks (the views fetch, then paint). */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A minimal element: the attributes, children, text, classes and click listeners the views use. */
export class FakeEl {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: FakeEl[] = [];
  readonly classes = new Set<string>();
  readonly listeners = new Map<string, Array<() => void>>();
  readonly classList = {
    toggle: (name: string, force?: boolean): boolean => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name);
      else this.classes.delete(name);
      return on;
    },
  };
  hidden = false;
  disabled = false;
  private text = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    this.children.length = 0;
    this.text = value;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === 'class') for (const c of String(value).split(/\s+/)) if (c) this.classes.add(c);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...nodes: FakeEl[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeEl[]): void {
    this.children.length = 0;
    this.text = '';
    this.children.push(...nodes);
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
}

/** The text a view shows, in order. */
export const textOf = (el: FakeEl): string => el.textContent;

/** Everything under `el`, depth first. */
export function descendants(el: FakeEl): FakeEl[] {
  return el.children.flatMap((c) => [c, ...descendants(c)]);
}

/** The first descendant with this tag and text, or throws: a test should not look for what is not there. */
export function buttonNamed(el: FakeEl, text: string): FakeEl {
  const found = descendants(el).find((e) => e.tagName === 'BUTTON' && e.textContent === text);
  if (!found) throw new Error(`no button "${text}" in the view`);
  return found;
}

/** The canvas drawing calls the report icons make: every call is a no-op, and `getImageData` returns a blank image. */
const drawing = new Proxy({} as Record<PropertyKey, unknown>, {
  get: (target, key) => {
    if (key === 'getImageData') return () => ({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) });
    if (key in target) return target[key];
    return () => undefined;
  },
  set: (target, key, value) => {
    target[key] = value;
    return true;
  },
});

class FakeCanvas extends FakeEl {
  width = 0;
  height = 0;
  getContext(): unknown {
    return drawing;
  }
}

/** Install a `document` that makes FakeEl elements. Returns the function that puts the old one back. */
export function installFakeDom(): () => void {
  const g = globalThis as { document?: unknown };
  const before = g.document;
  g.document = { createElement: (tag: string) => (tag === 'canvas' ? new FakeCanvas(tag) : new FakeEl(tag)) };
  return () => {
    if (before === undefined) delete g.document;
    else g.document = before;
  };
}

export interface LayerSpec {
  id: string;
  type: string;
  source?: string;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
}

/** The slice of the maplibre Map the plugin uses: sources, layers, images, and GeoJSON data per source. */
export class FakeMap {
  readonly sources = new Map<string, { data: unknown }>();
  readonly layers: LayerSpec[] = [];
  readonly images: string[] = [];

  addSource(id: string, spec: { data?: unknown }): void {
    this.sources.set(id, { data: spec.data });
  }

  addLayer(spec: LayerSpec): void {
    this.layers.push(spec);
  }

  addImage(id: string): void {
    this.images.push(id);
  }

  getSource(id: string): { setData(data: unknown): void } | undefined {
    const source = this.sources.get(id);
    if (!source) return undefined;
    return { setData: (data: unknown) => { source.data = data; } };
  }

  /** The features a GeoJSON source holds now. */
  features(id: string): Array<{ id?: unknown; properties?: Record<string, unknown> }> {
    const data = this.sources.get(id)?.data as { features?: unknown[] } | undefined;
    return (data?.features ?? []) as Array<{ id?: unknown; properties?: Record<string, unknown> }>;
  }
}

export interface PollRecord {
  options: PollOptions<unknown>;
  refreshes: number;
  stopped: boolean;
}

export interface Recorded {
  legend: LegendEntryDef[];
  entries: Record<string, LegendEntry>;
  corners: CornerPanelDef[];
  tabs: SettingsTabDef[];
  driveSources: DriveAlertSourceDef[];
  ready: Array<(map: FakeMap) => void | (() => void)>;
  clicks: Array<{ layers: readonly string[]; cb: (e: PluginMapClick) => void }>;
  polls: PollRecord[];
  requests: string[];
  activity: Array<{ message: string; level: string | undefined }>;
  popups: Array<{ content: unknown }>;
}

/** A fake PluginHost, and what it recorded. `respond` answers each data request by its path. */
export function fakeHost(respond: (path: string) => unknown): { host: PluginHost; rec: Recorded } {
  const rec: Recorded = {
    legend: [], entries: {}, corners: [], tabs: [], driveSources: [], ready: [], clicks: [], polls: [],
    requests: [], activity: [], popups: [],
  };
  const host = {
    id: PLUGIN_ID,
    name: 'Waze police & hazards',
    version: '1.0.0',
    apiVersion: '1.0.0',
    user: null,
    map: {
      current: null,
      scopedId: scoped,
      onReady: (cb: (map: FakeMap) => void | (() => void)) => {
        rec.ready.push(cb);
        return () => undefined;
      },
      onClick: (layers: readonly string[], cb: (e: PluginMapClick) => void) => {
        rec.clicks.push({ layers, cb });
        return () => undefined;
      },
      showPopup: (_at: unknown, content: unknown) => {
        rec.popups.push({ content });
        return { close: () => undefined };
      },
    },
    legend: {
      add: (def: LegendEntryDef): LegendEntry => {
        rec.legend.push(def);
        const entry: LegendEntry = {
          key: def.key, on: false, setOn: () => undefined, toggle: () => undefined,
          onChange: () => () => undefined, syncLayers: () => undefined,
        };
        rec.entries[def.key] = entry;
        return entry;
      },
    },
    settings: {
      addTab: (def: SettingsTabDef) => {
        rec.tabs.push(def);
        return () => undefined;
      },
    },
    panel: {
      addCorner: (def: CornerPanelDef) => {
        rec.corners.push(def);
        return () => undefined;
      },
    },
    drive: {
      addAlertSource: (def: DriveAlertSourceDef) => {
        rec.driveSources.push(def);
        return () => undefined;
      },
    },
    data: {
      url: (path: string) => `/api/plugins/${PLUGIN_ID}${path}`,
      json: async (path: string) => {
        rec.requests.push(path);
        return respond(path);
      },
      poll: (options: PollOptions<unknown>) => {
        const record: PollRecord = { options, refreshes: 0, stopped: false };
        rec.polls.push(record);
        return {
          refresh: () => { record.refreshes += 1; },
          stop: () => { record.stopped = true; },
        };
      },
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    activity: (message: string, level?: string) => {
      rec.activity.push({ message, level });
    },
  };
  return { host: host as unknown as PluginHost, rec };
}
