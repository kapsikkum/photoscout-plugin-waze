import type { ReportState, WazeStatusResponse } from './types.js';

/**
 * Plain words for the harvester status, and when the Settings tab should keep asking. Ported from core
 * settings/WazeSettings.tsx and MapPage.tsx. A zero count is never an all-clear, and raw service messages
 * are for admins only.
 */

export type ActivityLevel = 'info' | 'success' | 'warning' | 'error';

export interface ConnectionText {
  tone: '' | 'ok' | 'error';
  text: string;
}

/** The one line that says whether reports can be had right now. */
export function connectionText(status: WazeStatusResponse, isAdmin: boolean): ConnectionText {
  if (status.setup.state === 'needs_first_run') {
    return {
      tone: '',
      text: isAdmin ? 'Waze is waiting for its first-run screen. Finish it with the steps below.' : 'Police & hazard reports are being set up.',
    };
  }
  if (!status.configured) {
    return {
      tone: '',
      text: isAdmin ? 'Not set up yet. Add the harvester address and key in this plugin\'s settings.' : 'Not set up on this server yet.',
    };
  }
  if (!status.checked) return { tone: '', text: 'Not checked yet. Press Test connection to check.' };
  if (status.liveMapStatus.accessible) {
    return {
      tone: 'ok',
      text: status.alertCount
        ? `Connected. ${status.alertCount} reports are available right now.`
        : 'Connected. No reports are available right now, which does not mean the roads are clear.',
    };
  }
  return {
    tone: 'error',
    text: `Not connected. Reports can't load right now.${isAdmin ? ` (${status.liveMapStatus.message})` : ''}`,
  };
}

/** Whether the harvester is still doing its one-off setup: the status is asked again every few seconds. */
export function setupNeedsPolling(state: string): boolean {
  return state === 'installing' || state === 'starting' || state === 'needs_first_run';
}

/** What the map's activity log says when the report state moves. */
export function reportsActivity(state: ReportState, count: number): { message: string; level: ActivityLevel } {
  switch (state) {
    case 'queued': return { message: 'Waiting to check reports for this area', level: 'info' };
    case 'scanning': return { message: 'Checking reports for this area…', level: 'info' };
    case 'stale': return { message: 'Showing older reports while they refresh…', level: 'info' };
    case 'fresh':
      return count
        ? { message: `${count} reports for this area`, level: 'success' }
        : { message: 'No reports for this area right now; that does not mean the roads are clear', level: 'info' };
  }
}

/** The note under the connection line for what the harvester covers, or null when there is none to say. */
export function coverageNote(coverage: WazeStatusResponse['coverage']): string | null {
  if (coverage === 'route') return 'Only reports along the route in the Waze app are included, so other roads may show none.';
  if (coverage === 'viewport') return 'Reports cover the areas you look at on the map. A new area takes a moment to load.';
  return null;
}
