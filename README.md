# Waze police & hazards (PhotoScout plugin)

A PhotoScout plugin, `map.24thframe.waze`, that shows Waze police, hazard and road reports from a
self-hosted harvester, plus a police heatmap built from sightings it has seen.

This repo holds the **server half** (three routes under `/api/plugins/map.24thframe.waze/`) and the
**web half** (the map layers, legend toggles, popup, heatmap time window, Settings tab and Drive warnings),
both built into one zip.

- `GET /status[?check=1]`: whether the harvester is configured and reachable, and its setup state.
- `GET /alerts?minLng=&minLat=&maxLng=&maxLat=[&priority=navigation]`: reports in a box, cached per 0.05 degree cell for 60 s.
- `GET /heatmap?minLng=&minLat=&maxLng=&maxLat=[&windowMs=]`: police sightings from the plugin's own database, one hour to seven days. Map views and the scheduled area monitor both fill it.

The server half also runs an opt-in scheduled poll over areas you set in Settings, so the heatmap keeps
filling in when nobody has the map open (see "Scheduled area monitoring").

The web half is `src/web.ts`, written against the web plugin API (`src/sdk/web-api.ts`) and nothing from
the core app. It uses only the types of maplibre-gl and geojson, and bundles to `web.js`.

## What it needs

- **A running harvester.** It runs Waze on a controlled Android emulator and answers `GET /alerts` and
  `GET /health`. It is in `harvester/`, a copy of PhotoScout's `services/waze-harvester`. Container setup
  is in `harvester/README.md`. That README is written for the PhotoScout repo, so its commands
  (`npm run waze:setup`, `docker-compose.waze-reports.yml`) run from there.
- **The same harvester for monitoring.** A scheduled poll asks the harvester as a map view does. If the
  harvester is down, each poll records that as its result, and the next poll tries again.
- **PhotoScout with plugin API `^1.0`** (`"photoscout": "^1.0"`, which host API 1.1.0 satisfies). The web half
  also uses web API 2.0.0 (the Drive `fix`, `showPopup` and `addImage`, and the `speak` result). The manifest
  cannot state a web range, so run it against a PhotoScout that has 2.0.0.

## Settings

| Setting | Meaning |
|---|---|
| Harvester address | Base address only, e.g. `http://127.0.0.1:8098`. The host and port must be one of the declared hosts below. A full `.../alerts` address is accepted too. |
| Harvester API key | The harvester's `SERVICE_API_KEY`, sent as `X-API-Key`. Stored as a secret; the settings page shows only whether it is set. |
| Monitored areas | Optional, and empty by default. Boxes to poll on a schedule, each `minLng,minLat,maxLng,maxLat`, separated by semicolons; up to 10. See "Scheduled area monitoring". |
| Poll every (minutes) | How often the monitored areas are polled: 1 to 1440, default 5. It applies when the schedule starts; see "Scheduled area monitoring". |

If the address is left empty, the plugin reads the core app's `data/waze/runtime.json` (read only) as a
fallback for an install that predates the plugin. The plugin never writes that file.

## Scheduled area monitoring

A map view records police reports only while someone has the map open. The monitor polls the areas you list,
on a schedule, so the heatmap keeps filling in while nobody is looking. It is **off by default**: with no area
set, the plugin registers no task and asks the harvester for nothing.

**Areas.** Each area is one box, `minLng,minLat,maxLng,maxLat` (the map's query order). The settings form takes
a single line, so separate areas with semicolons:

```
151.10,-33.95,151.30,-33.80; 144.90,-37.85,145.05,-37.75
```

Newlines also separate areas. An entry that does not parse, is out of range, is listed twice, or passes the
limit of 10 is ignored and written to the plugin's log; the other entries are still monitored. A box is widened
to whole 0.05 degree cells (about 5 km), as the map's cache does.

**Interval.** The default is 5 minutes, and the range is 1 to 1440. The host checks its tasks once a minute, so
one minute is the shortest interval. Adding the first area starts the schedule with the interval set at that
moment. After that, a changed interval applies only when the plugin next starts: disable and enable the plugin,
or restart the server. Changed areas apply at the next poll, with no restart.

**What a poll does.** For each area in turn, the plugin asks the harvester for its reports, as a map view does,
through the same 60 second cache, so a map view and the monitor share one scan per cell. A fresh or stale answer
is recorded, as the alerts route records it, and only police reports go into the heatmap. A queued answer carries
no reports, and an answer from the cache was recorded already, so it is not counted again. If the harvester has the area queued or scanning, the plugin asks again up to three times,
a few seconds apart. An area still queued is skipped until the next poll.

**Failures.** A harvester that is down, busy or answering badly ends the poll at the area that failed. That
failure is the task's last result, and the next poll starts with the area after it, so one bad area cannot keep
the others from being polled. A poll does not start a new area once two minutes have passed in it.

**Priority and coverage.** The harvester accepts only `map` and `navigation` as priority, so a scheduled poll
asks at `map`, the same as a map view. It shares the harvester's queue with map views, and it never jumps ahead of
navigation. The harvester scans one point per area, the middle of the box, and returns the reports Waze loads
around it. A large box is only partly covered, so keep each area to a neighbourhood.

**Where to see it.** The core app lists the task at `GET /api/tasks` (admins only), with its last result and its
log, and an admin can run it from there. Its name is "Waze police & hazards: Police reports for monitored areas".

**Turning it off.** Clear the monitored areas: each scheduled run then does nothing. Disabling the plugin stops
the task. The plugin declares a `tasks` permission for this background poll, which the admin sees at install.

## Setup from Settings

An admin's **Set up Waze reports** button posts to `POST /setup`, which starts the same helper the core app
runs, `scripts/setup-waze.mjs`, with the same state in `<DATA>/waze/setup.json`. The helper ships in the
PhotoScout checkout, not in this zip, so the plugin runs it from there:

- by default, the checkout the server was started from (`scripts/setup-waze.mjs`, two folders above the
  server's entry file, as core computes its own root);
- or the path in `WAZE_SETUP_HELPER`, when the server runs from somewhere else.

With neither, the button answers "This installation does not include the Waze setup helper", as core does.
The `POST` answers 202 with the setup state and 503 with the reason; it is refused with 403 to anyone who is
not an admin.

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

`npm run build` writes `dist/map.24thframe.waze-1.1.0.zip`, which holds `plugin.json`, `server.js` and `web.js`
and nothing else. The tests include a check with PhotoScout's own validator when a PhotoScout checkout is
beside this repo (or `PHOTOSCOUT_CLI` names its `scripts/plugin.mjs`):

```sh
node ../photoscout/scripts/plugin.mjs validate .
```

## Install

In PhotoScout, an admin opens Settings, then Plugins, then "Upload plugin", and chooses the zip. Then set
the harvester address and key on the plugin's settings page, and any areas to monitor if wanted.

## Layout

| Path | What |
|---|---|
| `plugin.json` | manifest: id, routes the public may read, network and task permissions, settings |
| `src/server.ts` | the plugin: routes, settings, the health probe, the monitor's registration and its settings listener |
| `src/monitor.ts` | the scheduled area poll: the area and interval settings, and `AreaMonitor`, one pass over the areas |
| `src/feed.ts` | harvester address rules, alert and health fetches, the 60 s scan cache |
| `src/sightings.ts` | the police sightings table, the heatmap query, pruning, and `SightingKeeper`, which keeps fresh answers for the alerts route and the monitor |
| `src/setup.ts` | the setup view for Settings, and the core runtime-file fallback |
| `src/setupStart.ts` | starting the core setup helper for `POST /setup`, once at a time |
| `src/web.ts` | the web half: legend toggles, map layers, popup, heatmap corner, Settings tab, Drive source |
| `src/web/` | the web half's helpers: report and heatmap wording, the status text, the DOM views, the Drive rules (`drive.ts`) |
| `src/sdk/server-api.ts` | a copy of PhotoScout's server plugin types (see below) |
| `src/sdk/web-api.ts` | a copy of PhotoScout's web plugin API (see below) |
| `build.mjs` | bundles `src/server.ts` to `server.js` and `src/web.ts` to `web.js`, and writes the zip |
| `test/` | unit tests, route tests through a fake host, and a build and load smoke test |
| `harvester/` | a verbatim copy of PhotoScout's `services/waze-harvester` |

`src/sdk/server-api.ts` and `src/sdk/web-api.ts` are vendored from `@photoscout/plugin-sdk` 2.0.0 (PhotoScout's
`packages/plugin-sdk`): the server contract at host API 1.1.0, and the web contract at web API 2.0.0. Check them
against a PhotoScout checkout with `node ../photoscout/scripts/plugin.mjs sdk-check . --sdk ../photoscout`, and
re-copy with `--write` when the SDK moves. Do not edit the copies.

The web copy's `maplibre-gl`, `geojson` and `react` imports are type-only and are dev dependencies here.

## Not done yet

- **Drive, with the 2.0.0 API.** The banner uses the route ahead (`filter: 'route-ahead'`) under the host's
  default tuning (`tuning` is not set). The warning is spoken with `speak`, keyed by report; a refusal is logged
  when its reason changes. The status line follows the feed, the on/off button defaults to on, and the pins run
  while planning (`runs: 'always'`). A tap on a pin opens the host's popup (`ctx.showPopup`), and the pin icons go
  in through `ctx.addImage`. The plugin keeps its own rule that only the nearest warning within 800 m along the
  route is spoken, because the host gates speech on the fix's age and accuracy, not on distance.
- **Setup from the plugin** runs the core helper from the checkout (see "Setup from Settings"). It does not
  run from the plugin zip, so an install that keeps the helper elsewhere must set `WAZE_SETUP_HELPER`.
- **The signed-in user.** `/alerts` and `/status` read `req.user` to tell a visitor from a member and an
  admin, because the plugin contract has no helper for that yet. A visitor is treated as the less
  privileged case.
- **Monitor status in the web half.** The Settings tab does not show the monitor's last run. The core task
  list does (see "Scheduled area monitoring").
- **Interval changes without a restart.** The host fixes a task's interval when the task is registered, so a
  changed interval waits for the plugin to start again. Areas do not wait.
