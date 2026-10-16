// Vendored copy of web/src/plugins/api.ts from PhotoScout (the web plugin contract, WEB_API_VERSION 1.0.0).
// A copy pending the @photoscout/plugin-sdk package: the types and the definePlugin helper only. Do not edit
// it here; re-copy it from the PhotoScout repository when the web API changes.
/**
 * The PhotoScout web plugin API: the contract between the SPA ("the host") and
 * the web bundle of a plugin.
 *
 * THIS FILE IS DOCUMENTATION AS MUCH AS CODE. It is self-contained on purpose:
 * it imports only the *types* of maplibre-gl, react and geojson, and has no
 * runtime dependencies on the app, so it can move into the
 * `@photoscout/plugin-sdk` package later without edits. A plugin bundle should
 * `import type` from here (or from the SDK) and import nothing else from the app.
 *
 * ## What a web bundle is
 *
 * A plugin whose manifest has `"web": "web.js"` ships an ES module at that path.
 * While the plugin is running, the server lists it at `GET /api/plugins-web` and
 * serves it from `/plugins/<id>/<version>/web.js`. The SPA `import()`s it once
 * per page load and calls `activate(host)` on its default export:
 *
 *     import { definePlugin } from '@photoscout/plugin-sdk/web';
 *
 *     export default definePlugin({
 *       activate(host) {
 *         const stations = host.legend.add({
 *           key: 'stations', label: 'Stations', swatch: { kind: 'dot', color: '#10b981' },
 *           layers: [host.map.scopedId('points')],
 *         });
 *         host.map.onReady((map) => {
 *           map.addSource(host.map.scopedId('src'), { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
 *           map.addLayer({ id: host.map.scopedId('points'), type: 'circle', source: host.map.scopedId('src'), paint: { 'circle-radius': 6 } });
 *           host.data.poll({ map, while: stations, fetch: ({ signal }) => host.data.json('/places', { signal }), onData: (d) => { ... } });
 *         });
 *         host.map.onClick([host.map.scopedId('points')], (e) => host.map.showPopup(e.lngLat, 'Hello'));
 *         host.settings.addTab({ id: 'main', label: 'Stations', render: (el) => { el.textContent = 'Settings'; } });
 *       },
 *     });
 *
 * ## Lifecycle
 *
 * 1. `activate(host)` runs once per page load, after the SPA knows who is signed in.
 *    Register every contribution here, synchronously if you can. If it throws or
 *    rejects, every contribution made so far is rolled back and the plugin is
 *    marked failed; the app carries on without it.
 * 2. `host.map.onReady` callbacks run each time a map page mounts (once its style
 *    has loaded) and again for each later mount. The cleanup they return runs when
 *    that map is removed. Layers and sources belong to the map instance: add them
 *    inside `onReady`, never at `activate` time.
 * 3. `deactivate()` runs when the host disposes the plugin (tests, hot reload).
 *    Everything registered through `host` is removed automatically; use it only for
 *    state the host cannot see (your own timers, sockets).
 *
 * ## Rules of the road
 *
 * - Every host callback you give is invoked inside a try/catch. A throw is logged
 *   (console + the Activity panel) and does not break the app or other plugins.
 * - Ids you choose (`key`, `id`) are lowercase letters, digits and hyphens. The
 *   host namespaces them with your plugin id, so two plugins cannot collide.
 * - Prefer the helpers on `host` over reaching for globals. You do get the raw
 *   maplibre `Map` in `onReady` and a React instance in `host.ui.react`; those are
 *   deliberate escape hatches (see "Trust" in docs/plugins/web-api-design.md).
 */

import type { Feature } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type * as React from 'react';

/** The web API version this file describes. Semver: a minor adds, a major breaks. */
export const WEB_API_VERSION = '1.0.0';

/** Stops a subscription or removes a contribution. Safe to call twice. */
export type Unsubscribe = () => void;

/** `[longitude, latitude]`, as GeoJSON and maplibre order them. */
export type LngLat = [lng: number, lat: number];

/** A view box in degrees, already clamped to the world (what the server's bbox routes expect). */
export interface Bbox {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

// ---------------------------------------------------------------------------
// The module a bundle exports
// ---------------------------------------------------------------------------

/**
 * What a web bundle default-exports. An object (not a bare function) so the
 * shape mirrors the server's `definePlugin({ activate, deactivate })` and can
 * grow fields without breaking bundles.
 */
export interface WebPlugin {
  /** Register contributions. May be async; the host waits up to 10 seconds. */
  activate(host: PluginHost): void | Promise<void>;
  /** Release anything the host cannot see. Contributions made through `host` are removed for you. */
  deactivate?(): void | Promise<void>;
}

/** Identity function that types a plugin. Exists so a bundle gets inference without annotations. */
export function definePlugin(plugin: WebPlugin): WebPlugin {
  return plugin;
}

// ---------------------------------------------------------------------------
// Views: how a plugin draws UI into a slot the host owns
// ---------------------------------------------------------------------------

/**
 * Draw into `el`. Called when the view appears and again whenever `props`
 * change; the cleanup you return runs before each re-render and when the view
 * goes away. Treat `el` as yours: replace its children each time.
 *
 * Framework-free on purpose, so a plugin needs no UI library at all.
 */
export type RenderFn<P> = (el: HTMLElement, props: P) => void | (() => void);

/**
 * A slot is filled either by a render function or by a React component. A
 * component is rendered by the host's own React (use `host.ui.react` to build
 * it: a second copy of React in your bundle would break hooks).
 */
export type ViewSpec<P> =
  | { render: RenderFn<P>; component?: never }
  | { component: React.ComponentType<P>; render?: never };

// ---------------------------------------------------------------------------
// Settings tabs
// ---------------------------------------------------------------------------

/** Where a plugin tab sits in the Settings side menu. The core groups (You, Admin) are not open to plugins. */
export type SettingsGroup = 'Map' | 'Events' | 'Plugins';

export interface SettingsTabProps {
  /** Whether the person looking at the tab is an admin. */
  isAdmin: boolean;
}

export type SettingsTabDef = {
  /** Unique within your plugin. The tab's URL hash is `#<pluginId>:<id>`. */
  id: string;
  label: string;
  /** Default 'Plugins'. */
  group?: SettingsGroup;
  /**
   * Default true: only admins see the tab. Set false for a tab every signed-in
   * or anonymous visitor may open (the server still enforces who can call your routes).
   */
  admin?: boolean;
} & ViewSpec<SettingsTabProps>;

// ---------------------------------------------------------------------------
// Legend (the layer toggles)
// ---------------------------------------------------------------------------

export type SwatchKind = 'dot' | 'line' | 'dashed' | 'fill' | 'ring' | 'glyph' | 'text';

export interface LegendSwatch {
  kind: SwatchKind;
  /** A CSS colour (hex, rgb(), hsl(), a named colour, or a gradient). `url(...)` is refused. */
  color: string;
  /** The character a `glyph` swatch draws, e.g. an emoji. */
  glyph?: string;
}

export interface LegendEntryDef {
  /** Unique within your plugin. */
  key: string;
  label: string;
  /** Tooltip on the legend row and toolbar item. */
  title?: string;
  swatch: LegendSwatch;
  /** The state before the person has chosen. Default false. A saved choice wins. */
  defaultOn?: boolean;
  /** Which toolbar dropdown also lists the toggle. Default 'live'. */
  menu?: 'live' | 'scout';
  /**
   * Map layer ids shown while the entry is on and hidden while it is off. The
   * host sets their `visibility` layout property: when the map is ready (after
   * your `onReady` callbacks), on every toggle, and on `syncLayers()`. Ids that
   * do not exist yet are skipped.
   */
  layers?: readonly string[];
}

/** The live handle to one legend toggle. */
export interface LegendEntry {
  readonly key: string;
  /** Whether the toggle is on right now. */
  readonly on: boolean;
  setOn(on: boolean): void;
  toggle(): void;
  /** Called when the person (or `setOn`) flips the toggle. Use it to start and stop work. */
  onChange(cb: (on: boolean) => void): Unsubscribe;
  /** Re-apply visibility to `layers`. Call after adding layers lazily, outside `onReady`. */
  syncLayers(): void;
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

/** A click that landed on one of the layers a handler asked about. */
export interface PluginMapClick {
  lngLat: LngLat;
  /** Pixel position inside the map container. */
  point: { x: number; y: number };
  /** Rendered features of your layers under the click, topmost first. */
  features: Feature[];
  /** The layer of `features[0]`. */
  layerId: string;
  map: MapLibreMap;
}

export interface PopupHandle {
  close(): void;
}

export interface MapApi {
  /** The live map, or null while no map page is open. Prefer `onReady`. */
  readonly current: MapLibreMap | null;
  /**
   * Run `cb` with the live map once its style has loaded, now if it already has,
   * and again for every map page that mounts later. Return a cleanup (remove
   * listeners, stop polls); it runs when that map is removed. Add sources, layers
   * and images here.
   */
  onReady(cb: (map: MapLibreMap) => void | (() => void)): Unsubscribe;
  /** `"<pluginId>:<name>"`: use for every source, layer and image id you add so you cannot clash with core or other plugins. */
  scopedId(name: string): string;
  /**
   * Run `cb` when the map is clicked on one of `layers`. Not called while the map
   * is in an editing mode (drawing a route, picking a spot). A click on empty
   * map closes any side panel (see `panel.addSide`) before handlers run.
   */
  onClick(layers: readonly string[], cb: (e: PluginMapClick) => void): Unsubscribe;
  /**
   * Show a popup. A string is shown as text (never as HTML); pass an element to
   * build richer content. One popup per plugin: showing another closes the first.
   */
  showPopup(at: LngLat, content: string | HTMLElement): PopupHandle;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export type SheetSize = 'peek' | 'half';

export type CornerPanelDef = {
  /** Unique within your plugin. */
  id: string;
  /** Show only while this legend entry (`LegendEntry.key`) is on. Omit to show always. */
  whileOn?: string;
} & ViewSpec<Record<string, never>>;

export interface SidePanelProps<T> {
  /** What was passed to `open`. */
  data: T;
  close(): void;
  /** On a phone the panel is a bottom sheet that is either peeking or half-height. */
  size: SheetSize;
  toggleSize(): void;
}

export type SidePanelDef<T> = {
  /** Unique within your plugin. */
  id: string;
  /** Accessible name of the panel. */
  label: string;
} & ViewSpec<SidePanelProps<T>>;

export interface SidePanelHandle<T> {
  readonly isOpen: boolean;
  /** Open (or re-render with new data). Closes core panels and other plugins' side panels. */
  open(data: T): void;
  close(): void;
}

export interface PanelApi {
  /**
   * A small widget stacked in the map's bottom-right corner (like the police
   * heatmap's time-window control). Shown on the map page while its legend entry is on.
   */
  addCorner(def: CornerPanelDef): Unsubscribe;
  /**
   * A details panel on the map's right edge (like the Radio stations list). The
   * host draws the frame (grab handle, close button) and mounts your view inside.
   * At most one side panel is open at a time.
   */
  addSide<T>(def: SidePanelDef<T>): SidePanelHandle<T>;
}

// ---------------------------------------------------------------------------
// Drive mode
// ---------------------------------------------------------------------------

/** One thing worth telling a driver about, at a place. */
export interface DriveAlert {
  /** Stable across polls so a repeat is not announced twice. */
  id: string;
  point: LngLat;
  /** Short, e.g. "Police reported". */
  title: string;
  /** A second line, e.g. the street. */
  detail?: string;
  /** One emoji or character drawn beside the title. */
  glyph?: string;
}

export interface DriveSourceContext {
  /** The Drive screen's map, already loaded. */
  map: MapLibreMap;
  /** The car's latest position, or null before the first GPS fix. */
  position(): LngLat | null;
  /** Replace this source's alerts. Call whenever your data changes; `[]` clears. */
  report(alerts: readonly DriveAlert[]): void;
}

export interface DriveAlertSourceDef {
  /** Unique within your plugin. */
  id: string;
  label: string;
  /** Start feeding alerts for one Drive session. Return a cleanup. */
  start(ctx: DriveSourceContext): void | (() => void);
}

export interface DriveApi {
  /**
   * Feed the Drive screen alerts to show beside the route banner. The host starts
   * each source when a drive begins (navigation is under way) and runs its
   * cleanup when it ends.
   *
   * Wired minimally: the nearest alert within 800 m of the car (straight line)
   * is shown. Not yet wired (TODO): route-ahead filtering, spoken warnings,
   * map icons, an on/off button. The types are the stable part.
   */
  addAlertSource(def: DriveAlertSourceDef): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * What `data.json` throws on a non-2xx answer. A type, not a class, so a bundle
 * never ships its own copy: test with `typeof err.status === 'number'`, not `instanceof`.
 */
export interface PluginHttpError extends Error {
  readonly name: 'PluginHttpError';
  readonly status: number;
}

export interface PollContext {
  /** Aborted when this request is superseded or polling stops. Pass it to `fetch`. */
  signal: AbortSignal;
  /** The map's view, clamped to the world; null if no `map` was given or the view is degenerate. */
  bounds: Bbox | null;
}

export interface PollOptions<T> {
  /** Poll for this map's view: gives `bounds` to `fetch` and (with `refreshOnMove`) re-polls after it moves. Polling stops if the map is removed. */
  map?: MapLibreMap | null;
  /** Poll only while this legend entry is on; polling stops (and `onStop` runs) when it turns off. */
  while?: LegendEntry;
  /** Default 30 000 ms, the cadence of the core feeds. */
  intervalMs?: number;
  /** Re-poll 600 ms after the map stops moving. Default false. Needs `map`. */
  refreshOnMove?: boolean;
  fetch(ctx: PollContext): Promise<T>;
  onData(data: T): void;
  /** Called on a failed poll (not on an abort). */
  onError?(err: unknown): void;
  /** Poll again sooner than `intervalMs`, e.g. while the server says it is still scanning. Return null for the normal cadence. */
  retryAfterMs?(data: T): number | null;
  /** Polling stopped (toggled off, `stop()`, map removed). Clear what you drew. */
  onStop?(): void;
}

export interface PollHandle {
  /** Poll now (still honours the 5 s minimum gap). */
  refresh(): void;
  stop(): void;
}

/**
 * The cadence matches the core Waze feed: the first poll runs at once; then every
 * `intervalMs`; never while the tab is hidden; at most one request per 5 s; a newer
 * request aborts the one in flight and its answer is dropped if it arrives late.
 */
export interface DataApi {
  /** Absolute path of one of your plugin's routes: `/api/plugins/<id>/<path>`. Use for `<audio src>` and the like. */
  url(path: string): string;
  /** `fetch` scoped to `/api/plugins/<id>/`. `path` must start with a single `/` and contain no `..` segment (else it throws), so it cannot be pointed at the core's or another plugin's routes. Sends the session cookie. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** `fetch` + JSON. Throws `PluginHttpError` (with the server's `error` message) on non-2xx. */
  json<T>(path: string, init?: RequestInit): Promise<T>;
  poll<T>(options: PollOptions<T>): PollHandle;
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

export type PluginRole = 'admin' | 'moderator' | 'contributor';

export interface PluginUser {
  id: string;
  username: string;
  role: PluginRole;
}

export interface PluginHost {
  /** The plugin's id from its manifest, e.g. "media.24thframe.radio-garden". */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** `WEB_API_VERSION` of the running SPA. */
  readonly apiVersion: string;
  /** Who is signed in right now (a getter: it changes on sign-in and sign-out), or null for a visitor. */
  readonly user: PluginUser | null;

  readonly map: MapApi;
  readonly legend: {
    /** Add a toggle to the Legend panel and the map toolbar. Throws on a duplicate `key`. */
    add(def: LegendEntryDef): LegendEntry;
  };
  readonly settings: {
    /** Add a tab to Settings. Throws on a duplicate `id`. */
    addTab(def: SettingsTabDef): Unsubscribe;
  };
  readonly panel: PanelApi;
  readonly drive: DriveApi;
  readonly data: DataApi;

  /** `/plugins/<id>/<version>/assets/<path>`: a file from your package's `assets/` folder. */
  assetUrl(path: string): string;

  readonly ui: {
    /** The host's React. Build `component` views with this, not with your own copy. */
    readonly react: typeof React;
  };

  /** Developer log: console only, prefixed with the plugin id. */
  readonly log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  /**
   * A line for the person in the Activity panel (service name = your plugin's
   * name). Keep it short and plain. Never put URLs, tokens or response bodies in it.
   */
  activity(message: string, level?: 'info' | 'success' | 'warning' | 'error'): void;
}
