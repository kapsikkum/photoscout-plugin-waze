import subprocess
import unittest
from unittest.mock import patch
from boot_emulator import press_waze_get_started


def screen(*nodes):
    return '<hierarchy><node text="" bounds="[0,0][480,800]">' + ''.join(nodes) + '</node></hierarchy>'


GET_STARTED = '<node text="Get started" resource-id="com.waze:id/authWelcomePrimaryButton" bounds="[40,600][440,680]"/>'


class FakeAdb:
    """Serves a UI dump and wm size, and records every input tap."""

    def __init__(self, dump=None, size='Physical size: 1080x1920', fail_dump=False, fail_tap=False):
        self.dump, self.size = dump, size
        self.fail_dump, self.fail_tap = fail_dump, fail_tap
        self.taps = []

    def __call__(self, *args, timeout):
        command = args[1]
        if command.startswith('uiautomator'):
            if self.fail_dump:
                raise subprocess.CalledProcessError(1, 'adb')
            return self.dump
        if command == 'wm':
            return self.size
        if command == 'input':
            self.taps.append(tuple(args[2:]))
            if self.fail_tap:
                raise subprocess.TimeoutExpired('adb', timeout)
            return ''
        raise AssertionError(f'unexpected adb call: {args}')


class PressGetStartedTests(unittest.TestCase):
    def run_with(self, adb):
        with patch('boot_emulator.emulator_adb', side_effect=adb):
            return press_waze_get_started()

    def test_get_started_text_is_tapped_at_its_centre(self):
        adb = FakeAdb(screen(GET_STARTED))
        self.assertTrue(self.run_with(adb))
        self.assertEqual(adb.taps, [('tap', '240', '640')])

    def test_content_description_and_resource_id_also_match(self):
        cases = {
            'desc': '<node text="" content-desc="Get started" bounds="[0,100][480,200]"/>',
            'id': '<node text="" resource-id="com.waze:id/welcome_get_started" bounds="[0,100][480,200]"/>',
        }
        for name, node in cases.items():
            with self.subTest(name):
                adb = FakeAdb(screen(node))
                self.assertTrue(self.run_with(adb))
                self.assertEqual(adb.taps, [('tap', '240', '150')])

    def test_matching_ignores_case_and_surrounding_spaces(self):
        adb = FakeAdb(screen('<node text="  GET STARTED " bounds="[0,100][480,200]"/>'))
        self.assertTrue(self.run_with(adb))
        self.assertEqual(adb.taps, [('tap', '240', '150')])

    def test_a_match_without_parseable_bounds_is_not_tapped_and_the_fallback_runs(self):
        adb = FakeAdb(screen('<node text="Get started" bounds="nowhere"/>'))
        self.assertTrue(self.run_with(adb))
        self.assertEqual(adb.taps, [('tap', '540', '1689')])

    def test_no_match_taps_the_fallback_point_for_the_screen_size(self):
        adb = FakeAdb(screen('<node text="Log in" bounds="[0,0][10,10]"/>'))
        self.assertTrue(self.run_with(adb))
        self.assertEqual(adb.taps, [('tap', '540', '1689')])

    def test_unknown_screen_size_falls_back_to_480x800(self):
        adb = FakeAdb(screen(), size='not a size')
        self.assertTrue(self.run_with(adb))
        self.assertEqual(adb.taps, [('tap', '240', '704')])

    def test_unreadable_or_failed_dump_falls_back_without_raising(self):
        for adb in (FakeAdb('not xml at all'), FakeAdb(fail_dump=True)):
            with self.subTest(adb=adb.fail_dump):
                self.assertTrue(self.run_with(adb))
                self.assertEqual(adb.taps, [('tap', '540', '1689')])

    def test_a_failed_tap_is_reported_as_not_handled(self):
        adb = FakeAdb(screen(GET_STARTED), fail_tap=True)
        self.assertFalse(self.run_with(adb))
        self.assertEqual(adb.taps, [('tap', '240', '640'), ('tap', '540', '1689')])


if __name__ == '__main__': unittest.main()
