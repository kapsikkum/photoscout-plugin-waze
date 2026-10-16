import path from 'node:path';
import type { PluginContext, ServerPlugin } from './sdk/server-api.js';
import {
  createScanCache, declaredHarvesterHosts, fetchWazeAlerts, fetchWazeAlertsCached, fetchWazeWorkerHealth,
  resolveHarvester, SETUP_MESSAGE, validateWazeBounds, WORLD, WorkerProbe,
  type Harvester, type WazeBoundingBox, type WazeFetchResult, type WazePriority,
} from './feed.js';
import { coreWazeDir, presentWazeSetup, readMigratedRuntime, readSetupFile } from './setup.js';
import { SetupStarter, setupHelperPath } from './setupStart.js';
import { openSightings, queryPoliceHeatmap, SightingKeeper, SIGHTING_RETENTION_MS } from './sightings.js';
import { AreaMonitor, monitorSettingsOf, MONITOR_TASK_ID } from './monitor.js';

const HEATMAP_DEFAULT_MS = 2 * 60 * 60 * 1000;
const HEATMAP_MIN_MS = 60 * 60 * 1000;
const COORDS = ['minLng', 'minLat', 'maxLng', 'maxLat'] as const;

/**
 * Who is asking. The host sets `req.user` on every /api request (server/src/app.ts), but the plugin
 * contract has no helper for it yet, so this reads that field. Missing means a visitor, so the
 * fallback is the less privileged answer.
 */
function viewer(req: object): { signedIn: boolean; admin: boolean } {
  const user = (req as { user?: { role?: unknown } | null }).user;
  return { signedIn: Boolean(user), admin: user?.role === 'admin' };
}

/** The four query coordinates as a valid box, or why not. */
function parseBox(query: Record<string, unknown>): WazeBoundingBox | 'missing' | 'invalid' {
  if (!COORDS.every(k => typeof query[k] === 'string' && (query[k] as string).trim())) return 'missing';
  const bbox = { minLng: Number(query.minLng), minLat: Number(query.minLat), maxLng: Number(query.maxLng), maxLat: Number(query.maxLat) };
  try { validateWazeBounds(bbox); } catch { return 'invalid'; }
  return bbox;
}

/** Stops the area monitor of the activation the host is stopping. The host loads a fresh copy of this module per activation. */
let stopMonitor: (() => void) | null = null;

const plugin: ServerPlugin = {
  activate(ctx: PluginContext) {
    const declared = declaredHarvesterHosts(ctx.manifest.permissions);
    const wazeDir = coreWazeDir(ctx.dataDir);
    const cache = createScanCache();
    // The core app's data root is three levels above the plugin's data folder (see coreWazeDir).
    const setup = new SetupStarter({ wazeDir, dataRoot: path.resolve(ctx.dataDir, '..', '..', '..'), helper: () => setupHelperPath() });

    /**
     * The harvester the settings name, or why there is none. The core app's runtime file is used only
     * when no address is set in the settings at all, so the two sources are never mixed.
     */
    const harvesterNow = (): { harvester: Harvester | null; problem: string | null } => {
      const settings = ctx.settings.get();
      const address = typeof settings.harvesterUrl === 'string' ? settings.harvesterUrl : '';
      if (address.trim()) {
        const key = typeof settings.harvesterKey === 'string' ? settings.harvesterKey : '';
        return resolveHarvester(address, key, declared);
      }
      const migrated = readMigratedRuntime(wazeDir);
      return resolveHarvester(migrated.url, migrated.key, declared);
    };

    const probe = new WorkerProbe(() => {
      const { harvester } = harvesterNow();
      return harvester ? fetchWazeWorkerHealth(harvester, ctx.fetch) : Promise.resolve(null);
    });

    openSightings(ctx.db);
    const keeper = new SightingKeeper(ctx.db);
    const monitor = new AreaMonitor({ keeper, cache, fetchFn: ctx.fetch, harvester: harvesterNow });
    stopMonitor = () => monitor.stop();

    /**
     * The scheduled poll. The host reads a task's interval once, when the task is registered, so the task is
     * registered when the first area is set and keeps that interval until the plugin next starts. The areas are
     * read again on every run, so changing them takes effect at the next run.
     */
    let scheduledMinutes: number | null = null;
    const scheduleMonitor = (settings: Record<string, unknown>): void => {
      const { areas, problems, intervalMinutes } = monitorSettingsOf(settings);
      for (const problem of problems) ctx.log.warn(`Monitored areas: ${problem}. It is ignored.`);
      if (scheduledMinutes !== null) {
        if (intervalMinutes !== scheduledMinutes) {
          ctx.log.info(`Area monitoring keeps its ${scheduledMinutes}-minute schedule until the plugin restarts; ${intervalMinutes} minutes applies then`);
        }
        return;
      }
      if (areas.length === 0) return;
      try {
        ctx.tasks.register({
          id: MONITOR_TASK_ID,
          name: 'Police reports for monitored areas',
          description: 'Polls the areas set in Settings and records police sightings for the heatmap.',
          intervalMinutes,
          run: async (log) => {
            const current = monitorSettingsOf(ctx.settings.get());
            for (const problem of current.problems) log(`Ignored: ${problem}`);
            return monitor.poll(current.areas, log);
          },
        });
        scheduledMinutes = intervalMinutes;
        ctx.log.info(`Polling ${areas.length} monitored area${areas.length === 1 ? '' : 's'} every ${intervalMinutes} minutes`);
      } catch (err) {
        ctx.log.error(`Area monitoring could not be scheduled: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    scheduleMonitor(ctx.settings.get());

    // A changed address or key must not be answered from scans of the old harvester.
    ctx.settings.onChange((settings) => { cache.clear(); probe.reset(); scheduleMonitor(settings); });

    // GET /api/plugins/map.24thframe.waze/status[?check=1]
    ctx.router.get('/status', async (req, res) => {
      const { harvester, problem } = harvesterNow();
      probe.refresh(harvester !== null);
      const checked = req.query.check === '1';
      let liveCode: number | null = null;
      let liveMsg = 'Alert feed not checked';
      let alertCount: number | null = null;
      let coverage: 'route' | 'viewport' | null = null;
      let observedAt: number | null = null;

      if (checked) {
        try {
          if (!harvester) throw new Error(problem ?? SETUP_MESSAGE);
          // A status check reads what the harvester already has and never moves its emulator.
          const result = await fetchWazeAlerts(harvester, WORLD, ctx.fetch, false);
          liveCode = 200;
          alertCount = result.alerts.length;
          coverage = result.coverage;
          observedAt = result.observedAt;
          liveMsg = `${alertCount} reports returned (${coverage === 'route' ? 'active Waze route only' : 'areas loaded by Waze'})`;
        } catch (e) {
          liveMsg = e instanceof Error ? e.message : 'Alert feed check failed';
          const match = /HTTP (\d{3})/.exec(liveMsg);
          liveCode = match ? Number(match[1]) : null;
        }
      }

      res.json({
        configured: harvester !== null,
        liveMapStatus: { endpoint: 'Android police/hazard report bridge', accessible: liveCode === 200, status: liveCode, message: liveMsg },
        checked,
        alertCount, coverage, observedAt,
        canDisplayOnMap: liveCode === 200,
        attribution: 'Waze / Google',
        setup: presentWazeSetup(readSetupFile(wazeDir), probe.current(), { admin: viewer(req).admin }),
      });
    });

    // POST /api/plugins/map.24thframe.waze/setup: core's POST /api/waze/setup. Admins only (the host's requireAdmin
    // answers 403 "Admins only" to anyone else). Starts the setup helper once at a time and answers 202 with the
    // setup state, which carries no operator instructions (core's startWazeSetup answers the same way).
    ctx.router.post('/setup', (req, res) => {
      if (!ctx.auth.requireAdmin(req, res)) return;
      try {
        probe.refresh(harvesterNow().harvester !== null);
        setup.start();
        res.status(202).json(presentWazeSetup(readSetupFile(wazeDir), probe.current()));
      } catch (err) {
        res.status(503).json({ error: err instanceof Error ? err.message : 'Setup could not start' });
      }
    });

    // GET /api/plugins/map.24thframe.waze/alerts?minLng=&minLat=&maxLng=&maxLat=[&priority=navigation]
    ctx.router.get('/alerts', async (req, res, next) => {
      try {
        const bbox = parseBox(req.query);
        if (bbox === 'missing') { res.status(400).json({ error: 'minLng, minLat, maxLng and maxLat must be non-empty coordinates' }); return; }
        if (bbox === 'invalid') { res.status(400).json({ error: 'A valid minLng, minLat, maxLng, maxLat bounding box is required' }); return; }

        const { harvester, problem } = harvesterNow();
        // Navigation is a signed-in privilege: a visitor's request is served as a map poll.
        const priority: WazePriority = req.query.priority === 'navigation' && viewer(req).signedIn ? 'navigation' : 'map';
        let result: WazeFetchResult & { fromCache: boolean };
        try {
          if (!harvester) throw new Error(problem ?? SETUP_MESSAGE);
          result = await fetchWazeAlertsCached(harvester, bbox, { cache, fetchFn: ctx.fetch, priority });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Waze report bridge failed';
          res.status(503).json({ configured: false, error: message, alerts: [] });
          return;
        }

        // Only fresh harvester data is recorded: a cache hit would count the same reports again.
        keeper.keep(result, result.fromCache, Date.now());
        res.json({ configured: true, ...result });
      } catch (err) {
        next(err);
      }
    });

    // GET /api/plugins/map.24thframe.waze/heatmap?minLng=&minLat=&maxLng=&maxLat=[&windowMs=]
    // Answers from this plugin's own database alone, so it works while the live feed is queued.
    ctx.router.get('/heatmap', (req, res, next) => {
      try {
        const bbox = parseBox(req.query);
        if (bbox === 'missing') { res.status(400).json({ error: 'minLng, minLat, maxLng and maxLat must be non-empty coordinates' }); return; }
        if (bbox === 'invalid') { res.status(400).json({ error: 'A valid minLng, minLat, maxLng, maxLat bounding box is required' }); return; }
        const asked = typeof req.query.windowMs === 'string' && req.query.windowMs.trim() ? Number(req.query.windowMs) : NaN;
        const windowMs = Number.isFinite(asked) ? Math.min(SIGHTING_RETENTION_MS, Math.max(HEATMAP_MIN_MS, asked)) : HEATMAP_DEFAULT_MS;
        const now = Date.now();
        res.json({
          configured: harvesterNow().harvester !== null,
          windowMs,
          observedAt: now,
          points: queryPoliceHeatmap(ctx.db, bbox, windowMs, now),
        });
      } catch (err) {
        next(err);
      }
    });

    ctx.log.info('Waze police and hazard reports are ready');
  },

  /** The host unregisters the monitor task itself; this stops a poll that is still running from recording more. */
  deactivate() {
    stopMonitor?.();
    stopMonitor = null;
  },
};

export default plugin;
