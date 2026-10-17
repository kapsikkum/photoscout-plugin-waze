import type { Bbox, DriveAlert, DriveSourceContext, LegendEntry, PluginHost, PluginMapClick, SpeakRefusal, WebPlugin } from './sdk/web-api.js';
import { createHeatWindowStore, HEAT_DEFAULT_MS, heatmapGeoJSON } from './web/heat.js';
import {
  addDriveReportIcons, addHeatLayer, addReportIcons, addReportLayers, DRIVE_ICON_SIZE, EMPTY_COLLECTION, ICON_PREFIX,
  setSourceData, type PinLayerIds, type WazeLayerIds,
} from './web/layers.js';
import { alertsPath, heatmapPath, statusPath } from './web/query.js';
import { DRIVE_ERROR_TEXT, DRIVE_TICK_MS, announceNearest, driveStatusFor } from './web/drive.js';
import { driveAlerts, reportGeoJSON, reportPopup } from './web/reports.js';
import { reportsActivity } from './web/status.js';
import type { WazeAlertsResponse, WazeHeatmapResponse, WazeSetupView, WazeStatusResponse } from './web/types.js';
import { renderRangeSelector, renderStatusSettings, reportPopupElement } from './web/view.js';

/**
 * Police & hazards, web half. Everything it adds goes through the plugin web API (src/sdk/web-api.ts):
 *   - the Police & hazards legend toggle and the Police heatmap toggle (host.legend);
 *   - the report pins, with their popup (host.map.onReady, onClick, showPopup);
 *   - the heatmap, with its time window in the map corner (host.panel.addCorner);
 *   - the Settings tab: harvester status, the admin's Set up button, first-run instructions for admins,
 *     the time window (host.settings);
 *   - Drive's reports: the route-ahead banner, the spoken warning, the status line, its on/off button, and the
 *     pins on the Drive map with their popup (host.drive.addAlertSource, web API 2.0.0).
 * The data comes from this plugin's own routes, read through host.data, so nothing reaches another plugin
 * or the core app. Ported from the core app's map/waze.ts, map/policeHeat.ts, MapPage.tsx, WazeSettings.tsx
 * and the Drive screen (pages/Drive.tsx, drive/reports.ts).
 */

const WAZE_KEY = 'waze';
const HEAT_KEY = 'police-heat';
/** The core feed's cadence: reports every 30 s, the heatmap every 60 s. */
const PINS_POLL_MS = 30_000;
const HEAT_POLL_MS = 60_000;

const formatTime = (ms: number): string => new Date(ms).toLocaleTimeString();

/** The map's view as the poll gives it. The host calls `fetch` with bounds only when the map is ready. */
function boxOf(bounds: Bbox | null): Bbox {
  if (!bounds) throw new Error('The map view is not ready');
  return bounds;
}

/** Reports a failing feed once, when it starts failing, rather than on every retry. */
function failureWatch(host: PluginHost, message: string): { fail(): void; recover(): void } {
  let failing = false;
  return {
    fail: () => {
      if (failing) return;
      failing = true;
      host.activity(message, 'error');
    },
    recover: () => {
      failing = false;
    },
  };
}

const plugin: WebPlugin = {
  activate(host: PluginHost) {
    const ids: WazeLayerIds = {
      reportsSource: host.map.scopedId('reports-src'),
      reports: host.map.scopedId('reports'),
      labels: host.map.scopedId('report-labels'),
      icons: host.map.scopedId(ICON_PREFIX),
      heatSource: host.map.scopedId('police-heat-src'),
      heat: host.map.scopedId('police-heat'),
    };

    /** One window for the whole page: the corner and the Settings tab both read and write it. */
    const windowStore = createHeatWindowStore(HEAT_DEFAULT_MS);

    const wazeEntry: LegendEntry = host.legend.add({
      key: WAZE_KEY,
      label: 'Police & hazards',
      title: 'Community police and hazard reports from Waze',
      swatch: { kind: 'glyph', color: '#fbbf24', glyph: '👮' },
      defaultOn: false,
      menu: 'live',
      layers: [ids.reports, ids.labels],
    });
    const heatEntry: LegendEntry = host.legend.add({
      key: HEAT_KEY,
      label: 'Police heatmap',
      title: 'Where police reports from Waze cluster over the chosen time window; pick the window in the bottom-right corner',
      swatch: { kind: 'dot', color: 'radial-gradient(circle, #ef4444 0%, #facc15 40%, #84cc16 65%, #2563eb 100%)' },
      defaultOn: false,
      menu: 'live',
      layers: [ids.heat],
    });

    host.panel.addCorner({
      id: 'heat-window',
      whileOn: HEAT_KEY,
      render: (el) => renderRangeSelector(el, windowStore),
    });

    // Anyone may open this tab and test the feed; only the status an admin needs is shown to admins.
    host.settings.addTab({
      id: 'reports',
      label: 'Police & hazards',
      group: 'Map',
      admin: false,
      render: (el, { isAdmin }) => renderStatusSettings(el, {
        isAdmin,
        fetchStatus: (check: boolean) => host.data.json<WazeStatusResponse>(statusPath(check)),
        // POST /setup: the server checks the caller is an admin and answers 403 otherwise.
        startSetup: () => host.data.json<WazeSetupView>('/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
        activity: (message, level) => host.activity(message, level),
        windowStore,
      }),
    });

    // Core's Drive reports, as a Drive source. The banner shows the nearest report on the road ahead (`filter`),
    // the status line says what the feed is doing, the on/off button is `defaultOn` (core's "Reports on"), and
    // the pins run from the moment the Drive map is up, while planning too (`runs`), as core's pins do.
    host.drive.addAlertSource({
      id: 'reports',
      label: 'Reports',
      title: 'Warn about police and hazard reports ahead',
      defaultOn: true,
      filter: 'route-ahead',
      runs: 'always',
      start(ctx: DriveSourceContext) {
        const failures = failureWatch(host, 'Police and hazard reports are unavailable right now');
        // The Drive map is its own map, so the pins are drawn on it under this source's scoped ids, and their
        // icons go in through the host (which removes them when the source stops).
        const pins: PinLayerIds = {
          reportsSource: ctx.scopedId('reports-src'),
          reports: ctx.scopedId('reports'),
          labels: ctx.scopedId('labels'),
          icons: ctx.scopedId(ICON_PREFIX),
        };
        addDriveReportIcons(ctx);
        addReportLayers(ctx.map, pins, DRIVE_ICON_SIZE);

        // The Drive screen gives a tap on these pins to us: the popup opens and no destination is picked (core's
        // behaviour). The host holds one popup per source and closes it on the next map click or when the source stops.
        const claim = ctx.mapLayers([pins.reports, pins.labels], {
          onTap: (tap) => {
            const popup = reportPopup(tap.features[0]?.properties, formatTime);
            ctx.showPopup(tap.lngLat, reportPopupElement(popup.title, popup.lines));
          },
        });

        // The warning is the nearest report ahead, asked for every two seconds as core's Drive screen does. A
        // refusal by the host is logged once when its reason changes; "duplicate" is the normal answer after the
        // first time, so it is not logged.
        let latest: DriveAlert[] = [];
        let refused: SpeakRefusal | null = null;
        const say = (): void => {
          const said = announceNearest(ctx, latest);
          if (!said) return;
          if (said.spoken) {
            refused = null;
            return;
          }
          if (said.reason === 'duplicate' || said.reason === refused) return;
          refused = said.reason;
          host.log.info(`Drive warning not spoken: ${said.reason}`);
        };
        const speech = setInterval(say, DRIVE_TICK_MS);

        const poll = host.data.poll<WazeAlertsResponse>({
          map: ctx.map,
          intervalMs: PINS_POLL_MS,
          refreshOnMove: true,
          fetch: ({ signal, bounds }) => host.data.json<WazeAlertsResponse>(alertsPath(boxOf(bounds), 'navigation'), { signal }),
          onData: (res) => {
            failures.recover();
            ctx.setStatus(driveStatusFor(res.state));
            // While a new area is still being scanned ('queued'/'scanning', no reports yet), keep the pins and
            // the last warnings instead of clearing them; update both only on a real answer ('fresh'/'stale').
            if (res.state === 'queued' || res.state === 'scanning') return;
            latest = driveAlerts(res.alerts, Date.now());
            ctx.report(latest);
            setSourceData(ctx.map, pins.reportsSource, reportGeoJSON(res.alerts));
            say();
          },
          retryAfterMs: (res) => (res.state === 'fresh' ? null : res.retryAfterMs),
          onError: () => {
            failures.fail();
            latest = [];
            ctx.report([]);
            setSourceData(ctx.map, pins.reportsSource, EMPTY_COLLECTION);
            ctx.setStatus({ state: 'error', text: DRIVE_ERROR_TEXT });
          },
          onStop: () => {
            latest = [];
            ctx.report([]);
            setSourceData(ctx.map, pins.reportsSource, EMPTY_COLLECTION);
            ctx.setStatus(null);
          },
        });

        return () => {
          clearInterval(speech);
          poll.stop();
          claim();
        };
      },
    });

    host.map.onReady((map) => {
      // The heatmap goes first so that the report pins draw above it.
      addHeatLayer(map, ids);
      addReportIcons(map, ids.icons);
      addReportLayers(map, ids);

      const heatFailures = failureWatch(host, 'Heatmap unavailable; check Police & hazards in Settings');
      const heat = host.data.poll<WazeHeatmapResponse>({
        map,
        while: heatEntry,
        intervalMs: HEAT_POLL_MS,
        refreshOnMove: true,
        fetch: ({ signal, bounds }) => host.data.json<WazeHeatmapResponse>(heatmapPath(boxOf(bounds), windowStore.get()), { signal }),
        onData: (res) => {
          heatFailures.recover();
          setSourceData(map, ids.heatSource, heatmapGeoJSON(res.points));
        },
        onError: () => {
          heatFailures.fail();
          setSourceData(map, ids.heatSource, EMPTY_COLLECTION);
        },
        onStop: () => setSourceData(map, ids.heatSource, EMPTY_COLLECTION),
      });
      // Changing the window asks again at once (the poll still keeps its 5 s minimum gap).
      const releaseWindow = windowStore.subscribe(() => heat.refresh());

      const pinFailures = failureWatch(host, 'Reports unavailable; check Police & hazards in Settings');
      let lastLogged: string | null = null;
      const pins = host.data.poll<WazeAlertsResponse>({
        map,
        while: wazeEntry,
        intervalMs: PINS_POLL_MS,
        refreshOnMove: true,
        fetch: ({ signal, bounds }) => host.data.json<WazeAlertsResponse>(alertsPath(boxOf(bounds)), { signal }),
        onData: (res) => {
          pinFailures.recover();
          // 'queued'/'scanning' answers carry no reports yet (a new area is still being scanned); keep the pins
          // already on the map instead of blinking them away while panning. 'fresh'/'stale' carry the real set.
          if (res.state !== 'queued' && res.state !== 'scanning') setSourceData(map, ids.reportsSource, reportGeoJSON(res.alerts));
          // Log a state change once; no reports is never written up as an all-clear.
          const key = `${res.state}:${res.alerts.length}`;
          if (key !== lastLogged) {
            lastLogged = key;
            const line = reportsActivity(res.state, res.alerts.length);
            host.activity(line.message, line.level);
          }
        },
        retryAfterMs: (res) => (res.state === 'fresh' ? null : res.retryAfterMs),
        onError: () => {
          pinFailures.fail();
          // After a failure the next good answer is announced again, as the core app does.
          lastLogged = null;
          setSourceData(map, ids.reportsSource, EMPTY_COLLECTION);
        },
        onStop: () => {
          lastLogged = null;
          setSourceData(map, ids.reportsSource, EMPTY_COLLECTION);
        },
      });

      return () => {
        releaseWindow();
        heat.stop();
        pins.stop();
      };
    });

    // A click on a report opens its popup. The circle is the hit target, as in the core app.
    host.map.onClick([ids.reports], (e: PluginMapClick) => {
      const popup = reportPopup(e.features[0]?.properties, formatTime);
      host.map.showPopup(e.lngLat, reportPopupElement(popup.title, popup.lines));
    });
  },
};

export default plugin;
