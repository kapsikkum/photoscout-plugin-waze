// Builds the plugin package dist/<id>-<version>.zip: plugin.json, server.js and web.js at the root.
// src/server.ts is bundled with every import inlined (no externals), so the host needs nothing
// beyond the zip. src/web.ts is the browser half (the SPA import()s web.js); it imports only types
// from the web API (src/sdk/web-api.ts), and React comes from host.ui.react, so nothing is external.
// Only the files named here go in the zip: never harvester/, test/ or any APK.
// Same shape as plugins/radio-garden/build.mjs in PhotoScout. Run: npm run build
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { unzipSync, zipSync } from 'fflate';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Build the package under `root` and return where it went. Throws on anything the host would refuse. */
export async function buildPlugin(root = here) {
  const manifestBytes = fs.readFileSync(path.join(root, 'plugin.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.server !== 'server.js') throw new Error(`plugin.json "server" must be "server.js", not "${manifest.server}"`);
  if (manifest.web !== undefined && manifest.web !== 'web.js') throw new Error(`plugin.json "web" must be "web.js", not "${manifest.web}"`);

  const dist = path.join(root, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });

  await build({
    entryPoints: [path.join(root, 'src', 'server.ts')],
    outfile: path.join(dist, 'server.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: [],
    legalComments: 'none',
    logLevel: 'warning',
  });

  // The bundle must load on its own and default-export an object with activate(), as the host requires.
  const mod = await import(pathToFileURL(path.join(dist, 'server.js')).href);
  if (typeof mod.default?.activate !== 'function') throw new Error('server.js must default-export an object with an activate() function');

  const files = { 'plugin.json': manifestBytes, 'server.js': fs.readFileSync(path.join(dist, 'server.js')) };

  if (manifest.web) {
    await build({
      entryPoints: [path.join(root, 'src', 'web.ts')],
      outfile: path.join(dist, 'web.js'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      external: [],
      legalComments: 'none',
      logLevel: 'warning',
    });
    // The web bundle is loaded in the browser, but it must also import in Node: nothing it runs at load
    // may touch the DOM. Its default export must be an object with activate(), as the SPA requires.
    const web = await import(pathToFileURL(path.join(dist, 'web.js')).href);
    if (typeof web.default?.activate !== 'function') throw new Error('web.js must default-export an object with an activate() function');
    files[manifest.web] = fs.readFileSync(path.join(dist, manifest.web));
  }

  const zipBytes = zipSync(files, { level: 9 });

  // Read the package back, as a check that the zip holds what the manifest names.
  const back = unzipSync(zipBytes);
  for (const name of Object.keys(files)) {
    if (!back[name]) throw new Error(`${name} is missing from the zip`);
  }

  const zipPath = path.join(dist, `${manifest.id}-${manifest.version}.zip`);
  fs.writeFileSync(zipPath, zipBytes);
  return { zipPath, bytes: zipBytes.byteLength, entries: Object.keys(files) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildPlugin();
    console.log(`built ${path.relative(here, result.zipPath)} (${result.bytes} bytes): ${result.entries.join(', ')}`);
  } catch (err) {
    console.error(`build failed: ${err.message}`);
    process.exitCode = 1;
  }
}
