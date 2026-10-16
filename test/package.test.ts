// Build and load smoke test: build the zip, extract it, load the bundles the way the host does, and
// check them against plugin.json. Then run PhotoScout's own validator when one is present.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { fakeContext, FakeRes, manifest, ROOT } from './harness.js';
import { fakeHost } from './web-harness.js';

const zipPath = path.join(ROOT, 'dist', `${manifest.id}-${manifest.version}.zip`);
const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'waze-zip-'));
after(() => fs.rmSync(extracted, { recursive: true, force: true }));

test('npm run build writes the package zip', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'build.mjs')], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(zipPath), `${zipPath} was not written`);
});

test('the zip holds plugin.json, server.js and the web bundle the manifest names, and nothing else', () => {
  const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  assert.deepEqual(Object.keys(files).sort(), ['plugin.json', 'server.js', 'web.js']);
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(extracted, name), bytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(extracted, 'plugin.json'), 'utf8')), manifest);
});

test('the manifest names its web bundle as web.js, and that file is in the zip', () => {
  assert.equal(manifest.web, 'web.js');
  const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  assert.ok(files[manifest.web!], `${manifest.web} is not in the zip`);
  // Every module is inlined: the browser loads one file and nothing else.
  assert.doesNotMatch(Buffer.from(files[manifest.web!]).toString('utf8'), /^import\s/m);
});

test('the extracted web bundle loads in Node (nothing touches the DOM at load) and activates against a host', async () => {
  const mod = await import(pathToFileURL(path.join(extracted, 'web.js')).href);
  assert.equal(typeof mod.default?.activate, 'function');
  const { host, rec } = fakeHost(() => { throw new Error('no data is requested at activation'); });
  await mod.default.activate(host);
  assert.deepEqual(rec.legend.map((d: { key: string }) => d.key), ['waze', 'police-heat']);
  assert.deepEqual(rec.tabs.map((t: { id: string }) => t.id), ['reports']);
  assert.deepEqual(rec.driveSources.map((s: { id: string }) => s.id), ['reports']);
  assert.equal(rec.corners.length, 1);
});

test('the extracted bundle loads on its own and activates against a host', async () => {
  const mod = await import(pathToFileURL(path.join(extracted, 'server.js')).href);
  assert.equal(typeof mod.default?.activate, 'function');
  const fake = fakeContext({ settings: { harvesterUrl: 'http://127.0.0.1:8098', harvesterKey: 'k' } });
  await mod.default.activate(fake.ctx);
  // An empty database answers the heatmap with no points, which exercises the bundle's own routes.
  const handler = fake.router.routes.get('/heatmap');
  assert.ok(handler);
  const res = new FakeRes();
  await handler({ query: { minLng: '151.1', minLat: '-33.95', maxLng: '151.3', maxLat: '-33.8' } }, res, () => {});
  assert.deepEqual(res.body && (res.body as { points: unknown[] }).points, []);
});

test('every public route in plugin.json is registered, and no other route is public', async () => {
  const mod = await import(pathToFileURL(path.join(extracted, 'server.js')).href);
  const fake = fakeContext({});
  await mod.default.activate(fake.ctx);
  const registered = [...fake.router.routes.keys()].sort();
  assert.deepEqual(registered, ['/alerts', '/heatmap', '/status']);
  assert.deepEqual([...(manifest.public ?? [])].sort(), registered, 'public must match the registered routes exactly');
});

test('network permissions are exact host:port entries, never wildcards, and there are no other network hosts', () => {
  const network = (manifest.permissions ?? []).filter(p => p.kind === 'network').map(p => p.detail);
  assert.deepEqual(network, ['127.0.0.1:18199', '127.0.0.1:8098', 'waze-reports:8088']);
  for (const detail of network) assert.match(detail!, /^[a-z0-9.-]+:\d+$/, `${detail} must be an exact host and port`);
});

test('the package carries no harvester code and no APK', () => {
  for (const name of Object.keys(unzipSync(new Uint8Array(fs.readFileSync(zipPath))))) {
    assert.doesNotMatch(name, /apk|harvester|test/i);
  }
});

// PhotoScout's own validator, when a checkout of it sits beside this repo (or PHOTOSCOUT_CLI names it).
const cli = process.env.PHOTOSCOUT_CLI ?? path.resolve(ROOT, '..', 'photoscout', 'scripts', 'plugin.mjs');
test('PhotoScout validates this folder as a plugin', { skip: fs.existsSync(cli) ? false : `no PhotoScout checkout at ${cli}` }, () => {
  const r = spawnSync(process.execPath, [cli, 'validate', ROOT, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [result] = JSON.parse(r.stdout) as { ok: boolean; errors: unknown[]; id: string }[];
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.id, manifest.id);
});
