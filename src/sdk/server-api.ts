// Vendored from @photoscout/plugin-sdk 2.0.0 (src/server.ts). Do not edit: re-copy with plugin.mjs sdk-check --write.
import type { Request, Response as ExpressResponse, Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The public plugin API. Self-contained on purpose: it is the canonical source,
 * in `@photoscout/plugin-sdk/server`, and imports nothing from the app's
 * internals (only the types of express and node:sqlite). The app re-exports it
 * from server/src/plugins/types.ts.
 */

/**
 * The host's plugin API version: the server contract (ServerPlugin, PluginContext) and the manifest
 * fields. A plugin states a semver range of it in `photoscout`, and manifest.ts checks that range
 * against this constant. It is independent of the browser API's WEB_API_VERSION (`@photoscout/plugin-sdk/web`),
 * which a bundle reads from `host.apiVersion`. See docs/plugins/web-api-design.md, "Versions".
 * 1.1.0 accepts a .mjs web bundle (1.0.0 accepted only .js).
 * 1.2.0 adds `ctx.areas()` and the `PluginArea` type (additive): a plugin that calls it says `"photoscout": "^1.2"`.
 */
export const HOST_API_VERSION = '1.2.0';

export type PermissionKind = 'network' | 'secrets' | 'realtime' | 'llm' | 'tasks' | 'storage';

export type SettingField =
  | { key: string; type: 'string' | 'secret' | 'url'; label: string; help?: string; default?: string; required?: boolean }
  | { key: string; type: 'number'; label: string; help?: string; default?: number; min?: number; max?: number; required?: boolean }
  | { key: string; type: 'boolean'; label: string; help?: string; default?: boolean; required?: boolean }
  | { key: string; type: 'select'; label: string; help?: string; default?: string; options: { value: string; label: string }[]; required?: boolean };

export interface ServiceSpec {
  name: string;
  image: string;
  port: number;
  health?: string;
  env?: Record<string, string>;
  volumes?: string[];
  devices?: { path: string; optional?: boolean }[];
  memory?: string;
  cpus?: number;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  icon?: string;
  category: 'map' | 'feed' | 'events' | 'ai' | 'tools';
  photoscout: string;
  server?: string;
  web?: string;
  permissions?: { kind: PermissionKind; detail?: string }[];
  services?: ServiceSpec[];
  settings?: SettingField[];
  /**
   * Routes under /api/plugins/<id>/ that a visitor who has not signed in may GET or HEAD.
   * Paths are relative to the plugin, e.g. "/places" or "/stations/*" (a * matches any run
   * of characters, slashes included). Every other plugin route needs a signed-in session.
   */
  public?: string[];
}

export interface PluginTaskDef {
  id: string;
  name: string;
  description?: string;
  intervalMinutes: number | null;
  run(log: (msg: string) => void): Promise<{ ok: boolean; message: string }>;
}

/**
 * One of the instance's configured Areas, as a plugin sees it: where it is and how far it reaches.
 * The events and busy switches an Area also carries are not part of this.
 */
export interface PluginArea {
  name: string;
  lat: number;
  lng: number;
  radiusKm: number;
}

export interface PluginContext {
  manifest: PluginManifest;
  /** Mounted at /api/plugins/<id>/ */
  router: Router;
  auth: {
    requireUser(req: Request, res: ExpressResponse): boolean;
    requireAdmin(req: Request, res: ExpressResponse): boolean;
  };
  settings: {
    get(): Record<string, unknown>;
    onChange(fn: (s: Record<string, unknown>) => void): () => void;
  };
  tasks: { register(def: PluginTaskDef): void };
  /**
   * Public internet only: private and loopback addresses are refused, and every redirect hop is checked.
   * One exception, opt-in: a manifest `permissions` entry `{ kind: 'network', detail: '<host>' | '<host>:<port>' }`
   * lets this fetch reach that exact host even when it is private or loopback (a local model server, a sidecar).
   * The host must match exactly, and the port too when one is given; a redirect hop is allowed only if it is
   * public or another declared host. A "*.example.com" detail is informational and never opens anything.
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** The plugin's own SQLite file, data/plugins/<id>/data/plugin.db. Never the core database. */
  db: DatabaseSync;
  /** data/plugins/<id>/data/ */
  dataDir: string;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  services: { url(name: string): string | null };
  /**
   * The instance's configured Areas: the home area first, then the others in the order the admin set them.
   * Read-only, and current at call time: each call reads the settings again, so a poll sees the Areas as they
   * are now. The result is a fresh frozen copy, so a plugin cannot change the stored Areas through it.
   * If the Areas cannot be read, this returns [] rather than throwing.
   */
  areas(): readonly PluginArea[];
}

export interface ServerPlugin {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export function definePlugin(p: ServerPlugin): ServerPlugin {
  return p;
}
