import type { PluginContext, ServerPlugin } from './sdk/server-api.js';
import {
  createScanCache, declaredHarvesterHosts, fetchWazeAlerts, fetchWazeAlertsCached, fetchWazeWorkerHealth,
  resolveHarvester, SETUP_MESSAGE, validateWazeBounds, WORLD, WorkerProbe,
  type Harvester, type WazeBoundingBox, type WazeFetchResult, type WazePriority,
} from './feed.js';
import { coreWazeDir, presentWazeSetup, readMigratedRuntime, readSetupFile } from './setup.js';
import { openSightings, prunePoliceSightings, queryPoliceHeatmap, recordPoliceSightings, SIGHTING_RETENTION_MS } from './sightings.js';

/** Prune old sightings at most this often, as the core app does on its alerts route. */
const PRUNE_EVERY_MS = 60000;
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

const plugin: ServerPlugin = {
  activate(ctx: PluginContext) {
    const declared = declaredHarvesterHosts(ctx.manifest.permissions);
    const wazeDir = coreWazeDir(ctx.dataDir);
    const cache = createScanCache();

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

    // A changed address or key must not be answered from scans of the old harvester.
    ctx.settings.onChange(() => { cache.clear(); probe.reset(); });

    openSightings(ctx.db);
    let lastPrune = 0;

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
        if (!result.fromCache && (result.state === 'fresh' || result.state === 'stale')) {
          const now = Date.now();
          recordPoliceSightings(ctx.db, result.alerts.filter(alert => alert.type === 'POLICE'), now);
          if (now - lastPrune >= PRUNE_EVERY_MS) {
            lastPrune = now;
            prunePoliceSightings(ctx.db, now, SIGHTING_RETENTION_MS);
          }
        }
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
};

export default plugin;
