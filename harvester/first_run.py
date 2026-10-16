"""Detect Waze's one-time first-run (welcome) screen. Read-only: this module never sends input to Waze."""
import logging
import subprocess
import threading
import time
import xml.etree.ElementTree as ET

logger = logging.getLogger('waze-reports')

# Present only on Waze's welcome screen, not on the map or in onboarding that has been completed.
WELCOME_IDS = frozenset({'com.waze:id/authWelcomePrimaryButton', 'com.waze:id/authWelcomeTermsOfServiceFooter'})
DUMP_PATH = '/sdcard/ui.xml'
DUMP_INTERVAL = 60
DUMP_TIMEOUT = 300


def first_run_instructions(screen_access):
    """Operator instructions. Shown by setup, /health and the Settings tab, so keep them accurate."""
    connect = ('On the machine running the worker, run: adb connect 127.0.0.1:5556 && scrcpy -s 127.0.0.1:5556. '
               "Complete Waze's welcome screens, then close scrcpy. The result is kept on the Android volume, "
               'so this is needed once. On a remote server, forward the port first: ssh -L 5556:127.0.0.1:5556 <server>.')
    if screen_access:
        return "Waze needs its first-run screen completed once. " + connect
    return ('Waze needs its first-run screen completed once, which needs screen access. Run setup again with '
            '--screen-access (npm run waze:setup -- --screen-access), or set WAZE_SCREEN_ACCESS=1 for a container '
            'deployment and restart the worker. Then: ' + connect)


def parse_welcome_screen(dump):
    """True when a uiautomator dump shows Waze's welcome screen. Raises ValueError for an unreadable dump."""
    data = dump.encode('utf-8') if isinstance(dump, str) else dump
    start = data.find(b'<hierarchy')
    if start < 0:
        raise ValueError('UI dump has no hierarchy')
    try:
        root = ET.fromstring(data[start:])
    except ET.ParseError as exc:
        raise ValueError('UI dump is not valid XML') from exc
    return any(node.get('resource-id') in WELCOME_IDS for node in root.iter('node'))


class FirstRunWatcher:
    """Every `interval` seconds, while no reports have arrived, read the screen and report a welcome screen.

    `adb(*args, timeout=...)` returns stdout or raises subprocess.SubprocessError.
    `has_reports()` is true once the realtime channel is delivering responses.
    `update(**fields)` writes the worker's health state.
    """

    def __init__(self, *, adb, has_reports, update, screen_access=False, interval=DUMP_INTERVAL):
        self.adb = adb
        self.has_reports = has_reports
        self.update = update
        self.screen_access = screen_access
        self.interval = interval
        self.detected_at = None
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        self._thread = threading.Thread(target=self._run, name='waze-first-run-watch', daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        while not self._stop.wait(self.interval):
            if not self.tick():
                return

    def tick(self):
        """One check. Returns False once reports flow, which ends watching and stops all dumps."""
        if self.has_reports():
            self.detected_at = None
            self.update(setup_stage='ready', first_run=None)
            return False
        try:
            welcome = self._screen_is_welcome()
        except (subprocess.SubprocessError, ValueError) as exc:
            # The guest can be slow; a timeout or a half-written dump simply waits for the next cycle.
            logger.debug('Waze screen check skipped: %s', exc)
            return True
        self._apply(welcome)
        return True

    def _screen_is_welcome(self):
        # uiautomator snapshots the view tree; it does not tap, type or swipe.
        self.adb('shell', 'rm', '-f', DUMP_PATH, timeout=60)
        self.adb('shell', 'uiautomator', 'dump', DUMP_PATH, timeout=DUMP_TIMEOUT)
        return parse_welcome_screen(self.adb('shell', 'cat', DUMP_PATH, timeout=120))

    def _apply(self, welcome):
        if welcome and self.detected_at is None:
            self.detected_at = int(time.time() * 1000)
            logger.warning('Waze is showing its first-run screen; the operator must complete it once')
            self.update(setup_stage='needs_first_run', last_error=None,
                        first_run={'detected_at': self.detected_at, 'how': first_run_instructions(self.screen_access)})
        elif not welcome and self.detected_at is not None:
            self.detected_at = None
            logger.info('Waze has left its first-run screen')
            self.update(setup_stage='connecting_waze', first_run=None)
