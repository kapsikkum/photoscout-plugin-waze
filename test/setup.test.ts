// Ported from PhotoScout server/test/wazeRuntime.test.ts, plus the core runtime-file fallback.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIRST_RUN_MESSAGE, coreWazeDir, presentWazeSetup, readMigratedRuntime, readSetupFile } from '../src/setup.js';
import { tempDataDir } from './harness.js';

const HOW = 'Waze needs its first-run screen completed once. On the machine running the worker, run: adb connect 127.0.0.1:5556';
const idle = { state: 'starting', message: 'Waiting for Waze reports', updatedAt: 1 };
const waiting = { state: 'needs_first_run', message: 'Waze needs its one-time first-run screen', updatedAt: 2, first_run: { how: HOW } };

const temp = tempDataDir();
after(() => temp.cleanup());

test('a worker waiting on its welcome screen maps to needs_first_run; instructions reach admins only', () => {
  const health = { setupStage: 'needs_first_run', firstRun: { detectedAt: 1234, how: HOW } };
  const admin = presentWazeSetup(idle, health, { admin: true });
  assert.equal(admin.state, 'needs_first_run');
  assert.equal(admin.message, FIRST_RUN_MESSAGE);
  assert.deepEqual(admin.first_run, { detected_at: 1234, how: HOW });

  const visitor = presentWazeSetup(idle, health);
  assert.equal(visitor.state, 'needs_first_run');
  assert.deepEqual(visitor.first_run, { detected_at: 1234 });
  assert.equal(JSON.stringify(visitor).includes('adb connect'), false, 'visitors never receive operator instructions');
});

test('a saved needs_first_run record keeps its instructions for admins while the worker is unreachable', () => {
  assert.equal(presentWazeSetup(waiting, null, { admin: true }).first_run?.how, HOW);
  assert.equal(presentWazeSetup(waiting, null).first_run?.how, undefined);
});

test('once the worker has moved past its welcome screen, a stale saved record stops asking for a person', () => {
  const view = presentWazeSetup(waiting, { setupStage: 'connecting_waze', firstRun: null }, { admin: true });
  assert.equal(view.state, 'starting');
  assert.equal(view.first_run, undefined);
});

test('other setup states pass through unchanged and carry no first-run data', () => {
  const failed = { state: 'failed', message: 'Waze has not returned reports yet', updatedAt: 3 };
  assert.deepEqual(presentWazeSetup(failed, { setupStage: 'connecting_waze', firstRun: null }, { admin: true }),
    { state: 'failed', message: 'Waze has not returned reports yet', updatedAt: 3 });
  assert.deepEqual(presentWazeSetup({ state: 'not_started', message: 'Waze report setup has not run', updatedAt: null }, null),
    { state: 'not_started', message: 'Waze report setup has not run', updatedAt: null });
});

test('a missing setup file reads as not started', () => {
  assert.deepEqual(readSetupFile(path.join(temp.dataDir, 'no-such-waze-dir')), { state: 'not_started', message: 'Waze report setup has not run', updatedAt: null });
});

test('the core app folder is three levels above the plugin data folder', () => {
  assert.equal(coreWazeDir(temp.dataDir), temp.wazeDir);
});

test('the core runtime file supplies a url and key as a read-only fallback', () => {
  fs.mkdirSync(temp.wazeDir, { recursive: true });
  fs.writeFileSync(path.join(temp.wazeDir, 'runtime.json'), JSON.stringify({ url: 'http://127.0.0.1:8098/alerts', key: 'migrated-key' }));
  assert.deepEqual(readMigratedRuntime(temp.wazeDir), { url: 'http://127.0.0.1:8098/alerts', key: 'migrated-key' });
  assert.deepEqual(readMigratedRuntime(path.join(temp.dataDir, 'nowhere')), {});
  fs.writeFileSync(path.join(temp.wazeDir, 'runtime.json'), '{ not json');
  assert.deepEqual(readMigratedRuntime(temp.wazeDir), {}, 'a damaged file is ignored, not thrown');
});
