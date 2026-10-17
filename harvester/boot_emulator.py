"""Own the software AVD, Waze install and Frida daemon; expose the report API."""
import lzma
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
import xml.etree.ElementTree as ET
import frida
import requests
import uvicorn
import harvester
from first_run import FirstRunWatcher
from rt_stream import ReportCollector
from apk_install import get_apks, worker_apks, InstallerRequired

STOP = threading.Event()
EMULATOR = None
DEFAULT_SYSTEM_IMAGE = 'system-images;android-36;google_apis;x86_64'
# A new image gets a new AVD (and a fresh Waze install); the old AVD stays usable with its old image.
SYSTEM_IMAGE = os.environ.get('WAZE_SYSTEM_IMAGE', DEFAULT_SYSTEM_IMAGE).strip()
SCREEN_PORT = 5556
SCREEN_RELAY = None
# Required by the pinned Waze build, confirmed by GooglePlayServicesUtil on both test workers.
PINNED_WAZE_VERSION = '5.25.0.1'
PINNED_WAZE_PLAY_SERVICES_VERSION = 261200000


class PlayServicesRequired(RuntimeError):
    """A public, actionable dependency error rather than an authentication diagnosis."""


def check_play_services():
    package = emulator_adb('shell', 'dumpsys', 'package', 'com.waze', timeout=120)
    version = re.search(r'^\s*versionName=(\S+)', package, re.MULTILINE)
    # Do not assume another Waze release has the same dependency requirement.
    if not version or version[1] != PINNED_WAZE_VERSION:
        return
    services = emulator_adb('shell', 'dumpsys', 'package', 'com.google.android.gms', timeout=120)
    installed = re.search(r'^\s*versionCode=(\d+)', services, re.MULTILINE)
    if not installed or int(installed[1]) // 1000 < PINNED_WAZE_PLAY_SERVICES_VERSION // 1000:
        found = installed[1] if installed else 'missing'
        raise PlayServicesRequired(
            f'Waze {PINNED_WAZE_VERSION} requires Google Play services {PINNED_WAZE_PLAY_SERVICES_VERSION} '
            f'or newer; installed version: {found}. Update Google Play services or use a newer stock Google SDK image.'
        )


def reports_connected(collector):
    return collector.store.snapshot()['connected']


def avd_name_for(image):
    # Newer images are named like android-37.0, and 16 KB page-size builds carry _ps16k.
    match = re.fullmatch(r'system-images;android-(\d+)(?:\.(\d+))?;google_apis(_ps16k)?;x86_64', image)
    if not match:
        raise ValueError('WAZE_SYSTEM_IMAGE must be a Google APIs x86_64 system image, such as ' + DEFAULT_SYSTEM_IMAGE)
    minor = f'-{match[2]}' if match[2] is not None else ''
    return f'photoscout-api{match[1]}{minor}{"-ps16k" if match[3] else ""}'


AVD_NAME = avd_name_for(SYSTEM_IMAGE)


def run(*args, input=None, timeout=60):
    return subprocess.run(args, input=input, text=True, check=True, capture_output=True, timeout=timeout)


def emulator_adb(*args, timeout):
    return run('adb', '-s', 'emulator-5554', *args, timeout=timeout).stdout


def update_state(**fields):
    with harvester.state_lock:
        harvester.state.update(fields)


def press_waze_get_started():
    try:
        xml_out = emulator_adb(
            'shell', 'uiautomator dump /sdcard/window_dump.xml >/dev/null && cat /sdcard/window_dump.xml',
            timeout=15,
        )
        root = ET.fromstring(xml_out)
        for node in root.iter('node'):
            text = (node.attrib.get('text') or '').strip().lower()
            desc = (node.attrib.get('content-desc') or '').strip().lower()
            res_id = (node.attrib.get('resource-id') or '').strip().lower()
            if 'get started' in text or 'get started' in desc or 'welcome_get_started' in res_id:
                bounds = node.attrib.get('bounds', '')
                match = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', bounds)
                if match:
                    x1, y1, x2, y2 = map(int, match.groups())
                    cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
                    emulator_adb('shell', 'input', 'tap', str(cx), str(cy), timeout=15)
                    return True
    except Exception:
        pass

    try:
        wm_out = emulator_adb('shell', 'wm', 'size', timeout=10)
        size_match = re.search(r'(\d+)x(\d+)', wm_out)
        width, height = map(int, size_match.groups()) if size_match else (480, 800)
    except Exception:
        width, height = 480, 800

    tap_x = int(width * 0.50)
    tap_y = int(height * 0.88)
    try:
        emulator_adb('shell', 'input', 'tap', str(tap_x), str(tap_y), timeout=15)
        return True
    except Exception:
        return False


def screen_access_enabled():
    return os.environ.get('WAZE_SCREEN_ACCESS') == '1'


def screen_relay_args(socat):
    # The container publishes this port on loopback only. The guest's adb port is 5555 for emulator -port 5554.
    return [socat, f'TCP-LISTEN:{SCREEN_PORT},bind=0.0.0.0,fork,reuseaddr', 'TCP:127.0.0.1:5555']


def start_screen_relay():
    global SCREEN_RELAY
    if not screen_access_enabled() or (SCREEN_RELAY is not None and SCREEN_RELAY.poll() is None):
        return
    socat = shutil.which('socat')
    if socat is None:
        harvester.logger.error('WAZE_SCREEN_ACCESS is set but socat is not installed; screen access is unavailable')
        return
    SCREEN_RELAY = subprocess.Popen(screen_relay_args(socat))


def prepare_debug_transport():
    # `adb root` restarts adbd. On software emulation its own short reconnect
    # timeout can fail even though the root request succeeded; verify afterwards.
    try:
        run('adb', '-s', 'emulator-5554', 'root')
    except subprocess.CalledProcessError as exc:
        output = (exc.stderr or exc.stdout or '').lower()
        if 'timeout expired while waiting for device' not in output and 'unable to connect for root' not in output:
            raise
    run('adb', '-s', 'emulator-5554', 'wait-for-device', timeout=180)
    if run('adb', '-s', 'emulator-5554', 'shell', 'id', '-u', timeout=60).stdout.strip() != '0':
        raise RuntimeError('The Android emulator image must support adb root')


def wait_android_services(timeout=600):
    # boot_completed survives a framework restart. Do not treat it as proof
    # that Android can install or launch apps on a slow software-emulated VM.
    deadline = time.monotonic() + timeout
    while not STOP.is_set() and time.monotonic() < deadline:
        try:
            services = run('adb', '-s', 'emulator-5554', 'shell', 'service', 'list', timeout=30).stdout
            if '\tpackage:' in services and '\tactivity:' in services:
                return
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass
        STOP.wait(5)
    raise RuntimeError('Android package and activity services are not ready')


def prepare_software_guest():
    run('adb', '-s', 'emulator-5554', 'wait-for-device', timeout=300)
    name = run('adb', '-s', 'emulator-5554', 'emu', 'avd', 'name', timeout=30).stdout.splitlines()
    if not name or name[0].strip() != AVD_NAME:
        raise RuntimeError('The software worker must own its Android emulator')
    prepare_debug_transport()
    multiplier = run('adb', '-s', 'emulator-5554', 'shell', 'getprop', 'ro.hw_timeout_multiplier').stdout.strip()
    if multiplier:
        # The multiplier only matters for slow software emulation. A KVM guest is
        # fast, so a low value baked into the image (e.g. 3 on the 37.1 images) is fine.
        if int(multiplier) < 10 and emulator_acceleration() != 'on':
            raise RuntimeError('Android image has an immutable timeout unsuitable for software emulation')
        return
    # AOSP's multiplier exists for slow software emulators. Restart only this
    # owned guest's framework so its preloaded Build class reads the new value.
    run('adb', '-s', 'emulator-5554', 'shell', 'stop')
    try:
        run('adb', '-s', 'emulator-5554', 'shell', 'setprop', 'ro.hw_timeout_multiplier', '10')
        if run('adb', '-s', 'emulator-5554', 'shell', 'getprop', 'ro.hw_timeout_multiplier').stdout.strip() != '10':
            raise RuntimeError('Android software-emulator timeout setting was not applied')
    finally:
        run('adb', '-s', 'emulator-5554', 'shell', 'start')


def prepare_integrity_verification():
    name = run('adb', '-s', 'emulator-5554', 'emu', 'avd', 'name', timeout=30).stdout.splitlines()
    if not name or name[0].strip() != AVD_NAME:
        raise RuntimeError('Only the owned Android guest can configure installation timeouts')
    key = 'app_integrity_verification_timeout'
    current = run('adb', '-s', 'emulator-5554', 'shell', 'settings', 'get', 'global', key).stdout.strip()
    if current.isdecimal() and int(current) >= 600000:
        return
    # AOSP explicitly allows increasing this timeout. Keep integrity checks
    # enabled: the software guest needs longer than the default 30 seconds.
    run('adb', '-s', 'emulator-5554', 'shell', 'settings', 'put', 'global', key, '600000')
    applied = run('adb', '-s', 'emulator-5554', 'shell', 'settings', 'get', 'global', key).stdout.strip()
    if not applied.isdecimal() or int(applied) < 600000:
        raise RuntimeError('Android integrity verification timeout was not applied')


def emulator_acceleration():
    # KVM makes boot and Waze roughly an order of magnitude faster. Use it when
    # the container was given /dev/kvm; otherwise fall back to software emulation.
    mode = os.environ.get('WAZE_EMULATOR_ACCEL', 'auto')
    if mode in ('on', 'off'):
        return mode
    return 'on' if os.path.exists('/dev/kvm') and os.access('/dev/kvm', os.R_OK | os.W_OK) else 'off'


def compile_waze():
    # A no-KVM guest leaves Waze uncompiled (run-from-apk), so every launch
    # verified its dex in the interpreter for minutes and once crashed doing so.
    dexopt = run('adb', '-s', 'emulator-5554', 'shell', 'dumpsys', 'package', 'dexopt', timeout=180).stdout
    section = dexopt.split('[com.waze]', 1)[-1].split('\n  [', 1)[0] if '[com.waze]' in dexopt else ''
    if any(f'[status={status}]' in section for status in ('verify', 'speed-profile', 'speed', 'everything')):
        return
    # dex2oat aborts itself after 570 seconds, which a software guest exceeds.
    run('adb', '-s', 'emulator-5554', 'shell', 'setprop', 'dalvik.vm.dex2oat-flags', '--no-watch-dog')
    run('adb', '-s', 'emulator-5554', 'shell', 'cmd', 'package', 'compile', '-m', 'verify', '-f', 'com.waze', timeout=3600)


BACKGROUND_APPS = ('com.google.android.apps.youtube.music', 'com.google.android.youtube',
                   'com.google.android.apps.messaging', 'com.google.android.apps.photos')


def quiet_software_guest():
    name = run('adb', '-s', 'emulator-5554', 'emu', 'avd', 'name', timeout=30).stdout.splitlines()
    if not name or name[0].strip() != AVD_NAME:
        raise RuntimeError('Only the owned Android guest can be quietened')
    # A "System UI isn't responding" dialog covered Waze on the software guest;
    # ANR dialogs only block the unattended app there.
    run('adb', '-s', 'emulator-5554', 'shell', 'settings', 'put', 'global', 'hide_error_dialogs', '1')
    # Preinstalled apps competed with Waze for the emulated CPUs at launch.
    installed = run('adb', '-s', 'emulator-5554', 'shell', 'pm', 'list', 'packages', '-e', timeout=180).stdout
    for package in BACKGROUND_APPS:
        if f'package:{package}\n' in installed + '\n':
            run('adb', '-s', 'emulator-5554', 'shell', 'pm', 'disable-user', '--user', '0', package, timeout=120)


def start_report_reader():
    def running():
        return bool(run('adb', '-s', 'emulator-5554', 'shell', 'pidof', 'frida-server').stdout.strip())

    try:
        if running():
            return
    except subprocess.CalledProcessError as exc:
        if exc.returncode != 1:
            raise
        # pidof returns 1 when the daemon is absent.
    binary = Path('/data') / f'frida-server-{frida.__version__}'
    if not binary.exists():
        response = requests.get(f'https://github.com/frida/frida/releases/download/{frida.__version__}/frida-server-{frida.__version__}-android-x86_64.xz', timeout=120)
        response.raise_for_status()
        binary.write_bytes(lzma.decompress(response.content))
    run('adb', '-s', 'emulator-5554', 'push', str(binary), '/data/local/tmp/frida-server', timeout=600)
    run('adb', '-s', 'emulator-5554', 'shell', 'chmod', '755', '/data/local/tmp/frida-server')
    try:
        run('adb', '-s', 'emulator-5554', 'shell', '/data/local/tmp/frida-server -D >/dev/null 2>&1 </dev/null', timeout=15)
    except subprocess.TimeoutExpired:
        # The software guest may start the daemon before ADB returns. Preserve
        # that process; the collector must still connect before reporting ready.
        if not running():
            raise


def get_system_image_ramdisk():
    image_rel = Path(*SYSTEM_IMAGE.split(';'))
    return Path(os.environ.get('ANDROID_HOME', '/opt/android')) / image_rel / 'ramdisk.img'


def restore_persisted_ramdisk():
    persisted = Path('/data/ramdisk.img')
    system_ramdisk = get_system_image_ramdisk()
    if persisted.is_file() and system_ramdisk.parent.is_dir():
        try:
            if not system_ramdisk.is_file() or system_ramdisk.stat().st_size != persisted.stat().st_size:
                shutil.copyfile(persisted, system_ramdisk)
                harvester.logger.info('Restored Magisk-patched ramdisk from /data/ramdisk.img')
        except Exception as exc:
            harvester.logger.warning('Failed to restore /data/ramdisk.img: %s', exc)


def is_magisk_active():
    try:
        out = emulator_adb('shell', 'su', '-c', 'id', timeout=5)
        return 'uid=0' in out
    except Exception:
        return False


def root_avd_with_magisk():
    rootavd_script = Path('/opt/rootAVD/rootAVD.sh')
    if not rootavd_script.is_file():
        harvester.logger.warning('rootAVD script not found at /opt/rootAVD/rootAVD.sh; skipping Magisk rooting')
        return False
    system_ramdisk = get_system_image_ramdisk()
    android_home = Path(os.environ.get('ANDROID_HOME', '/opt/android'))
    try:
        rel_path = str(system_ramdisk.relative_to(android_home)).replace('\\', '/')
    except ValueError:
        rel_path = str(system_ramdisk)
    harvester.logger.info('Running rootAVD to patch ramdisk with Magisk...')
    run(rootavd_script.as_posix(), rel_path, input='1\n', timeout=300)
    
    global EMULATOR
    if EMULATOR and EMULATOR.poll() is None:
        try:
            EMULATOR.wait(timeout=60)
        except subprocess.TimeoutExpired:
            EMULATOR.terminate()
            try:
                EMULATOR.wait(timeout=20)
            except subprocess.TimeoutExpired:
                EMULATOR.kill()
    EMULATOR = None
    
    persisted = Path('/data/ramdisk.img')
    if system_ramdisk.is_file():
        try:
            shutil.copyfile(system_ramdisk, persisted)
            harvester.logger.info('Saved patched ramdisk to /data/ramdisk.img')
        except Exception as exc:
            harvester.logger.warning('Failed to persist /data/ramdisk.img: %s', exc)
    return True


STEALTH_PROPERTIES = (
    ('ro.product.model', 'Pixel 5'),
    ('ro.product.brand', 'google'),
    ('ro.product.manufacturer', 'Google'),
    ('ro.product.device', 'redfin'),
    ('ro.product.name', 'redfin'),
    ('ro.build.fingerprint', 'google/redfin/redfin:13/TQ3A.230805.001/10293847:user/release-keys'),
    ('ro.boot.flash.locked', '1'),
    ('ro.boot.verifiedbootstate', 'green'),
    ('ro.boot.veritymode', 'enforcing'),
    ('ro.build.type', 'user'),
    ('ro.build.tags', 'release-keys'),
    ('ro.debuggable', '0'),
    ('ro.secure', '1'),
    ('ro.boot.qemu', '0'),
    ('ro.kernel.qemu', '0'),
    ('ro.build.characteristics', 'nosdcard'),
)


def configure_magisk_and_props():
    if not is_magisk_active():
        return
    try:
        installed = emulator_adb('shell', 'su', '-c', '[ -d /data/adb/modules/playintegrityfix ] && echo 1 || echo 0', timeout=15).strip()
        if installed != '1':
            pif = Path('/opt/PIF.zip')
            if pif.is_file():
                run('adb', '-s', 'emulator-5554', 'push', str(pif), '/data/local/tmp/PIF.zip', timeout=60)
                emulator_adb('shell', 'su', '-c', 'magisk --install-module /data/local/tmp/PIF.zip', timeout=120)
                emulator_adb('shell', 'rm', '-f', '/data/local/tmp/PIF.zip', timeout=15)
                harvester.logger.info('Installed PlayIntegrityFix module in Magisk')
    except Exception as exc:
        harvester.logger.warning('Failed to configure PlayIntegrityFix: %s', exc)

    for prop, val in STEALTH_PROPERTIES:
        try:
            emulator_adb('shell', 'su', '-c', f'magisk resetprop {prop} "{val}"', timeout=15)
        except Exception:
            pass
    try:
        emulator_adb('shell', 'am', 'force-stop', 'com.google.android.gms', timeout=15)
        emulator_adb('shell', 'am', 'force-stop', 'com.android.vending', timeout=15)
    except Exception:
        pass


def check_waze_installed():
    try:
        out = emulator_adb('shell', 'pm', 'list', 'packages', 'com.waze', timeout=60)
        return 'com.waze' in out
    except Exception:
        return False


def check_waze_installer():
    try:
        out = emulator_adb('shell', 'dumpsys', 'package', 'com.waze', timeout=60)
        return bool(re.search(r'^\s*installerPackageName=com\.android\.vending', out, re.MULTILINE))
    except Exception:
        return False


def install_waze_as_vending(apks):
    """Install Waze split APKs setting installer package to com.android.vending."""
    harvester.logger.info('Installing Waze with installer package com.android.vending...')
    remote_dir = '/data/local/tmp/waze_install'
    emulator_adb('shell', 'rm', '-rf', remote_dir, timeout=60)
    emulator_adb('shell', 'mkdir', '-p', remote_dir, timeout=60)
    try:
        for apk in apks:
            run('adb', '-s', 'emulator-5554', 'push', str(apk), f'{remote_dir}/{apk.name}', timeout=600)
        out = emulator_adb('shell', 'pm', 'install-create', '-i', 'com.android.vending', '-r', '-g', timeout=60)
        match = re.search(r'\[(\d+)\]', out) or re.search(r'(\d+)', out)
        if not match:
            raise RuntimeError(f'Failed to create pm install session: {out}')
        sid = match.group(1)
        for apk in apks:
            emulator_adb('shell', 'pm', 'install-write', sid, apk.name, f'{remote_dir}/{apk.name}', timeout=300)
        res = emulator_adb('shell', 'pm', 'install-commit', sid, timeout=600)
        if 'Success' not in res:
            raise RuntimeError(f'pm install-commit failed: {res}')
        harvester.logger.info('Successfully installed Waze with com.android.vending installer source')
    finally:
        try:
            emulator_adb('shell', 'rm', '-rf', remote_dir, timeout=60)
        except Exception:
            pass


def start_emulator():
    global EMULATOR
    accel = emulator_acceleration()
    if EMULATOR is None or EMULATOR.poll() is not None:
        EMULATOR = subprocess.Popen(['emulator', '-avd', AVD_NAME, '-port', '5554', '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot-save',
            '-accel', accel, '-gpu', 'swiftshader_indirect', '-memory', os.environ.get('WAZE_EMULATOR_MEMORY_MB', '3072'),
            '-cores', os.environ.get('WAZE_EMULATOR_CORES', '4'), '-skin', '480x800'])
    return EMULATOR


def wait_emulator_boot(timeout=1800):
    prepare_software_guest()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if EMULATOR and EMULATOR.poll() is not None:
            raise RuntimeError('Android software emulator exited')
        try:
            if run('adb', '-s', 'emulator-5554', 'shell', 'getprop', 'sys.boot_completed', timeout=30).stdout.strip() == '1':
                break
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass
        time.sleep(5)
    else:
        raise RuntimeError('Android software emulator did not boot within 30 minutes')
    prepare_debug_transport()
    wait_android_services()
    prepare_integrity_verification()
    quiet_software_guest()


def initialize():
    global EMULATOR
    with harvester.state_lock:
        harvester.state.update(setup_stage='creating_emulator', last_error=None)
    avd = Path(os.environ['ANDROID_AVD_HOME'])
    avd.mkdir(parents=True, exist_ok=True)
    if not (avd / f'{AVD_NAME}.avd').exists():
        image_dir = Path(os.environ.get('ANDROID_HOME', '/opt/android')).joinpath(*SYSTEM_IMAGE.split(';'))
        if not image_dir.is_dir():
            raise RuntimeError(f'{SYSTEM_IMAGE} is not installed in this image; build it with --build-arg WAZE_SYSTEM_IMAGE={SYSTEM_IMAGE}')
        run('avdmanager', 'create', 'avd', '-n', AVD_NAME, '-k', SYSTEM_IMAGE, '--device', 'pixel', input='no\n')
    config = avd / f'{AVD_NAME}.avd' / 'config.ini'
    lines = [line for line in config.read_text().splitlines() if not line.startswith('hw.lcd.density=')]
    config.write_text('\n'.join(lines) + '\nhw.lcd.density=240\n')
    
    restore_persisted_ramdisk()
    start_emulator()
    start_screen_relay()
    boot_failed = False
    first_run_watch = None
    accel = emulator_acceleration()
    with harvester.state_lock:
        harvester.state.update(emulator_running=True, setup_stage='booting_android',
                               acceleration='kvm' if accel == 'on' else 'software')
    try:
        try:
            wait_emulator_boot()
        except Exception:
            boot_failed = True
            raise
        with harvester.state_lock:
            harvester.state.update(device_connected=True, boot_completed=True, setup_stage='preparing_android')
        
        # Ensure Magisk is active; if not, patch via rootAVD once and reboot
        if not Path('/data/ramdisk.img').is_file() and not is_magisk_active():
            if root_avd_with_magisk():
                start_emulator()
                try:
                    wait_emulator_boot()
                except Exception:
                    boot_failed = True
                    raise
        
        # Configure PIF module and stealth properties
        configure_magisk_and_props()
        
        with harvester.state_lock:
            harvester.state['setup_stage'] = 'installing_waze'
        try:
            run('adb', '-s', 'emulator-5554', 'shell', 'input', 'keyevent', '82', timeout=15)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            # A slow UI input dispatcher must not discard a successfully booted
            # emulator. Installation and the background report reader can proceed.
            harvester.logger.warning('Android keyguard is not ready; continuing app installation')
        run('adb', '-s', 'emulator-5554', 'emu', 'geo', 'fix', os.environ.get('WAZE_INITIAL_LNG', '151.2093'), os.environ.get('WAZE_INITIAL_LAT', '-33.8688'))
        
        installed = check_waze_installed()
        installer_ok = check_waze_installer() if installed else False
        if not installed or not installer_ok:
            apks = worker_apks(get_apks(os.environ.get('WAZE_VERSION', '5.25.0.1'), os.environ.get('WAZE_APK_PATH')))
            # Use pm install-create -i com.android.vending to officially set Play Store as installer
            try:
                install_waze_as_vending(apks)
            except Exception as exc:
                harvester.logger.warning('Failed to install via pm install-create: %s; falling back to install-multiple', exc)
                run('adb', '-s', 'emulator-5554', 'install-multiple', '--no-streaming', '-r', '-g', *map(str, apks), timeout=1800)
        check_play_services()
        with harvester.state_lock:
            harvester.state['setup_stage'] = 'compiling_waze'
        compile_waze()
        with harvester.state_lock:
            harvester.state.update(waze_ready=True, setup_stage='starting_report_reader')
        start_report_reader()
        collector = ReportCollector(software_guest=True)
        try:
            collector.start()
        except Exception:
            collector.close()
            raise
        harvester.attach_report_collector(collector)
        with harvester.state_lock:
            harvester.state.update(frida_ready=True, setup_stage='connecting_waze')
        # Read-only welcome-screen detection; it stops itself once reports flow.
        first_run_watch = FirstRunWatcher(adb=emulator_adb, has_reports=lambda: reports_connected(collector),
                                          update=update_state, screen_access=screen_access_enabled())
        first_run_watch.start()
        reader_started = time.monotonic()
        first_run_handled = False
        while not STOP.wait(5):
            if EMULATOR and EMULATOR.poll() is not None:
                raise RuntimeError('Android software emulator exited')
            with harvester.state_lock:
                current_stage = harvester.state.get('setup_stage')
                first_run_info = harvester.state.get('first_run')
            if (current_stage == 'needs_first_run' or first_run_info) and not first_run_handled:
                if press_waze_get_started():
                    first_run_handled = True
                    reader_started = time.monotonic()
                    update_state(setup_stage='connecting_waze')
            if not collector.store.ready and (collector.store.error or time.monotonic() - reader_started > 300):
                raise RuntimeError('Waze report collector disconnected')
    finally:
        if first_run_watch:
            first_run_watch.stop()
        update_state(first_run=None)
        if harvester.report_collector:
            harvester.report_collector.close(); harvester.report_collector = None
        if harvester.report_queue:
            harvester.report_queue.close(); harvester.report_queue = None
        # Retry installer/reader failures on the same booted device. Rebooting
        # Android after every transient ADB or network error prevents recovery.
        if STOP.is_set() or boot_failed or (EMULATOR and EMULATOR.poll() is not None):
            if EMULATOR:
                EMULATOR.terminate()
                try: EMULATOR.wait(timeout=20)
                except subprocess.TimeoutExpired: EMULATOR.kill()
                EMULATOR = None
            with harvester.state_lock:
                harvester.state.update(emulator_running=False, device_connected=False, boot_completed=False)


def worker():
    while not STOP.is_set():
        try:
            initialize()
        except InstallerRequired as exc:
            harvester.logger.error('Waze installer required: %s', exc)
            with harvester.state_lock:
                harvester.state.update(setup_stage='needs_installer', last_error='A compatible ARM64 Waze APK bundle is required; retry setup with --apk or WAZE_APK_PATH')
            STOP.wait()
        except PlayServicesRequired as exc:
            harvester.logger.error('%s', exc)
            update_state(setup_stage='needs_play_services', last_error=str(exc), waze_ready=False, frida_ready=False)
        except Exception as exc:
            harvester.logger.error('Android report setup failed: %s', str(exc))
            if isinstance(exc, subprocess.CalledProcessError):
                harvester.logger.error('Android tool output: %s', (exc.stderr or exc.stdout or '')[-2000:])
            with harvester.state_lock:
                harvester.state['last_error'] = 'Android setup failed; check the report service logs'
        STOP.wait(30)


if __name__ == '__main__':
    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    try:
        uvicorn.run(harvester.app, host=os.environ.get('BIND_HOST', '0.0.0.0'), port=harvester.PORT)
    finally:
        STOP.set()
        thread.join(timeout=25)
        if EMULATOR and EMULATOR.poll() is None:
            emulator.terminate()
        if SCREEN_RELAY and SCREEN_RELAY.poll() is None:
            SCREEN_RELAY.terminate()
