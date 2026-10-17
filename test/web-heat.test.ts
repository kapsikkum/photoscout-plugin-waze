// The police heatmap's time window for the web half: the choices, the default, the GeoJSON, and the one
// shared store the map corner and the Settings tab both use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeatWindowStore, HEAT_DEFAULT_MS, HEAT_WINDOWS, heatmapGeoJSON } from '../src/web/heat.js';

test('the windows run from one hour to sixty days, the same clamp the server applies, and the default is one of them', () => {
  const ms = HEAT_WINDOWS.map((w) => w.ms);
  assert.deepEqual(ms, [...ms].sort((a, b) => a - b), 'ascending');
  assert.equal(ms[0], 60 * 60 * 1000);
  assert.equal(ms[ms.length - 1], 60 * 24 * 60 * 60 * 1000);
  assert.ok(ms.includes(HEAT_DEFAULT_MS));
  assert.equal(HEAT_DEFAULT_MS, 2 * 60 * 60 * 1000);
});

test('the store starts on the default and tells its listeners each change once', () => {
  const store = createHeatWindowStore();
  assert.equal(store.get(), HEAT_DEFAULT_MS);
  const seen: number[] = [];
  store.subscribe((ms) => seen.push(ms));
  store.set(86_400_000);
  store.set(86_400_000);
  assert.equal(store.get(), 86_400_000);
  assert.deepEqual(seen, [86_400_000], 'an unchanged window says nothing');
});

test('the store ignores a window it does not offer, and a listener that unsubscribes hears nothing more', () => {
  const store = createHeatWindowStore(3_600_000);
  const seen: number[] = [];
  const stop = store.subscribe((ms) => seen.push(ms));
  store.set(5 * 60_000);
  assert.equal(store.get(), 3_600_000);
  store.set(604_800_000);
  stop();
  store.set(21_600_000);
  assert.deepEqual(seen, [604_800_000]);
  assert.equal(store.get(), 21_600_000);
});

test('the heatmap GeoJSON has one point per sighting, weighted, in lng-lat order', () => {
  const fc = heatmapGeoJSON([{ point: [151.2, -33.8], weight: 0.5 }, { point: [151.3, -33.9], weight: 1 }]);
  assert.equal(fc.features.length, 2);
  assert.deepEqual(fc.features[0].geometry, { type: 'Point', coordinates: [151.2, -33.8] });
  assert.deepEqual(fc.features[1].properties, { weight: 1 });
  assert.deepEqual(heatmapGeoJSON([]).features, []);
});
