// Ported from PhotoScout server/test/wazeHeatmap.test.ts, against the plugin's own database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openSightings, prunePoliceSightings, queryPoliceHeatmap, recordPoliceSightings, SIGHTING_RETENTION_MS } from '../src/sightings.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const box = { minLng: 151.0, minLat: -34.0, maxLng: 151.5, maxLat: -33.5 };
const weightAt = (points: { point: [number, number]; weight: number }[], lng: number, lat: number) =>
  points.find(p => p.point[0] === lng && p.point[1] === lat)?.weight;

function fresh(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  openSightings(db);
  return db;
}

test('recorded police reports come back weighted by thumbs-up and by how recently they were seen', () => {
  const db = fresh();
  recordPoliceSightings(db, [{ id: 'a', point: [151.2, -33.9], thumbsUp: 2 }], NOW - HOUR);
  recordPoliceSightings(db, [{ id: 'b', point: [151.3, -33.7] }], NOW - HOUR);
  const points = queryPoliceHeatmap(db, box, 2 * HOUR, NOW);
  assert.equal(points.length, 2);
  assert.equal(weightAt(points, 151.2, -33.9), 1.5, '(1 + 2 thumbs) x (1 - 1h/2h)');
  assert.equal(weightAt(points, 151.3, -33.7), 0.5, '(1 + 0) x (1 - 1h/2h)');
});

test('weight fades with age; reports outside the window, the box or at its edge are left out', () => {
  const db = fresh();
  recordPoliceSightings(db, [{ id: 'fresh', point: [151.1, -33.9] }], NOW);
  recordPoliceSightings(db, [{ id: 'hour', point: [151.2, -33.9] }], NOW - HOUR);
  recordPoliceSightings(db, [{ id: 'edge', point: [151.25, -33.9] }], NOW - 2 * HOUR);
  recordPoliceSightings(db, [{ id: 'old', point: [151.3, -33.9] }], NOW - 3 * HOUR);
  recordPoliceSightings(db, [{ id: 'away', point: [152.0, -33.9] }], NOW);

  const points = queryPoliceHeatmap(db, box, 2 * HOUR, NOW);
  assert.deepEqual(points.map(p => p.point), [[151.1, -33.9], [151.2, -33.9]], 'newest first; old, edge and away are gone');
  assert.equal(points[0].weight, 1);
  assert.equal(points[1].weight, 0.5);

  // Looked at an hour later the fresh report is half faded, and the hour-old one is at the window's edge and weighs nothing.
  const later = queryPoliceHeatmap(db, box, 2 * HOUR, NOW + HOUR);
  assert.deepEqual(later.map(p => p.point), [[151.1, -33.9]]);
  assert.equal(later[0].weight, 0.5);
});

test('a report seen again is one row: last_seen moves on, first_seen and the largest thumbs-up stay', () => {
  const db = fresh();
  const alert = (thumbsUp: number) => ({ id: 'x', point: [151.2, -33.9] as [number, number], subType: 'POLICE_MOBILE_CAMERA', thumbsUp });
  recordPoliceSightings(db, [alert(5)], NOW - HOUR);
  recordPoliceSightings(db, [alert(1)], NOW - 10 * 60000);
  recordPoliceSightings(db, [alert(3)], NOW);
  const rows = (db.prepare('SELECT first_seen, last_seen, thumbs_up, subtype FROM waze_police_sightings').all() as Record<string, unknown>[]).map(r => ({ ...r }));
  assert.deepEqual(rows, [{ first_seen: NOW - HOUR, last_seen: NOW, thumbs_up: 5, subtype: 'POLICE_MOBILE_CAMERA' }]);
});

test('prune forgets reports older than the retention and keeps the rest', () => {
  const db = fresh();
  recordPoliceSightings(db, [{ id: 'new', point: [151.2, -33.9] }], NOW);
  recordPoliceSightings(db, [{ id: 'old', point: [151.2, -33.9] }], NOW - 8 * DAY);
  assert.equal(prunePoliceSightings(db, NOW, 7 * DAY), 1);
  assert.deepEqual((db.prepare('SELECT id FROM waze_police_sightings').all() as { id: string }[]).map(r => r.id), ['new']);
  assert.equal(prunePoliceSightings(db, NOW, 7 * DAY), 0);
});

test('the retention is seven days, the same as the heatmap widest window', () => {
  assert.equal(SIGHTING_RETENTION_MS, 7 * DAY);
});

test('the heatmap reads at most the newest 5000 reports', () => {
  const db = fresh();
  const week = 7 * DAY;
  for (let i = 0; i < 5005; i++) recordPoliceSightings(db, [{ id: `r${i}`, point: [151.2, -33.9] }], NOW - i);
  const points = queryPoliceHeatmap(db, box, week, NOW);
  assert.equal(points.length, 5000);
  // The five oldest reports weigh less than any kept one, so the lightest kept point must outweigh them.
  assert.ok(Math.min(...points.map(p => p.weight)) > 1 - 5000 / week);
});

test('openSightings is safe to run again on an existing database', () => {
  const db = fresh();
  recordPoliceSightings(db, [{ id: 'kept', point: [151.2, -33.9] }], NOW);
  openSightings(db);
  assert.equal(queryPoliceHeatmap(db, box, 2 * HOUR, NOW).length, 1);
});
