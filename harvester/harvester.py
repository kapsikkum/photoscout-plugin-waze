"""Authenticated police/hazard report API for one controlled Android emulator."""
import hmac
import logging
import os
import threading
from typing import Optional
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from report_queue import ReportQueue

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger('waze-reports')
PORT = int(os.environ.get('PORT', '8088'))
SERVICE_API_KEY = os.environ.get('SERVICE_API_KEY', '').strip()
BRIDGE_VERSION = 'reports-queue-v2'
app = FastAPI(title='PhotoScout Waze report bridge', version='1.0.0')
state_lock = threading.Lock()
state = {'emulator_running': False, 'device_connected': False, 'boot_completed': False,
         'frida_ready': False, 'waze_ready': False, 'last_error': None, 'setup_stage': 'starting',
         'acceleration': None, 'first_run': None}
report_collector = None
report_queue = None


def attach_report_collector(collector):
    global report_collector, report_queue
    if report_queue:
        report_queue.close()
    report_collector = collector
    report_queue = ReportQueue(collector.scan)
    report_queue.start()


@app.middleware('http')
async def service_auth(request: Request, call_next):
    if request.url.path != '/health':
        supplied = request.headers.get('x-api-key', '')
        if not SERVICE_API_KEY or not hmac.compare_digest(supplied.encode(), SERVICE_API_KEY.encode()):
            return JSONResponse(status_code=401, content={'detail': 'Service API key required'})
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.get('/health')
def get_health():
    snapshot = report_collector.store.snapshot() if report_collector else None
    with state_lock:
        progress = dict(state)
    return {**progress, 'status': 'ok' if snapshot and snapshot['connected'] else 'starting' if not progress['last_error'] else 'degraded',
            'bridge_version': BRIDGE_VERSION, 'report_mode': True,
            'reports': {k: snapshot[k] for k in ('connected', 'observedAt', 'policeCount')} if snapshot else None,
            'alert_count': len(snapshot['alerts']) if snapshot else 0,
            'queue': report_queue.status() if report_queue else None}


@app.get('/alerts')
def get_alerts(minLng: Optional[float] = None, minLat: Optional[float] = None,
               maxLng: Optional[float] = None, maxLat: Optional[float] = None, priority: str = 'map'):
    if report_collector is None:
        raise HTTPException(status_code=503, detail='Waze report collector is starting')
    if priority not in ('map', 'navigation'):
        raise HTTPException(status_code=400, detail='Invalid report priority')
    if any(v is not None for v in (minLng, minLat, maxLng, maxLat)):
        if (None in (minLng, minLat, maxLng, maxLat) or
                not -180 <= minLng < maxLng <= 180 or not -90 <= minLat < maxLat <= 90):
            raise HTTPException(status_code=400, detail='Valid geographic bounds required')
        if report_queue is None:
            raise HTTPException(status_code=503, detail='Waze request queue is starting')
        result = report_queue.request((minLng, minLat, maxLng, maxLat), navigation=priority == 'navigation')
        if result['state'] in ('busy', 'unavailable'):
            return JSONResponse(status_code=429 if result['state'] == 'busy' else 503,
                                content=result, headers={'Retry-After': str(max(1, result['retryAfterMs'] // 1000))})
        if result['state'] in ('queued', 'scanning'):
            return JSONResponse(status_code=202, content=result)
        return result
    # A status check reads existing reports and never moves the shared emulator.
    snapshot = report_collector.store.snapshot()
    if not snapshot['connected']:
        raise HTTPException(status_code=503, detail='Waze report connection unavailable')
    return {**snapshot, 'centre': report_collector.centre, 'bridgeVersion': BRIDGE_VERSION}


if __name__ == '__main__':
    from rt_stream import ReportCollector
    collector = ReportCollector()
    collector.start()
    attach_report_collector(collector)
    try:
        uvicorn.run(app, host=os.environ.get('BIND_HOST', '127.0.0.1'), port=PORT)
    finally:
        report_queue.close()
        collector.close()
