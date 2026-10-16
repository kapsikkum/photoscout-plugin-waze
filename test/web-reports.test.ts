// Report decoding and wording for the web half: icons, names, the Drive filter and the popup. These are the
// pure functions of src/web/reports.ts, ported from the core app's map/waze.ts and drive/reports.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRIVE_REPORT_MAX_AGE_MS, driveAlerts, driveGlyph, isRecentReport, reportEmoji, reportGeoJSON, reportIconType, reportLabel, reportPopup,
} from '../src/web/reports.js';
import type { WazeReport } from '../src/web/types.js';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const HOUR = 3_600_000;

const report = (over: Partial<WazeReport> & Pick<WazeReport, 'id' | 'type'>): WazeReport => ({
  reportTime: NOW - 10 * 60_000,
  point: [151.2, -33.87],
  ...over,
});

test('a mobile police camera is drawn as the camera icon; other police reports keep their own icon', () => {
  assert.equal(reportIconType({ type: 'POLICE', subType: 'POLICE_MOBILE_CAMERA' }), 'CAMERA');
  assert.equal(reportIconType({ type: 'POLICE', subType: 'POLICE_WITH_MOBILE_CAMERA' }), 'CAMERA');
  assert.equal(reportIconType({ type: 'POLICE', subType: 'POLICE_HIDING' }), 'POLICE');
  assert.equal(reportIconType({ type: 'HAZARD' }), 'HAZARD');
});

test('the map emoji: the camera has none, and an unknown type gets the hazard sign', () => {
  assert.equal(reportEmoji('POLICE'), '👮');
  assert.equal(reportEmoji('CAMERA'), '');
  assert.equal(reportEmoji('SOMETHING_NEW'), '⚠️');
});

test('report names say what was seen, with the police variants told apart', () => {
  assert.equal(reportLabel({ type: 'POLICE', subType: 'POLICE_MOBILE_CAMERA' }), 'Mobile speed camera reported');
  assert.equal(reportLabel({ type: 'POLICE', subType: 'POLICE_HIDING' }), 'Police hiding nearby');
  assert.equal(reportLabel({ type: 'POLICE', subType: 'POLICE_HIDDEN' }), 'Police hiding nearby');
  assert.equal(reportLabel({ type: 'POLICE' }), 'Police reported');
  assert.equal(reportLabel({ type: 'CAMERA' }), 'Traffic camera');
  assert.equal(reportLabel({ type: 'ROAD_CLOSED' }), 'Road closed');
  assert.equal(reportLabel({ type: 'ACCIDENT' }), 'Crash reported');
  assert.equal(reportLabel({ type: 'JAM' }), 'Traffic jam reported');
  assert.equal(reportLabel({ type: 'CONSTRUCTION' }), 'Hazard reported');
});

test('Drive shows a camera picture as a camera emoji, since the picture has no emoji of its own', () => {
  assert.equal(driveGlyph({ type: 'POLICE', subType: 'POLICE_MOBILE_CAMERA' }), '📷');
  assert.equal(driveGlyph({ type: 'POLICE' }), '👮');
});

test('a report is recent when it is within two hours; undated reports count, and a little clock skew is allowed', () => {
  assert.equal(isRecentReport(null, NOW), true);
  assert.equal(isRecentReport(NOW - HOUR, NOW), true);
  assert.equal(isRecentReport(NOW - 3 * HOUR, NOW), false);
  assert.equal(isRecentReport(NOW - DRIVE_REPORT_MAX_AGE_MS + 1, NOW), true);
  assert.equal(isRecentReport(NOW + 30_000, NOW), true);
  assert.equal(isRecentReport(NOW + 5 * 60_000, NOW), false);
});

test('the map gets one point per report, with the icon, title and street the layers read', () => {
  const fc = reportGeoJSON([report({ id: 'a', type: 'POLICE', subType: 'POLICE_MOBILE_CAMERA', street: 'George St', point: [151.21, -33.86] }), report({ id: 'b', type: 'HAZARD' })]);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 2);
  const [first, second] = fc.features;
  assert.equal(first.id, 'a');
  assert.deepEqual(first.geometry, { type: 'Point', coordinates: [151.21, -33.86] });
  assert.deepEqual(first.properties, {
    id: 'a', type: 'POLICE', iconType: 'CAMERA', title: 'Mobile speed camera reported', description: '', street: 'George St', reportTime: NOW - 10 * 60_000,
  });
  assert.equal(second.properties?.street, '');
});

test('the popup gives the title, then the street, description, time and source; empty fields are left out', () => {
  const format = (ms: number): string => `at ${ms}`;
  const full = reportPopup({ title: 'Police reported', street: 'George St', description: 'Speed trap', reportTime: 1234 }, format);
  assert.deepEqual(full, { title: 'Police reported', lines: ['George St', 'Speed trap', 'Reported at 1234', 'Waze community report'] });
  const bare = reportPopup({ title: 'Hazard reported', street: '', description: '' }, format);
  assert.deepEqual(bare, { title: 'Hazard reported', lines: ['Waze community report'] });
  assert.deepEqual(reportPopup(null, format), { title: '', lines: ['Waze community report'] });
});

test('Drive is told only about recent police, hazard, roadworks, crash, road-closed and camera reports, with their street', () => {
  const alerts = [
    report({ id: 'police', type: 'POLICE', street: 'George St' }),
    report({ id: 'jam', type: 'JAM' }),
    report({ id: 'old', type: 'HAZARD', reportTime: NOW - 3 * HOUR }),
    report({ id: 'undated', type: 'ROAD_CLOSED', reportTime: null }),
    report({ id: 'camera', type: 'POLICE', subType: 'POLICE_MOBILE_CAMERA' }),
  ];
  const drive = driveAlerts(alerts, NOW);
  assert.deepEqual(drive.map((d) => d.id), ['police', 'undated', 'camera']);
  assert.deepEqual(drive[0], { id: 'police', point: [151.2, -33.87], title: 'Police reported', glyph: '👮', detail: 'George St' });
  assert.equal('detail' in drive[1], false, 'no street, no detail line');
  assert.equal(drive[2].glyph, '📷');
});
