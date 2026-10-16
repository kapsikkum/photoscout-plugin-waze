import type { DriveAlert, DriveStatus, DriveSourceContext, LngLat, SpeakResult } from '../sdk/web-api.js';
import type { ReportState } from './types.js';

/**
 * The Drive source's pure rules, ported from the core app's Drive screen (pages/Drive.tsx, drive/format.ts and
 * drive/reports.ts). The host does the geometry (`ctx.routeAhead`), the voice gate and the once-per-drive
 * de-duplication (`ctx.speak`, which answers a SpeakResult); this module decides what the report warnings say
 * and when they are asked for.
 */

/**
 * Core speaks a warning only for the nearest report that is this close along the route. This is the plugin's
 * own policy: the host's speech gates are the fix's age and accuracy (tuning.speakMaxAgeMs, speakMaxAccuracyM),
 * not a distance along the route, so it stays here.
 */
export const SPEAK_WITHIN_M = 800;

/** Core's status tick: the Drive screen re-reads the car's place every two seconds. */
export const DRIVE_TICK_MS = 2000;

/** Core's status hint for a failed feed, word for word. */
export const DRIVE_ERROR_TEXT = "Police and hazard reports can't load right now";

/** The status line for a feed state. A fresh answer shows nothing (null), as core's hints do. */
export function driveStatusFor(state: ReportState): DriveStatus | null {
  switch (state) {
    case 'queued': return { state: 'waiting', text: 'Waiting to check reports for this area…' };
    case 'scanning': return { state: 'checking', text: 'Checking reports for this area…' };
    case 'stale': return { state: 'stale', text: 'Showing older reports while they refresh…' };
    case 'fresh': return null;
  }
}

/** "350 m", "1.2 km", "14 km": rounded the way a sign would be (core drive/format.ts). */
export function formatDistance(m: number): string {
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 100) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  if (m < 1000) return `${Math.round(m / 50) * 50} m`;
  const km = m / 1000;
  return km < 10 ? `${(Math.round(km * 10) / 10).toFixed(1)} km` : `${Math.round(km)} km`;
}

export interface AheadAlert {
  alert: DriveAlert;
  /** Metres along the route from the car. */
  distanceM: number;
}

/**
 * The alert nearest on the road ahead, by distance along the route; null when none is ahead. `routeAhead`
 * is the host's on-route test, which already answers null for anything behind, off the road or too far.
 */
export function nearestAhead(alerts: readonly DriveAlert[], routeAhead: (point: LngLat) => number | null): AheadAlert | null {
  let best: AheadAlert | null = null;
  for (const alert of alerts) {
    const distanceM = routeAhead(alert.point);
    if (distanceM !== null && (best === null || distanceM < best.distanceM)) best = { alert, distanceM };
  }
  return best;
}

/**
 * Speak the nearest warning, as core does: "Police reported ahead, in 400 m.", only when it is within
 * SPEAK_WITHIN_M and keyed by the alert, so the host says it once per drive. Only the nearest is ever
 * spoken, so a second report waits its turn. Returns the host's answer to `speak` (test its `spoken`), or
 * null when no report is near enough to be a warning at all.
 */
export function announceNearest(ctx: Pick<DriveSourceContext, 'routeAhead' | 'speak'>, alerts: readonly DriveAlert[]): SpeakResult | null {
  const near = nearestAhead(alerts, (point) => ctx.routeAhead(point));
  if (!near || near.distanceM > SPEAK_WITHIN_M) return null;
  return ctx.speak(`${near.alert.title} ahead, in ${formatDistance(near.distanceM)}.`, { key: near.alert.id });
}
