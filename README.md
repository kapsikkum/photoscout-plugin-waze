# Waze police & hazards (PhotoScout plugin)

A PhotoScout plugin (`map.24thframe.waze`) that shows Waze police, hazard and road reports on the map, plus a police heatmap. The reports come from a self-hosted **harvester**: a container that runs Waze on an Android emulator and answers PhotoScout's requests.

To run it you need three things: the harvester running, the plugin installed in PhotoScout, and the plugin pointed at the harvester.

## How to run it

### 1. Start the harvester

Make a random key. You will paste the same key into the plugin in step 3.

```sh
export WAZE_HARVESTER_API_KEY="$(openssl rand -hex 32)"
```

Run the published image. Replace `/absolute/path/to/waze.apkm` with the path to your Waze 5.25.0.1 bundle (see [requirements](#requirements-and-gotchas)).

```sh
docker run -d --name photoscout-waze-harvester \
  --init --restart unless-stopped \
  -p 127.0.0.1:8098:8088 \
  -e SERVICE_API_KEY="$WAZE_HARVESTER_API_KEY" \
  -e WAZE_APK_PATH=/run/waze/installer.apkm \
  -v "/absolute/path/to/waze.apkm:/run/waze/installer.apkm:ro" \
  -v photoscout-waze-android:/data \
  --shm-size 512m --memory 6g --cpus 4 \
  ghcr.io/kapsikkum/photoscout-waze-harvester:latest
```

On a Linux host that has `/dev/kvm`, add `--device /dev/kvm \` before the image name. The emulator then uses KVM and runs much faster. Leave it out elsewhere, including Docker Desktop on Windows.

Check that it answers. `/health` needs no key. The first boot takes a while, so expect `setup_stage` to move through several stages.

```sh
curl -s http://127.0.0.1:8098/health
docker logs -f photoscout-waze-harvester    # optional: watch the first boot
```

On Windows, run these in WSL, or in Git Bash with `MSYS_NO_PATHCONV=1` in front of `docker run`. Git Bash otherwise rewrites the `/data` and `/run` paths.

Other ways to start it:

- **PhotoScout's compose files.** From the PhotoScout repo, run `docker compose -f docker-compose.yml -f docker-compose.waze-reports.yml up -d --build` (add `-f docker-compose.waze-kvm.yml` on Linux with `/dev/kvm`). Set `WAZE_HARVESTER_API_KEY` first. These build PhotoScout's own copy of the image and mount no APK, so see [harvester/README.md](harvester/README.md) for the `WAZE_APK_PATH` options.
- **Build it yourself** from this repo, with `docker build -f harvester/Dockerfile.emulator -t photoscout-waze-harvester harvester`. Then use `photoscout-waze-harvester` in place of the GHCR name above. The build is several GB.

### 2. Install the plugin

1. In PhotoScout, as an admin, open **Settings → Admin → Plugins**.
2. Install the plugin one of two ways:
   - **Browse:** find **Waze police & hazards** (`map.24thframe.waze`) in the default registry, and install it.
   - **Install manually:** download `map.24thframe.waze-1.1.0.zip` from the [v1.1.0 release](https://github.com/kapsikkum/photoscout-plugin-waze/releases/tag/v1.1.0), and choose it.
3. Read the permissions the install dialog lists (the harvester's network hosts, the API key, storage and a background task), then accept.
4. Under **Installed**, make sure the plugin is switched on.

### 3. Configure the plugin

Open **Settings → Admin → Plugins → Installed → Waze police & hazards**, expand **Settings**, and fill in:

| Setting | Value |
|---|---|
| Harvester address | `http://127.0.0.1:8098` |
| Harvester API key | the value of `WAZE_HARVESTER_API_KEY` from step 1 |

The address **must** be one of the plugin's declared network hosts. The plugin sends its key to no other address:

| Address | Use it when |
|---|---|
| `http://127.0.0.1:8098` | the container from step 1 |
| `http://127.0.0.1:18199` | a tunnel to a harvester on another machine |
| `http://waze-reports:8088` | the harvester runs as a Compose service |

Any other host or port is refused. The list is fixed in the plugin's manifest, so a different host needs a new plugin release.

If you already ran PhotoScout's own Waze setup, you can leave the address empty. The plugin then falls back to the connection in `data/waze/runtime.json`, read-only.

To check the connection, open **Settings → Map → Police & hazards**. It shows the harvester's status, and admins see the setup steps there. Then open the map to see the reports.

### 4. (Optional) Keep the heatmap filling

The heatmap fills from police sightings the plugin records while someone views the map. To keep it filling when nobody has the map open, set these in the same Settings form:

- **Monitored areas:** one or more boxes, each `minLng,minLat,maxLng,maxLat`, separated by semicolons. Up to 10.

  ```
  151.10,-33.95,151.30,-33.80; 144.90,-37.85,145.05,-37.75
  ```

- **Poll every (minutes):** 1 to 1440. The default is 5.

Notes:

- Monitoring is **off by default**. Clear the areas to switch it off.
- The schedule starts when the first area is saved. A changed interval takes effect only after you disable and re-enable the plugin, or restart PhotoScout. Changed areas apply at the next poll, with no restart.
- Keep each area to a neighbourhood. The harvester scans one point per area and covers only what Waze loads around it. Boxes are widened to whole cells of about 5 km.
- Entries that do not parse are skipped and written to the plugin's log. The other areas still run.

## Requirements and gotchas

- **PhotoScout** with web plugin API 2.0.0 or newer.
- **You supply the Waze APK.** It is never in the image or the plugin. It must be Waze **5.25.0.1** exactly, as an ARM64 bundle (`.apkm`, or `.apk`), from Waze's normal download page. If you do not supply one, the container tries to download Waze itself. That can fail, or return the wrong CPU build. The container checks the APK's signature against Waze's publisher certificates and refuses anything else.
- **`/dev/kvm` makes it usable.** With KVM, the emulator is much faster. Without it, the emulator uses software emulation, and the first boot can take 15 to 30 minutes.
- **Resources.** Reserve about 6 GB of RAM, 4 CPUs and several GB of disk for the container. On Docker Desktop, give the VM at least that much memory.
- **First run is automatic.** On a new Android volume Waze shows a welcome screen once; the worker taps through it itself (`setup_stage` goes `needs_first_run` → `connecting_waze` with no input). Only if an unexpected screen blocks the auto-tap do you need the manual fallback in [harvester/README.md](harvester/README.md).
- **Port 8098 can be used once.** PhotoScout's own Waze setup, or a compose stack, may already publish `127.0.0.1:8098`. Stop it before you start this container.
- **PhotoScout must reach the harvester.** From a native PhotoScout, that is `127.0.0.1:8098`.
- **Keep the key secret.** The plugin stores it as a secret, and the settings page shows only whether one is set.
- **The GHCR image exists only after its first build.** The `harvester-image` workflow publishes it. Until then, use the local build above.

## Links

- [harvester/README.md](harvester/README.md): the container in depth (runtime, APK handling, first-run screens, API).
- Plugin registry: [kapsikkum/photoscout-plugins](https://github.com/kapsikkum/photoscout-plugins).
- Container image: [photoscout-waze-harvester on GHCR](https://github.com/users/kapsikkum/packages/container/package/photoscout-waze-harvester).
- Plugin release: [v1.1.0](https://github.com/kapsikkum/photoscout-plugin-waze/releases/tag/v1.1.0).

## For developers

```sh
npm install
npm run check        # typecheck, tests, then build dist/map.24thframe.waze-1.1.0.zip
node ../photoscout/scripts/plugin.mjs validate .
```

Routes, under `/api/plugins/map.24thframe.waze/`: `GET /status`, `GET /alerts` and `GET /heatmap`.

| Path | What |
|---|---|
| `plugin.json` | manifest: settings, network permissions, background task |
| `src/server.ts`, `src/monitor.ts`, `src/feed.ts`, `src/sightings.ts` | server routes, area monitor, harvester client, heatmap store |
| `src/web.ts`, `src/web/` | map layers, legend, popup, Drive warnings, Settings tab |
| `src/sdk/` | vendored PhotoScout plugin types. Do not edit; re-copy with PhotoScout's `sdk-check --write`. |
| `harvester/` | copy of PhotoScout's `services/waze-harvester` |
| `.github/workflows/harvester-image.yml` | builds the harvester image and pushes it to GHCR |
