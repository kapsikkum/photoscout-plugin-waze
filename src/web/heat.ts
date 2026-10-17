import type { FeatureCollection, Point } from 'geojson';
import type { WazeHeatPoint } from './types.js';

/**
 * The police heatmap's time window: the choices, the default, the GeoJSON, and the one value both the map
 * corner and the Settings tab read and write. Ported from core map/policeHeat.ts.
 */

/** The windows the selector offers. The server clamps any window to one hour to sixty days (the sighting retention). */
export const HEAT_WINDOWS = [
  { label: '1h', ms: 3_600_000 },
  { label: '2h', ms: 7_200_000 },
  { label: '6h', ms: 21_600_000 },
  { label: '24h', ms: 86_400_000 },
  { label: '7d', ms: 604_800_000 },
  { label: '30d', ms: 2_592_000_000 },
  { label: '60d', ms: 5_184_000_000 },
] as const;

export const HEAT_DEFAULT_MS = 7_200_000;

export function heatmapGeoJSON(points: readonly WazeHeatPoint[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: p.point },
      properties: { weight: p.weight },
    })),
  };
}

export interface HeatWindowStore {
  get(): number;
  /** Ignores anything that is not one of `HEAT_WINDOWS`, and says nothing when the value is unchanged. */
  set(ms: number): void;
  subscribe(listener: (ms: number) => void): () => void;
}

export function createHeatWindowStore(initial: number = HEAT_DEFAULT_MS): HeatWindowStore {
  let current = initial;
  const listeners = new Set<(ms: number) => void>();
  return {
    get: () => current,
    set(ms) {
      if (ms === current || !HEAT_WINDOWS.some((w) => w.ms === ms)) return;
      current = ms;
      for (const listener of [...listeners]) listener(ms);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
