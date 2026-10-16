import type { FeatureCollection, Point } from 'geojson';
import type { DriveAlert } from '../sdk/web-api.js';
import type { WazeReport } from './types.js';

/**
 * Report decoding and wording: the pure half of the core app's Waze map code (map/waze.ts) and Drive
 * filter (drive/reports.ts), so the plugin shows the same names, icons and warnings.
 */

/** The credit line on the map source (core map/waze.ts). */
export const REPORTS_ATTRIBUTION = 'Reports: Waze / Google';

/** Every report type that gets a map icon. */
export const REPORT_TYPES = ['POLICE', 'HAZARD', 'CONSTRUCTION', 'CAMERA', 'ROAD_CLOSED', 'ACCIDENT', 'JAM'] as const;

/** The types Drive warns about (drive/reports.ts). Traffic jams are map-only. */
export const DRIVE_REPORT_TYPES: readonly string[] = ['POLICE', 'HAZARD', 'CONSTRUCTION', 'ACCIDENT', 'ROAD_CLOSED', 'CAMERA'];

/** A report older than this is not worth a driver's warning (drive/reports.ts). */
export const DRIVE_REPORT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** A report stamped this far ahead of the clock is still taken as current (drive/reports.ts). */
const CLOCK_SKEW_MS = 60_000;

const EMOJI: Record<string, string> = {
  POLICE: '👮', HAZARD: '⚠️', CONSTRUCTION: '🚧', CAMERA: '', ROAD_CLOSED: '⛔', ACCIDENT: '💥', JAM: '🚗',
};

/** The icon a report is drawn with. A mobile police camera is drawn as the camera icon. */
export function reportIconType(report: Pick<WazeReport, 'type' | 'subType'>): string {
  const mobileCamera = report.type === 'POLICE' && ['POLICE_MOBILE_CAMERA', 'POLICE_WITH_MOBILE_CAMERA'].includes(report.subType ?? '');
  return mobileCamera ? 'CAMERA' : report.type;
}

/** The emoji for an icon type. The camera has none (it is drawn as a picture), so this is '' for it. */
export function reportEmoji(iconType: string): string {
  return EMOJI[iconType] ?? '⚠️';
}

/** The short name of a report: the popup's title and the Drive banner's line. */
export function reportLabel(report: Pick<WazeReport, 'type' | 'subType'>): string {
  if (report.type === 'POLICE') {
    if (reportIconType(report) === 'CAMERA') return 'Mobile speed camera reported';
    return ['POLICE_HIDING', 'POLICE_HIDDEN'].includes(report.subType ?? '') ? 'Police hiding nearby' : 'Police reported';
  }
  if (report.type === 'CAMERA') return 'Traffic camera';
  if (report.type === 'ROAD_CLOSED') return 'Road closed';
  if (report.type === 'ACCIDENT') return 'Crash reported';
  if (report.type === 'JAM') return 'Traffic jam reported';
  return 'Hazard reported';
}

/** The glyph beside a Drive alert. Where the map has a camera picture, Drive has a camera emoji. */
export function driveGlyph(report: Pick<WazeReport, 'type' | 'subType'>): string {
  return reportEmoji(reportIconType(report)) || '📷';
}

/** Whether a report is fresh enough to warn about: undated reports count, and so does a little clock skew. */
export function isRecentReport(reportTime: number | null, now: number): boolean {
  return reportTime === null || (reportTime <= now + CLOCK_SKEW_MS && now - reportTime < DRIVE_REPORT_MAX_AGE_MS);
}

/** The map's GeoJSON: one point per report, with the fields the icon and the popup read. */
export function reportGeoJSON(reports: readonly WazeReport[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: reports.map((r) => ({
      type: 'Feature' as const,
      id: r.id,
      geometry: { type: 'Point' as const, coordinates: r.point },
      properties: {
        id: r.id,
        type: r.type,
        iconType: reportIconType(r),
        title: reportLabel(r),
        description: r.description ?? '',
        street: r.street ?? '',
        reportTime: r.reportTime,
      },
    })),
  };
}

export interface ReportPopup {
  title: string;
  lines: string[];
}

/**
 * The popup for a clicked report: its title, then the street, the description, when it was reported and
 * where it came from. Empty fields are left out. Built from the feature's properties, as the map gives them.
 */
export function reportPopup(properties: Record<string, unknown> | null | undefined, formatTime: (ms: number) => string): ReportPopup {
  const p = properties ?? {};
  const lines = [p.street, p.description].filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (typeof p.reportTime === 'number') lines.push(`Reported ${formatTime(p.reportTime)}`);
  lines.push('Waze community report');
  return { title: String(p.title ?? ''), lines };
}

/** The reports Drive should be told about, in the shape `DriveSourceContext.report` takes. */
export function driveAlerts(reports: readonly WazeReport[], now: number): DriveAlert[] {
  return reports
    .filter((r) => DRIVE_REPORT_TYPES.includes(r.type) && isRecentReport(r.reportTime, now))
    .map((r) => ({
      id: r.id,
      point: r.point,
      title: reportLabel(r),
      glyph: driveGlyph(r),
      ...(r.street ? { detail: r.street } : {}),
    }));
}
