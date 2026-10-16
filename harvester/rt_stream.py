"""Persistent read-only Waze RT report collector for a controlled Android emulator."""
import gzip
import logging
import os
import shutil
import subprocess
import threading
import time
import frida
from rt_reports import parse_rt_reports, _message
from protobuf import _fields

logger = logging.getLogger('waze-reports')
HOOK = '''
let installed = false;
const timer = setInterval(() => {
  if (installed) return;
  const mod = Process.findModuleByName('libssl.so');
  if (!mod) return;
  installed = true; clearInterval(timer);
  const serverName = new NativeFunction(mod.getExportByName('SSL_get_servername'), 'pointer', ['pointer', 'int']);
  Interceptor.attach(mod.getExportByName('SSL_read'), {
    onEnter(args) { this.ssl = args[0]; this.buf = args[1]; },
    onLeave(retval) {
      const size = retval.toInt32();
      if (size <= 0 || size > 4 * 1024 * 1024) return;
      const host = serverName(this.ssl, 0);
      if (host.isNull() || !host.readUtf8String().includes('rt-xlb')) return;
      send({ connection: this.ssl.toString() }, this.buf.readByteArray(size));
    }
  });
  send({ ready: true });
}, 10);
'''


class ReportStore:
    def __init__(self):
        self.lock = threading.RLock()
        self.reports = {}
        self.seen_at = {}
        self.buffers = {}
        self.streams = {}
        self.last_received = 0
        self.last_report_update = 0
        self.ready = False
        self.authenticated = False
        self.error = None

    def receive(self, connection, data):
        with self.lock:
            buf = self.buffers.get(connection, b'') + data
            while len(buf) >= 9:
                size = int.from_bytes(buf[:3], 'big')
                if size > 4 * 1024 * 1024:
                    raise ValueError('HTTP2 frame exceeds limit')
                if len(buf) < size + 9:
                    break
                kind, flags = buf[3:5]
                stream = int.from_bytes(buf[5:9], 'big') & 0x7fffffff
                body, buf = buf[9:9+size], buf[9+size:]
                key = (connection, stream)
                if kind == 0:
                    if flags & 8:
                        padding = body[0]
                        body = body[1:len(body)-padding]
                    previous = self.streams.get(key, b'')
                    if len(previous) + len(body) > 4 * 1024 * 1024:
                        raise ValueError('HTTP2 response exceeds limit')
                    self.streams[key] = previous + body
                if kind == 3:
                    self.streams.pop(key, None)
                if flags & 1 and kind in (0, 1):
                    response = self.streams.pop(key, b'')
                    if response.startswith(b'\x1f\x8b'):
                        response = gzip.decompress(response)
                    if not response:
                        continue
                    alerts, removed = parse_rt_reports(response)
                    for field, wire, element in _fields(response):
                        if field != 1001 or wire != 2:
                            continue
                        for command, command_wire, payload in _fields(element):
                            if command == 2745 and command_wire == 2:
                                login = _message(payload)
                                self.authenticated = bool(login.get(1)) and not bool(login.get(2))
                    if alerts:
                        self.authenticated = True
                    now = time.time()
                    if alerts or removed:
                        self.last_report_update = now
                    for alert in alerts:
                        self.reports[alert['id']] = alert
                        self.seen_at[alert['id']] = now
                    for uuid in removed:
                        self.reports.pop(uuid, None)
                        self.seen_at.pop(uuid, None)
                    self.last_received = now
                    self.error = None
            self.buffers[connection] = buf

    def snapshot(self):
        with self.lock:
            now = time.time()
            # Never retain old user reports indefinitely if the server stops sending removals.
            expired = [key for key, alert in self.reports.items()
                       if now - self.seen_at.get(key, 0) >= 2 * 3600 or
                       (alert['reportTime'] is not None and now * 1000 - alert['reportTime'] >= 2 * 3600 * 1000)]
            for key in expired:
                self.reports.pop(key, None)
                self.seen_at.pop(key, None)
            reports = list(self.reports.values())
            return {'alerts': reports, 'coverage': 'viewport', 'observedAt': int(self.last_received * 1000),
                    'mock': False, 'connected': self.ready and self.authenticated and now - self.last_received < 90,
                    'policeCount': sum(a['type'] == 'POLICE' for a in reports)}


class ReportCollector:
    def __init__(self, *, software_guest=False):
        self.store = ReportStore()
        self.device = None
        self.session = None
        self.script = None
        self.centre = None
        self.move_lock = threading.Lock()
        self.moved_at = 0
        self.software_guest = software_guest
        self.adb = os.environ.get('ADB_PATH') or shutil.which('adb')
        self.serial = os.environ.get('ADB_SERIAL', os.environ.get('FRIDA_DEVICE_ID', ''))
        if not self.serial:
            self.serial = f'{os.environ.get("ADB_HOST", "android-emulator")}:{os.environ.get("ADB_PORT", "5555")}'

    def adb_run(self, *args):
        if not self.adb:
            raise RuntimeError('ADB_PATH is not configured and adb is not on PATH')
        result = subprocess.run([self.adb, '-s', self.serial, *args], capture_output=True, text=True, timeout=120 if self.software_guest else 15)
        if result.returncode:
            raise RuntimeError('ADB command failed')
        return result

    def start(self):
        # Refuse physical phones before touching their app session or location.
        qemu = self.adb_run('shell', 'getprop', 'ro.kernel.qemu').stdout.strip()
        if qemu != '1':
            qemu = self.adb_run('shell', 'getprop', 'ro.boot.qemu').stdout.strip()
        if qemu != '1':
            raise RuntimeError('The report bridge requires an Android emulator')
        device_id = os.environ.get('FRIDA_DEVICE_ID', '')
        self.device = (frida.get_device(device_id, timeout=10) if device_id else
                       frida.get_device_manager().add_remote_device(f'{os.environ.get("FRIDA_HOST", os.environ.get("ADB_HOST", "android-emulator"))}:{os.environ.get("FRIDA_PORT", "27042")}'))
        # A fresh app session ensures a full initial report snapshot instead of deltas.
        self.adb_run('shell', 'am', 'force-stop', 'com.waze')
        if self.software_guest:
            # Frida's gated spawn expires while a no-KVM guest is still loading
            # Android classes. Launch normally and attach to this fresh process.
            activity = self.adb_run('shell', 'cmd', 'package', 'resolve-activity', '--brief',
                                    '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', 'com.waze').stdout
            component = next((line.strip() for line in activity.splitlines() if line.strip().startswith('com.waze/')), None)
            if not component:
                raise RuntimeError('The installed Waze app has no launcher activity')
            self.adb_run('shell', 'am', 'start', '-n', component)
            deadline = time.monotonic() + 300
            while True:
                try:
                    processes = self.adb_run('shell', 'pidof', 'com.waze').stdout.split()
                    if processes and processes[0].isdecimal():
                        pid = int(processes[0])
                        break
                except RuntimeError:
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError('Waze did not start in the software guest')
                time.sleep(5)
        else:
            pid = self.device.spawn(['com.waze'])
        self.session = self.device.attach(pid)
        self.script = self.session.create_script(HOOK)
        self.script.on('message', self.message)
        self.session.on('detached', self.detached)
        self.script.load()
        if not self.software_guest:
            self.device.resume(pid)

    def detached(self, *args):
        with self.store.lock:
            self.store.ready = False
            self.store.error = 'Waze report reader disconnected'

    def message(self, message, data):
        try:
            if message['type'] == 'error':
                raise RuntimeError('Report reader hook failed')
            payload = message.get('payload', {})
            if payload.get('ready'):
                self.store.ready = True
            elif data:
                self.store.receive(payload['connection'], data)
        except Exception:
            self.store.error = 'Report response could not be decoded'
            logger.exception('Report reader failed')

    def move(self, lng, lat):
        with self.move_lock:
            if self.centre and abs(self.centre[0]-lng) < .02 and abs(self.centre[1]-lat) < .02:
                return False
            # This bridge deliberately controls an emulator, never a physical phone's GPS.
            self.adb_run('emu', 'geo', 'fix', str(lng), str(lat))
            self.adb_run('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', f'"waze://?ll={lat},{lng}&z=12"')
            self.centre = (lng, lat)
            self.moved_at = time.time()
            return True

    def close(self):
        if self.session:
            try:
                self.session.detach()
            except Exception:
                logger.debug('Report reader session was already unavailable during cleanup')
            finally:
                self.session = None

    def scan(self, lng, lat):
        moved = self.move(lng, lat)
        # Give the app's GPS/map requests time to finish before another user can
        # move this same emulator. Cached responses return immediately via the queue.
        start = time.time()
        deadline = time.monotonic() + (10 if moved else 2)
        while time.monotonic() < deadline:
            if self.store.last_received > start and (not moved or self.store.last_report_update > start):
                break
            time.sleep(.1)
        snapshot = self.store.snapshot()
        snapshot['centre'] = [lng, lat]
        return snapshot
