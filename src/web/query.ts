import type { Bbox } from '../sdk/web-api.js';

/**
 * The plugin's routes, relative to its base (`/api/plugins/map.24thframe.waze`). The host adds the base:
 * `host.data.json(path)` only accepts a path that starts with one `/`.
 */

/** The four bbox parameters every map route takes. */
export function boxParams(bbox: Bbox): string {
  return `minLng=${bbox.minLng}&minLat=${bbox.minLat}&maxLng=${bbox.maxLng}&maxLat=${bbox.maxLat}`;
}

/** Reports in a box. Drive asks with `navigation`, which the server honours for signed-in people only. */
export function alertsPath(bbox: Bbox, priority: 'map' | 'navigation' = 'map'): string {
  return `/alerts?${boxParams(bbox)}&priority=${priority}`;
}

/** Police sightings in a box over a window, in ms. The server clamps it to one hour to seven days. */
export function heatmapPath(bbox: Bbox, windowMs: number): string {
  return `/heatmap?${boxParams(bbox)}&windowMs=${windowMs}`;
}

/** Harvester status. `check` asks the harvester now (the Test connection button). */
export function statusPath(check: boolean): string {
  return check ? '/status?check=1' : '/status';
}
