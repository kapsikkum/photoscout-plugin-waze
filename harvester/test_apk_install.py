import subprocess
import unittest
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch

from apk_install import WAZE_SIGNERS, get_apks, verify_apk, worker_apks


class InstallerTrustTests(unittest.TestCase):
    def signed(self, signer=None, package='com.waze', version='5.25.0.1'):
        return [subprocess.CompletedProcess([], 0, stdout=f'Signer #1 certificate SHA-256 digest: {signer or sorted(WAZE_SIGNERS)[0]}\n'),
                subprocess.CompletedProcess([], 0, stdout=f"package: name='{package}' versionCode='1' versionName='{version}'\n")]

    def test_vendor_signature_and_package_are_required(self):
        with patch('apk_install.subprocess.run', side_effect=self.signed()):
            verify_apk(Path('base.apk'), '5.25.0.1')
        with patch('apk_install.subprocess.run', side_effect=self.signed(signer='0' * 64)):
            with self.assertRaisesRegex(RuntimeError, 'official Waze publisher'):
                verify_apk(Path('base.apk'))
        with patch('apk_install.subprocess.run', side_effect=self.signed(package='com.example.other')):
            with self.assertRaisesRegex(RuntimeError, 'not the Waze Android package'):
                verify_apk(Path('base.apk'))

    def test_invalid_signature_cannot_be_accepted_by_its_printed_fingerprint(self):
        with patch('apk_install.subprocess.run', side_effect=subprocess.CalledProcessError(1, ['apksigner'])):
            with self.assertRaises(subprocess.CalledProcessError):
                verify_apk(Path('base.apk'))

    def test_version_must_match_and_cannot_escape_the_cache(self):
        with patch('apk_install.subprocess.run', side_effect=self.signed(version='1.0')):
            with self.assertRaisesRegex(RuntimeError, 'version does not match'):
                verify_apk(Path('base.apk'), '5.25.0.1')
        with patch('apk_install.Path.mkdir') as mkdir:
            with self.assertRaisesRegex(RuntimeError, 'Invalid Waze installer version'):
                get_apks('../escape')
            mkdir.assert_not_called()

    def test_download_selects_the_guest_abi_and_uses_a_separate_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            def download(command, **kwargs):
                self.assertIn('acknowledge_dangers=true,arch=arm64-v8a', command)
                target = Path(command[-1])
                self.assertEqual(target, cache / 'arm64-v8a')
                with zipfile.ZipFile(target / 'com.waze@5.25.0.1@arm64-v8a.apk', 'w') as apk:
                    apk.writestr('lib/arm64-v8a/libwaze.so', b'test')
            with patch('apk_install.subprocess.run', side_effect=download), patch('apk_install.verify_apk'):
                self.assertEqual(len(get_apks('5.25.0.1', cache=cache)), 1)

    def test_incompatible_native_code_is_rejected_before_android_transfer(self):
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / 'base.apk'
            with zipfile.ZipFile(apk, 'w') as archive:
                archive.writestr('lib/armeabi-v7a/libwaze.so', b'test')
            with patch('apk_install.verify_apk'):
                with self.assertRaisesRegex(RuntimeError, 'guest architecture'):
                    get_apks('5.25.0.1', str(apk), cache=Path(directory))

    def test_worker_selects_its_abi_language_and_one_display_but_keeps_features(self):
        names = ['base.apk', 'split_config.arm64_v8a.apk', 'split_config.armeabi_v7a.apk',
                 'split_config.en.apk', 'split_config.fr.apk', 'split_config.xxhdpi.apk',
                 'split_config.xxxhdpi.apk', 'navigation_feature.apk', 'config.unknown_feature.apk']
        selected = worker_apks([Path(name) for name in names])
        self.assertEqual([p.name for p in selected], ['base.apk', 'split_config.arm64_v8a.apk',
                         'split_config.en.apk', 'split_config.xxhdpi.apk', 'navigation_feature.apk', 'config.unknown_feature.apk'])

    def test_a_standalone_apk_is_retained(self):
        self.assertEqual(worker_apks([Path('com.waze.apk')]), [Path('com.waze.apk')])


if __name__ == '__main__': unittest.main()
