// The setup starter (src/setupStart.ts): core's startWazeSetup, tested with an injected spawn so no helper runs.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_HELPER_MISSING, SetupStarter, setupHelperPath, type SpawnFn } from '../src/setupStart.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'waze-setup-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

let seq = 0;
/** A fresh install folder: <base>/<n>/ with a helper at scripts/setup-waze.mjs and the waze folder beside it. */
function install() {
  const root = path.join(base, String(seq++));
  const script = path.join(root, 'scripts', 'setup-waze.mjs');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '// the helper is not run in these tests');
  return { root, script, wazeDir: path.join(root, 'waze') };
}

class FakeChild extends EventEmitter {}

/** A spawn that records each call and hands back a child the test can end. */
function fakeSpawn() {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const children: FakeChild[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return { spawn, calls, children };
}

const readStatus = (wazeDir: string) => JSON.parse(fs.readFileSync(path.join(wazeDir, 'setup.json'), 'utf8')) as { state: string; message: string };

test('start writes the starting state and runs the helper from its checkout, with the core data root as DATA_DIR', () => {
  const dir = install();
  const { spawn, calls } = fakeSpawn();
  const starter = new SetupStarter({ wazeDir: dir.wazeDir, dataRoot: dir.root, helper: () => dir.script, spawn, env: { PATH: '/bin' } });
  starter.start();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath, 'the helper runs under this node, as core runs it');
  assert.deepEqual(calls[0].args, [dir.script]);
  assert.equal(calls[0].options.cwd, dir.root, 'from the checkout root, which is the parent of scripts/');
  assert.equal((calls[0].options.env as Record<string, string>).DATA_DIR, dir.root, 'the core data root, so the helper writes <DATA>/waze');
  assert.equal((calls[0].options.env as Record<string, string>).PATH, '/bin', 'and inherits the environment');
  assert.equal((calls[0].options.stdio as unknown[])[0], 'ignore');
  assert.equal(starter.isRunning(), true);
  assert.equal(readStatus(dir.wazeDir).state, 'starting');
  assert.equal(readStatus(dir.wazeDir).message, 'Starting Waze setup');
  assert.ok(fs.existsSync(path.join(dir.wazeDir, 'setup-helper.log')), 'its output goes to setup-helper.log, as core does');
});

test('a start while the helper runs does not start another one', () => {
  const dir = install();
  const { spawn, calls } = fakeSpawn();
  const starter = new SetupStarter({ wazeDir: dir.wazeDir, dataRoot: dir.root, helper: () => dir.script, spawn });
  starter.start();
  starter.start();
  assert.equal(calls.length, 1);
});

test('once the helper has exited, the next start runs it again', () => {
  const dir = install();
  const { spawn, calls, children } = fakeSpawn();
  const starter = new SetupStarter({ wazeDir: dir.wazeDir, dataRoot: dir.root, helper: () => dir.script, spawn });
  starter.start();
  children[0].emit('exit', 0);
  assert.equal(starter.isRunning(), false);
  starter.start();
  assert.equal(calls.length, 2);
});

test('with no helper, start is refused with core\'s message, and nothing is written or run', () => {
  const dir = install();
  const { spawn, calls } = fakeSpawn();
  const none = new SetupStarter({ wazeDir: dir.wazeDir, dataRoot: dir.root, helper: () => null, spawn });
  assert.throws(() => none.start(), { message: SETUP_HELPER_MISSING });
  const gone = new SetupStarter({ wazeDir: dir.wazeDir, dataRoot: dir.root, helper: () => path.join(dir.root, 'nowhere.mjs'), spawn });
  assert.throws(() => gone.start(), { message: 'This installation does not include the Waze setup helper' });
  assert.equal(calls.length, 0);
  assert.equal(gone.isRunning(), false);
  assert.equal(fs.existsSync(path.join(dir.wazeDir, 'setup.json')), false, 'no setup state is written for a refused start');
});

test('a helper that cannot be started is recorded as failed, and a retry can start', () => {
  const dir = install();
  const { spawn, calls, children } = fakeSpawn();
  const starter = new SetupStarter({ wazeDir: dir.wazeDir, dataRoot: dir.root, helper: () => dir.script, spawn });
  starter.start();
  children[0].emit('error', new Error('spawn ENOENT'));
  assert.equal(starter.isRunning(), false);
  const failed = readStatus(dir.wazeDir);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.message, 'Setup helper could not start');
  starter.start();
  assert.equal(calls.length, 2);
});

test('a spawn that throws is passed on, and does not leave the starter stuck as running', () => {
  const dir = install();
  let fail = true;
  const { spawn, calls } = fakeSpawn();
  const flaky: SpawnFn = (command, args, options) => {
    if (fail) throw new Error('EACCES');
    return spawn(command, args, options);
  };
  const starter = new SetupStarter({ wazeDir: dir.wazeDir, dataRoot: dir.root, helper: () => dir.script, spawn: flaky });
  assert.throws(() => starter.start(), { message: 'EACCES' });
  assert.equal(starter.isRunning(), false, 'core would leave this set; the plugin clears it');
  fail = false;
  starter.start();
  assert.equal(calls.length, 1);
});

test('a waze folder that cannot be made is refused before anything runs', () => {
  const dir = install();
  fs.writeFileSync(dir.wazeDir, 'a file, not a folder');
  const { spawn, calls } = fakeSpawn();
  const starter = new SetupStarter({ wazeDir: dir.wazeDir, dataRoot: dir.root, helper: () => dir.script, spawn });
  assert.throws(() => starter.start());
  assert.equal(calls.length, 0);
});

test('the helper is the WAZE_SETUP_HELPER path when one is set, or the checkout the server runs from', () => {
  const explicit = path.join(base, 'custom', 'setup.mjs');
  assert.equal(setupHelperPath({ WAZE_SETUP_HELPER: `  ${explicit}  ` } as NodeJS.ProcessEnv, undefined), path.resolve(explicit));
  assert.equal(setupHelperPath({} as NodeJS.ProcessEnv, ''), null, 'no entry point, no helper');

  // Core's server entry sits two folders below the checkout: server/dist/index.js or server/src/index.ts.
  const checkout = path.join(base, 'photoscout');
  assert.equal(setupHelperPath({} as NodeJS.ProcessEnv, path.join(checkout, 'server', 'dist', 'index.js')), path.join(checkout, 'scripts', 'setup-waze.mjs'));
  assert.equal(setupHelperPath({} as NodeJS.ProcessEnv, path.join(checkout, 'server', 'src', 'index.ts')), path.join(checkout, 'scripts', 'setup-waze.mjs'));
});
