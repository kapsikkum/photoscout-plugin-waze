/**
 * Starting the Waze setup from the plugin: the same steps as core's startWazeSetup (server/src/wazeRuntime.ts)
 * and the same helper, scripts/setup-waze.mjs. The helper lives in the PhotoScout checkout, not in this
 * plugin's zip, so the plugin finds it there (see setupHelperPath); it is never bundled.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SETUP_HELPER_MISSING = 'This installation does not include the Waze setup helper';

export type SpawnFn = (command: string, args: readonly string[], options: Record<string, unknown>) => ChildProcess;

export interface SetupStarterOptions {
  /** The core app's waze folder, <DATA>/waze: where setup.json, setup-helper.log and runtime.json live. */
  wazeDir: string;
  /** The core app's data root, <DATA>. The helper reads it as DATA_DIR and writes <DATA>/waze itself. */
  dataRoot: string;
  /** The helper script, read at each start. Null or a missing file means this installation has no helper. */
  helper(): string | null;
  /** Injected by tests; the default is node's spawn. */
  spawn?: SpawnFn;
  /** The environment the helper inherits; read at each start. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The helper to run. An explicit WAZE_SETUP_HELPER wins. Otherwise the PhotoScout checkout the server was
 * started from: core's server entry is two folders below the checkout root (server/dist or server/src), so
 * its helper is <root>/scripts/setup-waze.mjs, as core's own root is computed from its module location.
 */
export function setupHelperPath(env: NodeJS.ProcessEnv = process.env, entry: string | undefined = process.argv[1]): string | null {
  const explicit = env.WAZE_SETUP_HELPER?.trim();
  if (explicit) return path.resolve(explicit);
  if (!entry) return null;
  return path.resolve(path.dirname(path.resolve(entry)), '..', '..', 'scripts', 'setup-waze.mjs');
}

/**
 * Starts the helper once at a time. `start()` returns when the helper is running, or was already running;
 * it throws (with the message core uses) when there is no helper, or when the waze folder cannot be made.
 */
export class SetupStarter {
  private running = false;
  private readonly spawnFn: SpawnFn;

  constructor(private readonly opts: SetupStarterOptions) {
    this.spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    fs.mkdirSync(this.opts.wazeDir, { recursive: true });
    const script = this.opts.helper();
    if (!script || !fs.existsSync(script)) throw new Error(SETUP_HELPER_MISSING);
    this.running = true;
    const statusFile = path.join(this.opts.wazeDir, 'setup.json');
    fs.writeFileSync(statusFile, JSON.stringify({ state: 'starting', message: 'Starting Waze setup', updatedAt: Date.now() }));
    const log = fs.openSync(path.join(this.opts.wazeDir, 'setup-helper.log'), 'a');
    let child: ChildProcess;
    try {
      // The helper runs from the checkout (its own scripts/ folder's parent), with the core data root as DATA_DIR.
      child = this.spawnFn(process.execPath, [script], {
        cwd: path.resolve(path.dirname(script), '..'),
        env: { ...(this.opts.env ?? process.env), DATA_DIR: this.opts.dataRoot },
        windowsHide: true,
        stdio: ['ignore', log, log],
      });
    } catch (err) {
      // Core leaves `running` set when spawn throws synchronously; the plugin clears it so a retry can start.
      this.running = false;
      throw err;
    } finally {
      fs.closeSync(log);
    }
    child.on('error', () => {
      this.running = false;
      try {
        fs.writeFileSync(statusFile, JSON.stringify({ state: 'failed', message: 'Setup helper could not start', updatedAt: Date.now() }));
      } catch { /* The folder went away; there is no status to write. */ }
    });
    child.on('exit', () => {
      this.running = false;
    });
  }
}
