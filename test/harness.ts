// Test helpers: a fake router that records route handlers, and a fake PluginContext built from the
// real plugin.json. Nothing here runs as a test (the glob is *.test.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PluginArea, PluginContext, PluginManifest, PluginTaskDef } from '../src/sdk/server-api.js';
import plugin from '../src/server.js';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8')) as PluginManifest;
export const ROUTE_BASE = `/api/plugins/${manifest.id}`;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A temp data folder laid out like the host's: <DATA>/plugins/<id>/data, with <DATA>/waze beside it. */
export function tempDataDir(): { dataDir: string; wazeDir: string; cleanup(): void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'waze-plugin-'));
  const dataDir = path.join(base, 'plugins', manifest.id, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const wazeDir = path.join(base, 'waze');
  return { dataDir, wazeDir, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

type Handler = (req: { query: Record<string, string>; user?: { role: string } | null }, res: FakeRes, next: (err?: unknown) => void) => unknown;

export class FakeRes {
  statusCode = 200;
  body: unknown = undefined;
  status(code: number): FakeRes { this.statusCode = code; return this; }
  json(body: unknown): FakeRes { this.body = body; return this; }
}

export class FakeRouter {
  readonly routes = new Map<string, Handler>();
  readonly posts = new Map<string, Handler>();
  get(route: string, handler: Handler): this { this.routes.set(route, handler); return this; }
  post(route: string, handler: Handler): this { this.posts.set(route, handler); return this; }
}

export interface ActivateOptions {
  settings?: Record<string, unknown>;
  fetchFn?: FetchLike;
  dataDir?: string;
  /** The instance's configured Areas, as ctx.areas() returns them. */
  areas?: PluginArea[];
}

/** A fake PluginContext over a fake router and an in-memory database, with a settings hook the test can drive. */
export function fakeContext(opts: ActivateOptions = {}) {
  const router = new FakeRouter();
  const db = new DatabaseSync(':memory:');
  const settings = { ...(opts.settings ?? {}) };
  const listeners: ((s: Record<string, unknown>) => void)[] = [];
  /** The tasks the plugin registered, and the log lines it wrote, for the tests to read. */
  const registered: PluginTaskDef[] = [];
  const lines: { level: 'info' | 'warn' | 'error'; msg: string }[] = [];
  let areas: PluginArea[] = (opts.areas ?? []).map(a => ({ ...a }));
  let areaReads = 0;
  const ctx = {
    manifest,
    router,
    // The host's gates, as server/src/auth.ts states them: 401 without a session, 403 unless an admin.
    auth: {
      requireUser: (req: { user?: unknown }, res: FakeRes) => {
        if (req.user) return true;
        res.status(401).json({ error: 'Sign in required' });
        return false;
      },
      requireAdmin: (req: { user?: { role?: string } | null }, res: FakeRes) => {
        if (req.user?.role === 'admin') return true;
        res.status(403).json({ error: 'Admins only' });
        return false;
      },
    },
    settings: {
      get: () => settings,
      onChange: (fn: (s: Record<string, unknown>) => void) => { listeners.push(fn); return () => {}; },
    },
    tasks: { register: (def: PluginTaskDef) => { registered.push(def); } },
    fetch: opts.fetchFn ?? (async () => { throw new Error('no fetch stubbed'); }),
    db,
    dataDir: opts.dataDir ?? tempDataDir().dataDir,
    log: {
      info: (msg: string) => { lines.push({ level: 'info', msg }); },
      warn: (msg: string) => { lines.push({ level: 'warn', msg }); },
      error: (msg: string) => { lines.push({ level: 'error', msg }); },
    },
    services: { url: () => null },
    // As the host states it: a fresh frozen copy of the Areas, read at call time.
    areas: () => {
      areaReads += 1;
      return Object.freeze(areas.map(a => Object.freeze({ ...a })));
    },
  } as unknown as PluginContext;
  return {
    ctx, router, db, settings, registered, lines,
    /** Replace the settings and tell the plugin, as the host does on save. */
    changeSettings(next: Record<string, unknown>) {
      for (const k of Object.keys(settings)) delete settings[k];
      Object.assign(settings, next);
      for (const fn of listeners) fn({ ...next });
    },
    /** Replace the configured Areas, as the admin does in the app. Takes effect at the next ctx.areas() call. */
    setAreas(next: PluginArea[]) {
      areas = next.map(a => ({ ...a }));
    },
    /** How many times the plugin has read the Areas. */
    areaReads: () => areaReads,
  };
}

/** Activate this repository's plugin against a fake host. */
export async function activatePlugin(opts: ActivateOptions = {}) {
  const fake = fakeContext(opts);
  await plugin.activate(fake.ctx);
  return fake;
}

/** Call a route the way Express would, with a query and an optional signed-in user. */
export async function call(router: FakeRouter, route: string, query: Record<string, string> = {}, user: { role: string } | null = null) {
  const handler = router.routes.get(route);
  if (!handler) throw new Error(`no route registered for ${route}`);
  const res = new FakeRes();
  let error: unknown;
  await handler({ query, user }, res, (err) => { error = err; res.statusCode = 500; });
  return { status: res.statusCode, json: res.body as Record<string, any>, error };
}

/** Call a POST route the way Express would: no body is needed by the setup route, and the user is optional. */
export async function callPost(router: FakeRouter, route: string, user: { role: string } | null = null) {
  const handler = router.posts.get(route);
  if (!handler) throw new Error(`no POST route registered for ${route}`);
  const res = new FakeRes();
  let error: unknown;
  await handler({ query: {}, user }, res, (err) => { error = err; res.statusCode = 500; });
  return { status: res.statusCode, json: res.body as Record<string, any>, error };
}

export const BOX = { minLng: '151.1', minLat: '-33.95', maxLng: '151.3', maxLat: '-33.8' };
