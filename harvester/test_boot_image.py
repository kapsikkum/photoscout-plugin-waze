import unittest
from unittest.mock import patch
import boot_emulator
from boot_emulator import avd_name_for, screen_relay_args, start_screen_relay


class SystemImageTests(unittest.TestCase):
    def test_avd_name_follows_the_api_level_of_the_configured_image(self):
        self.assertEqual(avd_name_for('system-images;android-36;google_apis;x86_64'), 'photoscout-api36')
        self.assertEqual(avd_name_for('system-images;android-31;google_apis;x86_64'), 'photoscout-api31')

    def test_dotted_and_16k_page_images_get_their_own_avd(self):
        self.assertEqual(avd_name_for('system-images;android-37.0;google_apis;x86_64'), 'photoscout-api37-0')
        self.assertEqual(avd_name_for('system-images;android-37.1;google_apis_ps16k;x86_64'), 'photoscout-api37-1-ps16k')

    def test_only_google_apis_x86_64_images_are_accepted(self):
        for image in ('system-images;android-36;google_apis_playstore;x86_64', 'system-images;android-36;google_apis;arm64-v8a',
                      'system-images;android-36;default;x86_64', 'android-36', ''):
            with self.assertRaises(ValueError, msg=image):
                avd_name_for(image)


class ScreenRelayTests(unittest.TestCase):
    def test_relay_listens_in_the_container_and_forwards_only_to_the_guest_adb_port(self):
        args = screen_relay_args('/usr/bin/socat')
        self.assertEqual(args[0], '/usr/bin/socat')
        self.assertIn('TCP-LISTEN:5556,bind=0.0.0.0,fork,reuseaddr', args)
        self.assertEqual(args[-1], 'TCP:127.0.0.1:5555')

    def test_relay_is_off_by_default(self):
        with patch.dict('os.environ', clear=False) as env, patch('boot_emulator.subprocess.Popen') as popen:
            env.pop('WAZE_SCREEN_ACCESS', None)
            start_screen_relay()
            popen.assert_not_called()

    def test_enabled_relay_starts_once(self):
        boot_emulator.SCREEN_RELAY = None
        with patch.dict('os.environ', {'WAZE_SCREEN_ACCESS': '1'}), patch('boot_emulator.shutil.which', return_value='/usr/bin/socat'), \
                patch('boot_emulator.subprocess.Popen') as popen:
            popen.return_value.poll.return_value = None
            start_screen_relay()
            start_screen_relay()
            popen.assert_called_once_with(screen_relay_args('/usr/bin/socat'))
        boot_emulator.SCREEN_RELAY = None

    def test_missing_socat_does_not_stop_the_worker(self):
        boot_emulator.SCREEN_RELAY = None
        with patch.dict('os.environ', {'WAZE_SCREEN_ACCESS': '1'}), patch('boot_emulator.shutil.which', return_value=None), \
                patch('boot_emulator.subprocess.Popen') as popen:
            start_screen_relay()
            popen.assert_not_called()


if __name__ == '__main__': unittest.main()
