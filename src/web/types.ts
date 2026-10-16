/**
 * What this plugin's own routes answer with, as the web half reads them. Written out here rather than
 * imported from src/feed.ts or src/setup.ts, so the browser bundle never pulls in server code.
 */

export type ReportState = 'fresh' | 'queued' | 'scanning' | 'stale';

/** One Waze report, as GET /alerts returns it (src/feed.ts WazeAlert). `point` is [lng, lat]. */
export interface WazeReport {
  id: string;
  type: string;
  subType?: string;
  reportTime: number | null;
  point: [number, number];
  street?: string;
  city?: string;
  description?: string;
  thumbsUp?: number;
}

export interface WazeAlertsResponse {
  configured: boolean;
  alerts: WazeReport[];
  coverage: 'route' | 'viewport';
  observedAt: number | null;
  state: ReportState;
  retryAfterMs: number;
}

/** One weighted sighting for the police heatmap; `point` is [lng, lat]. */
export interface WazeHeatPoint {
  point: [number, number];
  weight: number;
}

export interface WazeHeatmapResponse {
  configured: boolean;
  windowMs: number;
  observedAt: number | null;
  points: WazeHeatPoint[];
}

/** The setup record the status route shows: admins also get the first-run instructions. */
export interface WazeSetupView {
  state: string;
  message: string;
  updatedAt: number | null;
  first_run?: { detected_at: number | null; how?: string };
}

export interface WazeStatusResponse {
  configured: boolean;
  liveMapStatus: { endpoint: string; accessible: boolean; status: number | null; message: string };
  checked: boolean;
  alertCount: number | null;
  coverage: 'route' | 'viewport' | null;
  observedAt: number | null;
  canDisplayOnMap: boolean;
  attribution: string;
  setup: WazeSetupView;
}
