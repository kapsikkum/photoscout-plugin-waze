"""Coalesce map requests by area; one scanner owns each emulator at a time."""
import math
import threading
import time

CELL = .025


class ReportQueue:
    def __init__(self, scanner, fresh_seconds=60, stale_seconds=300, max_pending=48, clock=time.time):
        self.scanner = scanner
        self.fresh_seconds = fresh_seconds
        self.stale_seconds = stale_seconds
        self.max_pending = max_pending
        self.clock = clock
        self.condition = threading.Condition()
        self.scan_lock = threading.Lock()
        self.thread = None
        self.pending = {}
        self.cache = {}
        self.retry_at = {}
        self.active = None
        self.serial = 0
        self.nav_streak = 0
        self.stopped = False
        self.last_error = None

    @staticmethod
    def area(lng, lat):
        return math.floor(lng / CELL), math.floor(lat / CELL)

    @staticmethod
    def centre(key):
        return (key[0] + .5) * CELL, (key[1] + .5) * CELL

    def request(self, bbox, navigation=False):
        key = self.area((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)
        now = self.clock()
        with self.condition:
            cached = self.cache.get(key)
            age = now - cached['saved_at'] if cached else float('inf')
            retrying = now < self.retry_at.get(key, 0)
            if age >= self.fresh_seconds and key != self.active and not retrying:
                if key in self.pending:
                    self.pending[key]['navigation'] |= navigation
                    self.pending[key]['requested_at'] = now
                elif len(self.pending) >= self.max_pending:
                    if not cached or age >= self.stale_seconds:
                        return {'alerts': [], 'state': 'busy', 'coverage': 'viewport', 'observedAt': None, 'retryAfterMs': 10000}
                else:
                    self.serial += 1
                    self.pending[key] = {'order': self.serial, 'navigation': navigation, 'requested_at': now}
                    self.condition.notify()
            position = sum(job['order'] < self.pending.get(key, {}).get('order', 0) for job in self.pending.values())
            if cached and age < self.stale_seconds:
                alerts = [a for a in cached['data']['alerts'] if bbox[0] <= a['point'][0] <= bbox[2] and bbox[1] <= a['point'][1] <= bbox[3]]
                return {**cached['data'], 'alerts': alerts, 'state': 'fresh' if age < self.fresh_seconds else 'stale', 'queuePosition': position, 'retryAfterMs': 5000 if age >= self.fresh_seconds else 30000}
            if retrying:
                return {'alerts': [], 'state': 'unavailable', 'coverage': 'viewport', 'observedAt': None, 'retryAfterMs': max(1000, int((self.retry_at[key] - now) * 1000)), 'mock': False}
            return {'alerts': [], 'state': 'scanning' if key == self.active else 'queued', 'coverage': 'viewport', 'observedAt': None, 'queuePosition': position, 'retryAfterMs': 5000, 'mock': False}

    def next_job(self):
        # Three navigation jobs, then let the oldest browsing request through.
        items = list(self.pending.items())
        browsing = [(key, job) for key, job in items if not job['navigation']]
        navigation = [(key, job) for key, job in items if job['navigation']]
        options = browsing if self.nav_streak >= 3 and browsing else navigation or browsing
        key, job = min(options, key=lambda item: item[1]['order'])
        self.nav_streak = self.nav_streak + 1 if job['navigation'] else 0
        self.pending.pop(key)
        self.active = key
        return key

    def run_one(self):
        # Guard the scanner itself, including accidental duplicate worker starts.
        if not self.scan_lock.acquire(blocking=False):
            return False
        try:
            return self._run_one()
        finally:
            self.scan_lock.release()

    def _run_one(self):
        with self.condition:
            # A client that panned away or closed the page stops polling. Do not
            # spend several minutes scanning its abandoned map views.
            for key in list(self.pending):
                if self.clock() - self.pending[key]['requested_at'] >= 90:
                    self.pending.pop(key)
            if not self.pending:
                return False
            key = self.next_job()
        try:
            data = self.scanner(*self.centre(key))
            if not data.get('connected') or not isinstance(data.get('observedAt'), int):
                raise RuntimeError('Waze area is not connected')
            with self.condition:
                self.cache[key] = {'saved_at': self.clock(), 'data': data}
                self.retry_at.pop(key, None)
                self.last_error = None
                # Keep the cache bounded even if users explore thousands of areas.
                if len(self.cache) > 128:
                    oldest = min(self.cache, key=lambda k: self.cache[k]['saved_at'])
                    self.cache.pop(oldest, None)
        except Exception:
            with self.condition:
                self.last_error = 'Waze area scan failed'
                self.retry_at[key] = self.clock() + 20
                if len(self.retry_at) > 128:
                    self.retry_at.pop(min(self.retry_at, key=self.retry_at.get))
        finally:
            with self.condition:
                self.active = None
        return True

    def worker(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda: self.stopped or self.pending)
                if self.stopped:
                    return
            self.run_one()

    def start(self):
        with self.condition:
            if self.thread is not None or self.stopped:
                return
            self.thread = threading.Thread(target=self.worker, name='waze-area-queue', daemon=True)
            self.thread.start()

    def status(self):
        with self.condition:
            return {'pendingAreas': len(self.pending), 'cachedAreas': len(self.cache), 'scanning': self.active is not None, 'lastError': self.last_error}

    def close(self):
        with self.condition:
            self.stopped = True
            self.condition.notify_all()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=45)
