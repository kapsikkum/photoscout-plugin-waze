import type { FeatureCollection } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { DriveSourceContext } from '../sdk/web-api.js';
import { REPORT_TYPES, REPORTS_ATTRIBUTION, reportEmoji } from './reports.js';

/**
 * The map layers for the reports and the police heatmap, added inside `host.map.onReady` (the map page) or
 * in a Drive source's `start` (the Drive map). Types only from maplibre-gl, so nothing of it is bundled.
 * Ported from core map/waze.ts and map/policeHeat.ts.
 */

/** The report pins' ids: the source, the dot, the emoji labels and the prefix of their icon images. */
export interface PinLayerIds {
  reportsSource: string;
  reports: string;
  labels: string;
  /** Prefix of the icon images: `<icons><iconType>`. */
  icons: string;
}

export interface WazeLayerIds extends PinLayerIds {
  heatSource: string;
  heat: string;
}

/** The name prefix of the report icon images (`<prefix><type>`). Each map scopes it with its own `scopedId`. */
export const ICON_PREFIX = 'icon-';

/**
 * The Drive map's icons go in through the host's `addImage`, which takes no pixel ratio, so they are the
 * 64 px drawing at ratio 1 and show at half the size the map page's ratio-2 icons do: both come out 32 px.
 */
export const DRIVE_ICON_SIZE = 0.5;

export const EMPTY_COLLECTION: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** The camera icon, drawn by hand: the basemap's glyph server has no emoji, and a camera has none. */
function drawCamera(ctx: CanvasRenderingContext2D): void {
  ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fbbf24';
  ctx.beginPath(); ctx.roundRect(15, 10, 34, 30, 5); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#172b49'; ctx.beginPath(); ctx.arc(32, 25, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#7dd3fc'; ctx.beginPath(); ctx.arc(32, 25, 4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(32, 42); ctx.lineTo(32, 56); ctx.moveTo(22, 56); ctx.lineTo(42, 56); ctx.stroke();
}

/** One report type's icon, drawn at 64 px, or null if the browser gives no 2D context. */
function drawReportIcon(type: string): ImageData | null {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (type === 'CAMERA') {
    drawCamera(ctx);
  } else {
    ctx.font = '48px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(reportEmoji(type), 32, 34);
  }
  return ctx.getImageData(0, 0, 64, 64);
}

/**
 * The map page's icons: one image per report type under `<prefix><type>`, at pixel ratio 2. An image the map
 * already has is kept, so a remounted map skips the drawing.
 */
export function addReportIcons(map: MapLibreMap, prefix: string): void {
  for (const type of REPORT_TYPES) {
    if (map.hasImage(`${prefix}${type}`)) continue;
    const image = drawReportIcon(type);
    if (image) map.addImage(`${prefix}${type}`, image, { pixelRatio: 2 });
  }
}

/**
 * The Drive map's icons, through the host: one image per report type, under `scopedId(ICON_PREFIX + type)`,
 * which is the prefix `addReportLayers` reads. The host removes a source's images when it stops, so every
 * start adds them again (adding a name that exists replaces it).
 */
export function addDriveReportIcons(ctx: Pick<DriveSourceContext, 'addImage'>): void {
  for (const type of REPORT_TYPES) {
    const image = drawReportIcon(type);
    if (image) ctx.addImage(`${ICON_PREFIX}${type}`, image);
  }
}

/** The heatmap source and layer. Added before the report pins, so the pins draw above the density. */
export function addHeatLayer(map: MapLibreMap, ids: WazeLayerIds): void {
  map.addSource(ids.heatSource, { type: 'geojson', data: EMPTY_COLLECTION, attribution: REPORTS_ATTRIBUTION });
  map.addLayer({
    id: ids.heat,
    type: 'heatmap',
    source: ids.heatSource,
    paint: {
      'heatmap-weight': ['to-number', ['get', 'weight'], 0],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 13, 1, 16, 1.6],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 6, 6, 10, 12, 13, 22, 16, 36],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(37,99,235,0)', 0.2, '#2563eb', 0.45, '#84cc16', 0.7, '#facc15', 1, '#ef4444'],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 16, 0.5],
    },
  });
}

/**
 * The report pins: a dot and an emoji per report. Clicks are read from the dot (`reports`). Used on the map page
 * (icons at ratio 2, so `iconSize` 1) and on the Drive map (`DRIVE_ICON_SIZE`).
 */
export function addReportLayers(map: MapLibreMap, ids: PinLayerIds, iconSize = 1): void {
  map.addSource(ids.reportsSource, { type: 'geojson', data: EMPTY_COLLECTION, attribution: REPORTS_ATTRIBUTION });
  map.addLayer({
    id: ids.reports,
    type: 'circle',
    source: ids.reportsSource,
    paint: { 'circle-radius': 16, 'circle-color': '#172b49', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
  map.addLayer({
    id: ids.labels,
    type: 'symbol',
    source: ids.reportsSource,
    layout: {
      'icon-image': ['concat', ids.icons, ['get', 'iconType']],
      'icon-size': iconSize,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
}

/**
 * Replace a GeoJSON source's data. Does nothing if the source is gone, which is the case while a map
 * is being removed (a poll may stop then).
 */
export function setSourceData(map: MapLibreMap, sourceId: string, data: FeatureCollection): void {
  try {
    (map.getSource(sourceId) as GeoJSONSource | undefined)?.setData(data);
  } catch {
    // The map is being removed; there is nothing left to draw on.
  }
}
