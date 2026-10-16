/**
 * What the Settings page says about the harvester's setup. Ported from
 * PhotoScout server/src/wazeRuntime.ts. Starting the container setup stays
 * with the operator (see harvester/README.md); this module only reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { WazeWorkerHealth } from './feed.js';

export const FIRST_RUN_MESSAGE = 'Waze needs its one-time first-run screen completed by the server operator. Police and hazard reports start after that.';

export interface SetupFile {
  state: string;
  message: string;
  updatedAt: number | null;
  first_run?: { detected_at?: number | null; how?: string };
}

export interface WazeSetupView {
  state: string;
  message: string;
  updatedAt: number | null;
  first_run?: { detected_at: number | null; how?: string };
}

function firstRunView(detectedAt: number | null, how: string | null, admin: boolean, updatedAt: number | null): WazeSetupView {
  return {
    state: 'needs_first_run', message: FIRST_RUN_MESSAGE, updatedAt,
    first_run: admin ? { detected_at: detectedAt, how: how ?? undefined } : { detected_at: detectedAt },
  };
}

/** Pure: combine the saved setup record with the worker's live stage. Instructions reach admins only. */
export function presentWazeSetup(setup: SetupFile, health: WazeWorkerHealth | null, options: { admin?: boolean } = {}): WazeSetupView {
  const admin = options.admin === true;
  if (health?.setupStage === 'needs_first_run') {
    return firstRunView(health.firstRun?.detectedAt ?? null, health.firstRun?.how ?? null, admin, setup.updatedAt);
  }
  if (setup.state === 'needs_first_run') {
    // The worker has moved on; its health is the newer truth.
    if (health) return { state: 'starting', message: 'Waiting for Waze to connect and return reports', updatedAt: setup.updatedAt };
    return firstRunView(setup.first_run?.detected_at ?? null, setup.first_run?.how ?? null, admin, setup.updatedAt);
  }
  return { state: setup.state, message: setup.message, updatedAt: setup.updatedAt };
}

/** The setup record the core setup helper writes, or "not started" when there is none. */
export function readSetupFile(wazeDir: string): SetupFile {
  try {
    return JSON.parse(fs.readFileSync(path.join(wazeDir, 'setup.json'), 'utf8')) as SetupFile;
  } catch {
    return { state: 'not_started', message: 'Waze report setup has not run', updatedAt: null };
  }
}

/**
 * The core app's runtime file (url and key), read as a fallback so an install that
 * predates this plugin keeps working. Read only; the plugin never writes it.
 */
export function readMigratedRuntime(wazeDir: string): { url?: string; key?: string } {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(wazeDir, 'runtime.json'), 'utf8')) as { url?: unknown; key?: unknown };
    return {
      url: typeof config.url === 'string' ? config.url : undefined,
      key: typeof config.key === 'string' ? config.key : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * The core app's `waze` data folder. A plugin's data folder is <DATA>/plugins/<id>/data,
 * so the core folder is three levels up.
 */
export function coreWazeDir(pluginDataDir: string): string {
  return path.join(path.resolve(pluginDataDir, '..', '..', '..'), 'waze');
}
