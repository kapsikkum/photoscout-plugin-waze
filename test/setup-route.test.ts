// POST /setup through the fake host (core's POST /api/waze/setup): the admin gate, the 202 and 503 answers,
// and one real run of a small helper that records how it was started.
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_HELPER_MISSING } from '../src/setupStart.js';
import { activatePlugin, call, callPost, tempDataDir } from './harness.js';

const ADMIN = { role: 'admin' };
const MEMBER = { role: 'member' };

/** Run `fn` with WAZE_SETUP_HELPER set to `value`, then put the environment back. */
async function withHelper<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env.WAZE_SETUP_HELPER;
  if (value === undefined) delete process.env.WAZE_SETUP_HELPER;
  else process.env.WAZE_SETUP_HELPER = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.WAZE_SETUP_HELPER;
    else process.env.WAZE_SETUP_HELPER = before;
  }
}

test('POST /setup is for admins: anyone else is refused, and nothing starts', async () => {
  const temp = tempDataDir();
  try {
    const p = await activatePlugin({ dataDir: temp.dataDir });
    const signedOut = await callPost(p.router, '/setup', null);
    assert.equal(signedOut.status, 403);
    assert.deepEqual(signedOut.json, { error: 'Admins only' });
    const member = await callPost(p.router, '/setup', MEMBER);
    assert.equal(member.status, 403);
    assert.deepEqual(member.json, { error: 'Admins only' });
    assert.equal(fs.existsSync(path.join(temp.wazeDir, 'setup.json')), false, 'a refused request writes no setup state');
  } finally {
    temp.cleanup();
  }
});

test('with no helper on this install, an admin is answered 503 with core\'s message', async () => {
  const temp = tempDataDir();
  try {
    await withHelper(path.join(temp.wazeDir, 'missing-helper.mjs'), async () => {
      const p = await activatePlugin({ dataDir: temp.dataDir });
      const res = await callPost(p.router, '/setup', ADMIN);
      assert.equal(res.status, 503);
      assert.deepEqual(res.json, { error: SETUP_HELPER_MISSING });
      assert.equal(fs.existsSync(path.join(temp.wazeDir, 'setup.json')), false);
    });
  } finally {
    temp.cleanup();
  }
});

test('an admin starts the helper: 202 with the setup state, and the helper runs from the checkout with the core data root', async () => {
  const temp = tempDataDir();
  const base = path.dirname(temp.wazeDir);
  const helper = path.join(base, 'scripts', 'setup-waze.mjs');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const dir = path.join(process.env.DATA_DIR, 'waze');",
    "fs.mkdirSync(dir, { recursive: true });",
    "fs.writeFileSync(path.join(dir, 'helper-ran.json'), JSON.stringify({ dataDir: process.env.DATA_DIR, cwd: process.cwd() }));",
  ].join('\n'));
  try {
    await withHelper(helper, async () => {
      const p = await activatePlugin({ dataDir: temp.dataDir });
      const res = await callPost(p.router, '/setup', ADMIN);
      assert.equal(res.status, 202);
      assert.equal(res.json.state, 'starting');
      assert.equal(res.json.message, 'Starting Waze setup');
      assert.equal(typeof res.json.updatedAt, 'number');
      assert.equal('first_run' in res.json, false, 'the answer carries no operator instructions, as core\'s does');

      const marker = path.join(temp.wazeDir, 'helper-ran.json');
      for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(fs.existsSync(marker), 'the helper ran');
      const ran = JSON.parse(fs.readFileSync(marker, 'utf8')) as { dataDir: string; cwd: string };
      assert.equal(fs.realpathSync.native(ran.dataDir), fs.realpathSync.native(base), 'DATA_DIR is the core data root');
      assert.equal(fs.realpathSync.native(ran.cwd), fs.realpathSync.native(base), 'it runs from the checkout root');

      const status = await call(p.router, '/status');
      assert.equal(status.json.setup.state, 'starting', 'GET /status reports the state the POST started');
      assert.equal(fs.existsSync(path.join(temp.wazeDir, 'setup-helper.log')), true);
    });
  } finally {
    temp.cleanup();
  }
});

test('a setup folder that cannot be made is answered 503 with the reason, and nothing starts', async () => {
  const temp = tempDataDir();
  const base = path.dirname(temp.wazeDir);
  const helper = path.join(base, 'scripts', 'setup-waze.mjs');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, '// not run');
  fs.writeFileSync(temp.wazeDir, 'a file where the waze folder should be');
  try {
    await withHelper(helper, async () => {
      const p = await activatePlugin({ dataDir: temp.dataDir });
      const res = await callPost(p.router, '/setup', ADMIN);
      assert.equal(res.status, 503);
      assert.equal(typeof res.json.error, 'string');
      assert.ok(res.json.error.length > 0, 'the reason is given');
      assert.equal(res.json.state, undefined);
    });
  } finally {
    temp.cleanup();
  }
});
