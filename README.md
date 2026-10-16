# Waze police & hazards (PhotoScout plugin)

A PhotoScout plugin, `map.24thframe.waze`, that shows Waze police, hazard and road reports from a
self-hosted harvester, plus a police heatmap built from sightings it has seen.

This repo holds the **server half** (three routes under `/api/plugins/map.24thframe.waze/`) and the
**web half** (the map layers, legend toggles, popup, heatmap time window, Settings tab and Drive warnings),
both built into one zip.

- `GET /status[?check=1]`: whether the harvester is configured and reachable, and its setup state.
- `GET /alerts?minLng=&minLat=&maxLng=&maxLat=[&priority=navigation]`: reports in a box, cached per 0.05 degree cell for 60 s.
- `GET /heatmap?minLng=&minLat=&maxLng=&maxLat=[&windowMs=]`: police sightings from the plugin's own database, one hour to seven days.

The web half is `src/web.ts`, written against the web plugin API (`src/sdk/web-api.ts`) and nothing from
the core app. It uses only the types of maplibre-gl and geojson, and bundles to `web.js`.

## What it needs

- **A running harvester.** It runs Waze on a controlled Android emulator and answers `GET /alerts` and
  `GET /health`. It is in `harvester/`, a copy of PhotoScout's `services/waze-harvester`. Container setup
  is in `harvester/README.md`. That README is written for the PhotoScout repo, so its commands
  (`npm run waze:setup`, `docker-compose.waze-reports.yml`) run from there.
- **PhotoScout with plugin API 1.0** (`"photoscout": "^1.0"`).

## Settings

| Setting | Meaning |
|---|---|
| Harvester address | Base address only, e.g. `http://127.0.0.1:8098`. The host and port must be one of the declared hosts below. A full `.../alerts` address is accepted too. |
| Harvester API key | The harvester's `SERVICE_API_KEY`, sent as `X-API-Key`. Stored as a secret; the settings page shows only whether it is set. |

If the address is left empty, the plugin reads the core app's `data/waze/runtime.json` (read only) as a
fallback for an install that predates the plugin. The plugin never writes that file.

## Network permissions

The plugin reaches only these three hosts, each an exact host and port:

| Entry | Who it is for |
|---|---|
| `127.0.0.1:18199` | a tunnel to a harvester on another machine |
| `127.0.0.1:8098` | a standalone harvester on this machine (the default port) |
| `waze-reports:8088` | the harvester as a Compose service |

The host's `ctx.fetch` opens only the declared host and port (no wildcards), and refuses every other private
address. The plugin also checks the configured address against the same list before it sends anything, so
the API key never goes to a public address.

**Limit.** Permissions are fixed in `plugin.json`, but the harvester address is set at runtime. A harvester
on any other host or port must be added to `plugin.json` and the plugin re-published. There is no way to
add one from the settings page.

## The harvester APK is never in a public image

- No Waze APK is in this repo, the plugin zip, or the harvester image. `harvester/.dockerignore` excludes
  `*.apk`, `*.apkm`, `*.apks` and `*.xapk`.
- The Waze installer is fetched or supplied at setup and copied into the emulator's own Android volume.
- The harvester image build also downloads Magisk and a PlayIntegrityFix module for rooting the emulator.
  Those are third-party tools, not the Waze APK, and they are in the image.

## Build and check

```sh
npm install
npm run check        # typecheck, tests, then the build
```

`npm run build` writes `dist/map.24thframe.waze-1.0.0.zip`, which holds `plugin.json` and `server.js` and
nothing else. The tests include a check with PhotoScout's own validator when a PhotoScout checkout is
beside this repo (or `PHOTOSCOUT_CLI` names its `scripts/plugin.mjs`):

```sh
node ../photoscout/scripts/plugin.mjs validate .
```

## Install

In PhotoScout, an admin opens Settings, then Plugins, then "Upload plugin", and chooses the zip. Then set
the harvester address and key on the plugin's settings page.

## Layout

| Path | What |
|---|---|
| `plugin.json` | manifest: id, routes the public may read, network permissions, settings |
| `src/server.ts` | the plugin: routes, settings, the health probe, sighting records and pruning |
| `src/feed.ts` | harvester address rules, alert and health fetches, the 60 s scan cache |
| `src/sightings.ts` | the police sightings table, the heatmap query, pruning |
| `src/setup.ts` | the setup view for Settings, and the core runtime-file fallback |
| `src/web.ts` | the web half: legend toggles, map layers, popup, heatmap corner, Settings tab, Drive source |
| `src/web/` | the web half's helpers: report and heatmap wording, the status text, the DOM views |
| `src/sdk/server-api.ts` | a copy of PhotoScout's server plugin types (see below) |
| `src/sdk/web-api.ts` | a copy of PhotoScout's web plugin API (see below) |
| `build.mjs` | bundles `src/server.ts` to `server.js` and `src/web.ts` to `web.js`, and writes the zip |
| `test/` | unit tests, route tests through a fake host, and a build and load smoke test |
| `harvester/` | a verbatim copy of PhotoScout's `services/waze-harvester` |

`src/sdk/server-api.ts` is a copy of `server/src/plugins/types.ts` from PhotoScout, types only. It is
replaced by `@photoscout/plugin-sdk` when that exists. Re-copy it when the host API changes.

`src/sdk/web-api.ts` is a copy of `web/src/plugins/api.ts` from PhotoScout, types and `definePlugin` only.
Its `maplibre-gl`, `geojson` and `react` imports are type-only and are dev dependencies here.

## Not done yet

- **Drive is partial.** The web API's Drive source gets the nearest report within 800 m, straight line. The
  core app also filters to the route ahead, speaks the warning, and has an on/off button and status hints.
  None of those are in the web API yet, so they stay in the core app until the API grows.
- **Setup from the plugin.** The plugin reports setup but cannot start it. The Settings setup button and
  `POST /setup` stay in the core app until the core Waze code is removed.
- **The signed-in user.** `/alerts` and `/status` read `req.user` to tell a visitor from a member and an
  admin, because the plugin contract has no helper for that yet. A visitor is treated as the less
  privileged case.
