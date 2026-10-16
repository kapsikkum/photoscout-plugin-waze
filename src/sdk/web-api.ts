// Vendored from @photoscout/plugin-sdk 2.0.0 (src/web.ts). Do not edit: re-copy with plugin.mjs sdk-check --write.
/**
 * The PhotoScout web plugin API: the contract between the SPA ("the host") and
 * the web bundle of a plugin.
 *
 * THIS FILE IS DOCUMENTATION AS MUCH AS CODE. It is self-contained on purpose:
 * it imports only the *types* of maplibre-gl, react and geojson, and has no
 * runtime dependencies on the app. It is the canonical source of the contract,
 * in `@photoscout/plugin-sdk/web`; the app re-exports it from
 * web/src/plugins/api.ts. A plugin bundle should import from the SDK (or from
 * its vendored copy) and nothing else from the app.
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

/**
 * The web API version this file describes, reported to bundles as `host.apiVersion`.
 * Semver: a minor adds, a major breaks. It moves on its own: the server's HOST_API_VERSION
 * (what a manifest's `photoscout` range is checked against) covers the server contract and
 * the manifest, and the two are bumped independently. A bundle that needs a feature should
 * check `host.apiVersion`. The manifest cannot state a web range. See docs/plugins/web-api-design.md, "Versions".
 */
export const WEB_API_VERSION = '2.0.0';

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
   * A small widget stacked in the map's bottom-right corner (like a time-window
   * picker). Shown on the map page while its legend entry is on.
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

/** What a source's status line says. Shown under the banner while the source is on. */
export interface DriveStatus {
  /**
   * `waiting`: queued, nothing fetched yet. `checking`: a fetch is in flight.
   * `stale`: showing older data while it refreshes. `error`: the data cannot be had.
   * `ok`: all fine; the host shows nothing for it, the same as `null`.
   */
  state: 'waiting' | 'checking' | 'stale' | 'error' | 'ok';
  /** Short plain text, e.g. "Checking reports for this area…". Never a URL or a raw error body. */
  text: string;
}

/** The car's latest GPS fix, as the Drive screen holds it. */
export interface DriveFix {
  /** `[lng, lat]` of the fix. */
  point: LngLat;
  /** Metres: the radius the device is 68% sure it is within. Smaller is better. */
  accuracyM: number;
  /** Milliseconds since the device reported the fix, measured when `fix()` is called. */
  ageMs: number;
}

export interface DriveSpeakOptions {
  /**
   * Speak each key once per drive. Call again with the same key on every poll and
   * the host stays quiet after the first time. Use the alert id.
   */
  key?: string;
}

/**
 * Why `speak()` said nothing. The host checks in this order:
 *
 * - `stopped`: the source has stopped (its drive ended, or the driver turned it off).
 * - `not-driving`: no drive is on.
 * - `duplicate`: this `key` was already said this drive.
 * - `voice-off`: the Voice button is off, or the browser cannot speak.
 * - `no-fix`: there is no GPS fix yet.
 * - `stale`: the fix is older than `tuning.speakMaxAgeMs`.
 * - `inaccurate`: the fix is looser than `tuning.speakMaxAccuracyM`.
 */
export type SpeakRefusal = 'stopped' | 'not-driving' | 'duplicate' | 'voice-off' | 'no-fix' | 'stale' | 'inaccurate';

/** What `speak()` returns. It is always an object, so test `spoken`; a bare truthiness check is always true. */
export type SpeakResult = { spoken: true } | { spoken: false; reason: SpeakRefusal };

/**
 * How the host judges a source's alerts and speech. Every option is optional, and each
 * default is the host's own rule, so a source that sets none gets the standard Drive
 * behaviour. An option name not listed here, or a value outside its range, makes
 * `addAlertSource` throw.
 */
export interface DriveTuning {
  /** `'nearby'` alerts: the banner shows one only within this many metres of the car, in a straight line. Default 800. Range 1–10 000. */
  nearbyM?: number;
  /** The car must be within this many metres of the route for `routeAhead()` to answer, and for a `'route-ahead'` alert to reach the banner. Default 100. Range 1–1 000. */
  onRouteM?: number;
  /** How far along the route ahead an alert still counts, in metres. Default 1500. Range 1–20 000. */
  aheadM?: number;
  /** How far a point may sit from the road line and still count as on it, in metres. Default 45. Range 1–500. */
  offRoadM?: number;
  /** `speak()`: the oldest GPS fix that may speak, in milliseconds. Default 10 000. Range 1 000–60 000. */
  speakMaxAgeMs?: number;
  /** `speak()`: the loosest GPS fix that may speak, as accuracy in metres. Default 75. Range 1–500. */
  speakMaxAccuracyM?: number;
}

/** An image for `addImage`: anything maplibre's `Map.addImage` takes, metadata included (pixelRatio, sdf, stretch). */
export type DriveImage = Parameters<MapLibreMap['addImage']>[1];

/**
 * Which reported alerts reach the banner. `nearby`: within `tuning.nearbyM` of the car in a
 * straight line (the original behaviour). `route-ahead`: only the alerts `routeAhead()` accepts,
 * nearest along the route; nothing without a route.
 */
export type DriveAlertFilter = 'nearby' | 'route-ahead';

export interface DriveSourceContext {
  /**
   * The Drive screen's map, already loaded. Add layers and sources only with ids from
   * `scopedId`, images only through `addImage`, and declare pins with `mapLayers`.
   */
  map: MapLibreMap;
  /**
   * The car's latest GPS fix, or null before the first. It carries the accuracy and the age,
   * so a source can make its own staleness calls.
   */
  fix(): DriveFix | null;
  /**
   * The route being followed: the `[lng, lat]` line the Drive screen draws, from the
   * start to the destination, or null when no navigation is under way. It changes on
   * a reroute, so read it when you need it rather than keeping it.
   */
  route(): readonly LngLat[] | null;
  /**
   * The way the car is pointing, in degrees clockwise from north (0 = north, 90 = east).
   * Null until the car has moved faster than about 5 km/h; after that it holds while the
   * car is stopped. It is the heading the Drive map turns to.
   */
  heading(): number | null;
  /**
   * Metres along the route from the car to `point`, when `point` is on the road ahead;
   * otherwise null. Null when there is no route or no fix, when the car is more than
   * `tuning.onRouteM` from the route, when `point` is behind the car, more than
   * `tuning.aheadM` ahead, or more than `tuning.offRoadM` from the road.
   */
  routeAhead(point: LngLat): number | null;
  /** Replace this source's alerts. Call whenever your data changes; `[]` clears. */
  report(alerts: readonly DriveAlert[]): void;
  /** Show a status line under the banner while the source is on. `null` clears it. */
  setStatus(status: DriveStatus | null): void;
  /**
   * Say `text` in the Drive voice. Returns `{ spoken: true }`, or `{ spoken: false, reason }`
   * when nothing was said (see `SpeakRefusal`). A new prompt cuts off one still being read.
   * The host gates it with the Voice button, the GPS fix (at most `tuning.speakMaxAgeMs` old
   * and at most `tuning.speakMaxAccuracyM` loose) and `opts.key`, which is said once per drive.
   * What to say, and when, is the source's call: the host only gates and dedupes.
   */
  speak(text: string, opts?: DriveSpeakOptions): SpeakResult;
  /**
   * Add an image to the Drive map's style under `scopedId(name)`, and return that id for use
   * as an `icon-image`. Adding a name again replaces the image. The image is removed when the
   * source stops, or by `removeImage`.
   */
  addImage(name: string, image: DriveImage): string;
  /** Remove an image this source added. Images are removed for you when the source stops. */
  removeImage(name: string): void;
  /**
   * Show a popup on the Drive map, as `host.map.showPopup` does on the main map. A string is
   * shown as text, never as HTML. One popup per source: showing another closes the first. A
   * click on the map closes it too, and so does the source stopping.
   */
  showPopup(at: LngLat, content: string | HTMLElement): PopupHandle;
  /**
   * An id for a layer or source on the Drive map: `<pluginId>:<sourceId>:<name>`. The host
   * removes every layer, source and image with that prefix when the source stops (the drive
   * ends, or the driver turns the source off).
   */
  scopedId(name: string): string;
  /**
   * Declare layers you added to `map` for this source (your report pins). A tap that
   * lands on one of them goes to `onTap` and never picks a destination on the Drive
   * screen. The layers are removed when the source stops.
   * Each call declares more layers; the returned function stops the tap ownership
   * only (the layers stay until the source stops).
   */
  mapLayers(layerIds: readonly string[], opts?: { onTap?(tap: PluginMapClick): void }): Unsubscribe;
}

export interface DriveAlertSourceDef {
  /** Unique within your plugin. */
  id: string;
  label: string;
  /** Tooltip on the source's on/off button in Drive. */
  title?: string;
  /** Whether the source starts on. Default true, like core's "Reports on". */
  defaultOn?: boolean;
  /** Which of its alerts reach the banner. Default `'nearby'`. */
  filter?: DriveAlertFilter;
  /**
   * When the source runs. `'drive'` (default): only while a drive is on.
   * `'always'`: from the moment the Drive screen has its map, so its pins
   * and status line show while the driver is planning. Its
   * banner alerts show, and `speak` says nothing, only while a drive is on.
   */
  runs?: 'drive' | 'always';
  /** The host's rules for this source's banner and speech. See `DriveTuning`. */
  tuning?: DriveTuning;
  /**
   * Start feeding alerts. Return a cleanup. The host starts the source as `runs` says
   * and while it is on; it runs the cleanup when the source stops (the drive ends, the
   * driver turns it off, or the Drive screen closes), and calls `start` again when it is
   * turned back on.
   */
  start(ctx: DriveSourceContext): void | (() => void);
}

export interface DriveApi {
  /**
   * Feed the Drive screen: alerts for the banner, a status line, spoken warnings, an
   * on/off button and pins on the Drive map. Each source receives a `DriveSourceContext`
   * (see it for every member):
   *
   * - Banner: the nearest alert that passes the source's `filter`, judged by its `tuning`.
   * - Route and heading: `route()`, `heading()` and `routeAhead()`.
   * - Voice: `speak()`, which the Drive Voice button mutes.
   * - On/off: a button per source, `defaultOn` at the start, like "Reports on/off".
   * - Status: `setStatus()`, shown under the banner.
   * - Map: `map`, `scopedId()`, `addImage()`, `mapLayers()` (taps on your pins are yours) and `showPopup()`.
   *
   * A source that sets no `tuning` gets the host's own rules: the nearest alert within
   * 800 m of the car is shown, and speech needs a fix at most 10 s old and 75 m loose.
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
 * The cadence: the first poll runs at once; then every
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
