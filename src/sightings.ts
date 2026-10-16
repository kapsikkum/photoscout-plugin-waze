/**
 * Police reports the harvester has shown us, kept for the heatmap. Ported from the
 * waze_police_sightings table and helpers in PhotoScout server/src/db.ts, now in the
 * plugin's own SQLite file (ctx.db) instead of the core database.
 */
import type { DatabaseSync } from 'node:sqlite';

/** How long a police report is kept. The heatmap's widest window is the same length. */
export const SIGHTING_RETENTION_MS = 604800000;

// One row per report id: seeing it again moves last_seen on, and nothing else is kept.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS waze_police_sightings (
  id TEXT PRIMARY KEY,
  lng REAL NOT NULL,
  lat REAL NOT NULL,
  subtype TEXT,
  thumbs_up INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_waze_police_sightings_last_seen ON waze_police_sightings(last_seen);
`;

/** Create the table if it is missing. Safe to call on every activation. */
export function openSightings(db: DatabaseSync): void {
  db.exec(SCHEMA);
}

export interface SightingInput { id: string; point: [number, number]; subType?: string; thumbsUp?: number }

/** Remember police reports, keyed by the harvester's id. The caller passes POLICE reports only. */
export function recordPoliceSightings(db: DatabaseSync, alerts: readonly SightingInput[], now: number): void {
  if (alerts.length === 0) return;
  const upsert = db.prepare(`INSERT INTO waze_police_sightings (id, lng, lat, subtype, thumbs_up, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, thumbs_up = MAX(thumbs_up, excluded.thumbs_up), subtype = excluded.subtype`);
  db.exec('BEGIN');
  try {
    for (const alert of alerts) upsert.run(alert.id, alert.point[0], alert.point[1], alert.subType ?? null, Math.floor(alert.thumbsUp ?? 0), now, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface HeatPoint { point: [number, number]; weight: number }

/**
 * Reports inside `bbox` seen within `windowMs`, as heatmap points. Each weighs
 * more for thumbs-up and fades to nothing at the window's edge. The newest
 * 5000 rows are read, and anything weighing nothing is dropped.
 */
export function queryPoliceHeatmap(db: DatabaseSync, bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number }, windowMs: number, now: number): HeatPoint[] {
  if (!(windowMs > 0)) return [];
  const rows = db.prepare(`SELECT lng, lat, thumbs_up, last_seen FROM waze_police_sightings
    WHERE last_seen >= ? AND lng >= ? AND lng <= ? AND lat >= ? AND lat <= ?
    ORDER BY last_seen DESC LIMIT 5000`).all(now - windowMs, bbox.minLng, bbox.maxLng, bbox.minLat, bbox.maxLat) as
    { lng: number; lat: number; thumbs_up: number; last_seen: number }[];
  const points: HeatPoint[] = [];
  for (const row of rows) {
    const weight = (1 + row.thumbs_up) * Math.max(0, 1 - Math.max(0, now - row.last_seen) / windowMs);
    if (weight > 0) points.push({ point: [row.lng, row.lat], weight });
  }
  return points;
}

/** Forget police reports not seen for longer than maxMs. Returns how many were forgotten. */
export function prunePoliceSightings(db: DatabaseSync, now: number, maxMs: number): number {
  return Number(db.prepare('DELETE FROM waze_police_sightings WHERE last_seen < ?').run(now - maxMs).changes);
}
