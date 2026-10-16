# Waze police and hazard reports

This bridge runs Waze on a controlled Android emulator and reads its realtime police and hazard reports. It exposes only report locations, types, descriptions and times; reporter identity and session credentials are not returned. It does not mint or require a Firebase App Check token.

For a native PhotoScout install, start Docker with Linux containers or Podman, then run `npm run waze:setup` from the repository root, or use the admin setup button in Settings → Waze. The helper builds the self-contained image, creates its persistent Android volume, generates an API key in `data/waze/runtime.json`, and saves the connection. That file is private and ignored by Git. The existing-emulator option requires a rooted test emulator with Waze and the matching Frida server already installed; it does not modify a physical phone.

`Dockerfile.emulator` targets x86-64 Linux and uses software emulation without KVM, privileged mode or a Docker socket. Docker Desktop on Windows provides the Linux runtime. Reserve about 6 GB RAM, several GB disk and 4 CPUs for Android; the emulator uses `WAZE_EMULATOR_CORES` (default 4) and `WAZE_EMULATOR_MEMORY_MB` (default 3072), which must fit the container's limits. First software boot can take 15–30 minutes on a slow VM. With `/dev/kvm` the emulator uses KVM automatically (`WAZE_EMULATOR_ACCEL=auto|on|off`); setup passes the device through, and Compose users add `docker-compose.waze-kvm.yml`. If the kernel logs `SVM disabled (by BIOS)` or `VMX disabled`, enable AMD SVM / Intel VT-x in firmware; a VM host also needs nested virtualization. ARM hosts need an x86-64 Linux worker; a native ARM software-emulator image is not provided. Fresh software boot and app onboarding are still under verification; setup reports failures rather than supplying mock alerts.

The installer downloads the pinned Waze version through apkeep, then uses the Android SDK's `apksigner` to verify every APK, including splits, against Waze's published signing certificates. It also checks the package name and base app version before installation. A supplied `WAZE_APK_PATH` goes through the same checks. Invalid signatures, another publisher or a mismatched version stop setup.

### Android image

The default image is `system-images;android-36;google_apis;x86_64`, the newest stable Google APIs x86_64 image, with AVD `photoscout-api36`. Google APIs images allow `adb root`, which the Frida server needs; Play Store images do not. Set `WAZE_SYSTEM_IMAGE` (a build argument as well as a runtime variable; `npm run waze:setup` passes it to the build) to choose another Google APIs x86_64 image. Each image has its own AVD, so changing the image creates a fresh Android device: Waze is reinstalled and its first-run screen appears again. The previous Android 12 volume (`photoscout-api31`) keeps working only when built and run with `WAZE_SYSTEM_IMAGE=system-images;android-31;google_apis;x86_64`.

### First-run screen

Waze shows welcome screens the first time it runs on a new Android volume. The server operator completes them once, and the result is kept on the volume. The worker detects this read-only: every 60 seconds while no reports arrive, it dumps the screen layout with `uiautomator` and looks for Waze's welcome-screen identifiers. It never sends taps, text or swipes. When it finds the welcome screen, `/health` reports `setup_stage: needs_first_run` with `first_run.how`; setup prints the same steps, and Settings → Waze shows them to admins. Reports start after the screens are complete, and the state clears itself.

To complete the screens, enable screen access and re-run setup (`npm run waze:setup -- --screen-access`, or set `WAZE_SCREEN_ACCESS=1` in the server environment for the Settings button):

```sh
adb connect 127.0.0.1:5556 && scrcpy -s 127.0.0.1:5556
```

Run this on the machine that runs the worker, complete Waze's welcome screens, then close scrcpy. On a remote server, forward the port first with `ssh -L 5556:127.0.0.1:5556 <server>`. Screen access publishes the emulator's adb port on `127.0.0.1:5556` only: anyone who can reach that port has full adb control of the Android guest, so keep it on loopback. Without screen access the port stays closed, and the worker keeps reporting `needs_first_run`.

The Android image needs ARM64 native libraries, because Waze's bundle is ARM64. A mirror can return an ARMv7 bundle even when ARM64 was requested; setup checks the actual libraries and reports that a compatible installer is needed. Download an ARM64 Waze 5.25.0.1 APK bundle through its normal download page, then use `npm run waze:setup -- --apk "path/to/waze.apkm"`. Alternatively, save the bundle as `data/waze/installer.apkm` and retry the Settings button. The helper copies that installer into the owned Android volume; no host folder or container socket is mounted. Publisher verification still applies. For a separately managed bridge container, mount the file read-only and set `WAZE_APK_PATH` to its container path.

For an app already running in containers, use the Compose integration after creating a shared random key:

```sh
export WAZE_HARVESTER_API_KEY="$(openssl rand -hex 32)"
docker compose -f docker-compose.yml -f docker-compose.waze-reports.yml up -d --build
```

Retain the key in your deployment's secret configuration for later restarts. The Compose override connects the app to `waze-reports:8088`; it does not mount the host's Docker socket. The standalone bridge service is also usable with a native app on loopback port 8098.

`GET /health` reports boot progress, connectivity and queue counts without report locations or secrets. `GET /alerts` requires `X-API-Key`. Bounds (`minLng`, `minLat`, `maxLng`, `maxLat`) queue an area scan; omit bounds to inspect current reports without moving the emulator. Pending scans return 202, an overloaded queue returns 429, and unavailable scans return 503. Nearby requests coalesce, each area's snapshot expires, and navigation requests have bounded priority so browsing still progresses.

Coverage is the area loaded by Waze, not guaranteed complete coverage of every visible road. An empty response does not prove that a road is clear. Police uses an officer icon; mobile speed camera reports use a separate roadside camera symbol. Waze can require onboarding or change its protocol, so a service that previously worked may require attention after an app update. Keep the Android volume when upgrading.

Install `requirements-dev.txt` to run all decoder, queue, API, bootstrap, first-run and image tests with `python -m pytest -q` from `services/waze-harvester` (or `python -m unittest discover -s services/waze-harvester -p 'test_*.py'`). The decoder and queue tests also run with just the runtime dependencies using `-p 'test_report*.py'`. Visual navigation verification under `web/test/fixtures` uses live reports with explicitly simulated GPS and routing.
