import os
import subprocess
import unittest
from pathlib import Path
from first_run import FirstRunWatcher, first_run_instructions, parse_welcome_screen

FIXTURES = Path(__file__).parent / 'test_fixtures'


class WelcomeScreenParserTests(unittest.TestCase):
    def test_real_welcome_dump_is_detected(self):
        self.assertTrue(parse_welcome_screen((FIXTURES / 'waze_welcome.xml').read_bytes()))

    def test_main_map_dump_is_not_a_welcome_screen(self):
        self.assertFalse(parse_welcome_screen((FIXTURES / 'waze_main_map.xml').read_text(encoding='utf-8')))

    def test_either_welcome_identifier_is_enough(self):
        footer = '<hierarchy><node resource-id="com.waze:id/authWelcomeTermsOfServiceFooter"/></hierarchy>'
        primary = '<hierarchy><node><node resource-id="com.waze:id/authWelcomePrimaryButton"/></node></hierarchy>'
        self.assertTrue(parse_welcome_screen(footer))
        self.assertTrue(parse_welcome_screen(primary))

    def test_similar_identifiers_do_not_match(self):
        self.assertFalse(parse_welcome_screen('<hierarchy><node resource-id="com.waze:id/authWelcomeIndicators"/>'
                                              '<node text="Get started" resource-id="com.waze:id/authWelcomeButtonsContainer"/></hierarchy>'))

    def test_unreadable_dumps_are_errors_not_negatives(self):
        for dump in ('', 'UI hierchary dumped to: /sdcard/ui.xml', '<hierarchy><node', b'\x00\x01'):
            with self.assertRaises(ValueError):
                parse_welcome_screen(dump)

    def test_leading_noise_before_the_hierarchy_is_ignored(self):
        self.assertTrue(parse_welcome_screen('noise\n<hierarchy><node resource-id="com.waze:id/authWelcomePrimaryButton"/></hierarchy>\n'))


class FakeAdb:
    """Records calls; serves the next queued dump (or raises the queued error)."""

    def __init__(self, *results):
        self.results = list(results)
        self.calls = []

    def __call__(self, *args, timeout):
        self.calls.append((args, timeout))
        result = self.results.pop(0) if self.results else ''
        if isinstance(result, Exception):
            raise result
        return result


WELCOME = (FIXTURES / 'waze_welcome.xml').read_text(encoding='utf-8')
MAP = (FIXTURES / 'waze_main_map.xml').read_text(encoding='utf-8')


class FirstRunWatcherTests(unittest.TestCase):
    def setUp(self):
        self.updates = []
        self.reports = False

    def watcher(self, adb, screen_access=False):
        return FirstRunWatcher(adb=adb, has_reports=lambda: self.reports,
                               update=lambda **fields: self.updates.append(fields), screen_access=screen_access)

    def test_each_cycle_removes_dumps_and_reads_the_screen_without_input(self):
        adb = FakeAdb('', '', MAP)
        self.watcher(adb).tick()
        self.assertEqual([args for args, _ in adb.calls],
                         [('shell', 'rm', '-f', '/sdcard/ui.xml'), ('shell', 'uiautomator', 'dump', '/sdcard/ui.xml'),
                          ('shell', 'cat', '/sdcard/ui.xml')])
        self.assertEqual(adb.calls[1][1], 300)
        self.assertFalse(any('input' in args or 'tap' in args for args, _ in adb.calls))

    def test_welcome_screen_sets_first_run_state_with_instructions(self):
        self.watcher(FakeAdb('', '', WELCOME)).tick()
        self.assertEqual(self.updates[-1]['setup_stage'], 'needs_first_run')
        self.assertIsNone(self.updates[-1]['last_error'])
        first_run = self.updates[-1]['first_run']
        self.assertIsInstance(first_run['detected_at'], int)
        self.assertIn('scrcpy -s 127.0.0.1:5556', first_run['how'])

    def test_welcome_state_is_written_once_per_detection(self):
        watcher = self.watcher(FakeAdb('', '', WELCOME, '', '', WELCOME))
        watcher.tick(); watcher.tick(); watcher.tick()
        self.assertEqual(len(self.updates), 1)

    def test_leaving_the_welcome_screen_returns_to_connecting(self):
        watcher = self.watcher(FakeAdb('', '', WELCOME, '', '', MAP))
        watcher.tick(); watcher.tick()
        self.assertEqual(self.updates[-1], {'setup_stage': 'connecting_waze', 'first_run': None})

    def test_timeouts_and_half_written_dumps_keep_the_last_known_state(self):
        timeout = subprocess.TimeoutExpired(['adb', 'shell', 'uiautomator'], 300)
        failure = subprocess.CalledProcessError(1, ['adb', 'shell', 'cat'])
        watcher = self.watcher(FakeAdb('', '', WELCOME, '', timeout, '', '', '<hierarchy><node', '', failure))
        watcher.tick()
        for _ in range(3):
            self.assertTrue(watcher.tick())
        self.assertEqual(len(self.updates), 1)
        self.assertEqual(self.updates[0]['setup_stage'], 'needs_first_run')

    def test_reports_end_watching_and_no_further_dumps_run(self):
        adb = FakeAdb()
        watcher = self.watcher(adb)
        self.reports = True
        self.assertFalse(watcher.tick())
        self.assertEqual(adb.calls, [])
        self.assertEqual(self.updates, [{'setup_stage': 'ready', 'first_run': None}])

    def test_reports_clear_an_active_first_run_state(self):
        watcher = self.watcher(FakeAdb('', '', WELCOME))
        watcher.tick()
        self.reports = True
        self.assertFalse(watcher.tick())
        self.assertEqual(self.updates[-1], {'setup_stage': 'ready', 'first_run': None})

    def test_background_loop_stops_when_reports_arrive(self):
        watcher = self.watcher(FakeAdb())
        watcher.interval = 0
        self.reports = True
        watcher.start()
        watcher._thread.join(timeout=5)
        self.assertFalse(watcher._thread.is_alive())

    def test_stop_ends_the_background_loop(self):
        watcher = self.watcher(FakeAdb())
        watcher.interval = 3600
        watcher.start()
        watcher.stop()
        watcher._thread.join(timeout=5)
        self.assertFalse(watcher._thread.is_alive())


class InstructionTests(unittest.TestCase):
    def test_instructions_name_the_loopback_port_and_remote_forward(self):
        text = first_run_instructions(screen_access=True)
        self.assertIn('adb connect 127.0.0.1:5556', text)
        self.assertIn('ssh -L 5556:127.0.0.1:5556', text)
        self.assertNotIn('--screen-access', text)

    def test_instructions_without_screen_access_say_how_to_enable_it(self):
        text = first_run_instructions(screen_access=False)
        self.assertIn('--screen-access', text)
        self.assertIn('WAZE_SCREEN_ACCESS=1', text)
        self.assertIn('scrcpy -s 127.0.0.1:5556', text)


if __name__ == '__main__': unittest.main()
