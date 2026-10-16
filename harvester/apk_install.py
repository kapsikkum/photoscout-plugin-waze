"""Cache Waze installers and verify their publisher before Android installation."""
from pathlib import Path
import os
import re
import shutil
import subprocess
import zipfile

# Published for package com.waze at https://www.waze.com/.well-known/assetlinks.json.
WAZE_SIGNERS = {
    '7fd2cea30c3a6022eb29419ce8f6f92ce8a4bd35b0cc879ed3cca6cbf5e9992d',
    '03637f6c5d8f604e6fdb79a6ffbfa578de4e318f8da22fc6106665247f8807d7',
}
TOOLS = Path(os.environ.get('ANDROID_HOME', '/opt/android')) / 'build-tools' / '35.0.0'


class InstallerRequired(RuntimeError):
    """The automatic source cannot supply a compatible, verified installer."""


def worker_apks(apks, abi='arm64-v8a', density=240):
    """Install this controlled guest's configurations, retaining every feature APK."""
    densities = {'ldpi': 120, 'mdpi': 160, 'tvdpi': 213, 'hdpi': 240,
                 'xhdpi': 320, 'xxhdpi': 480, 'xxxhdpi': 640}
    configs = {}
    for apk in apks:
        match = re.fullmatch(r'(?:split_)?config\.([^./]+)\.apk', apk.name)
        if match:
            configs[apk] = match[1]
    available = set(configs.values()) & densities.keys()
    display = min(available, key=lambda name: (abs(densities[name] - density), densities[name])) if available else None
    selected = []
    for apk in apks:
        qualifier = configs.get(apk)
        if qualifier in densities and qualifier != display:
            continue
        if qualifier in ('arm64_v8a', 'armeabi_v7a', 'armeabi', 'x86', 'x86_64') and qualifier != abi.replace('-', '_'):
            continue
        if qualifier and re.fullmatch(r'[a-z]{2}(?:-r[A-Z]{2})?', qualifier) and not qualifier.startswith('en'):
            continue
        selected.append(apk)
    return selected


def verify_apk(path, version=None):
    verified = subprocess.run([str(TOOLS / 'apksigner'), 'verify', '--print-certs', str(path)],
        check=True, capture_output=True, text=True, timeout=120)
    signers = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]{64})$', verified.stdout, flags=re.M)
    if not signers or any(s.lower() not in WAZE_SIGNERS for s in signers):
        raise RuntimeError('APK signer does not match the official Waze publisher')
    metadata = subprocess.run([str(TOOLS / 'aapt'), 'dump', 'badging', str(path)],
        check=True, capture_output=True, text=True, timeout=60).stdout
    package = re.search(r"^package: name='([^']+)'", metadata, flags=re.M)
    if not package or package[1] != 'com.waze':
        raise RuntimeError('Installer is not the Waze Android package')
    if version is not None and f"versionName='{version}'" not in metadata.splitlines()[0]:
        raise RuntimeError('Waze installer version does not match the report reader')


def get_apks(version, supplied=None, cache=Path('/data/apk'), *, abi='arm64-v8a'):
    if not re.fullmatch(r'\d+(?:\.\d+){1,4}', version):
        raise RuntimeError('Invalid Waze installer version')
    if abi not in ('arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'):
        raise RuntimeError('Unsupported Android application architecture')
    # Android 12's 64-bit image cannot run ARMv7. Keep variants in separate
    # caches so an earlier download cannot silently select an incompatible APK.
    cache = cache / abi
    cache.mkdir(parents=True, exist_ok=True)
    if supplied:
        files = [Path(supplied)]
    else:
        files = sorted(p for p in cache.iterdir() if p.name in
                       {f'com.waze@{version}{variant}{extension}' for variant in ('', f'@{abi}')
                        for extension in ('.apk', '.xapk', '.apks', '.zip')})
        if not files:
            # Downloading from a mirror is not trust: every APK must pass Google's
            # signature verifier and the publisher allowlist below before it runs.
            subprocess.run(['apkeep', '-d', 'apk-pure', '-a', f'com.waze@{version}',
                '-o', f'acknowledge_dangers=true,arch={abi}', str(cache)], check=True, timeout=900)
            files = sorted(p for p in cache.iterdir() if p.name in
                           {f'com.waze@{version}{variant}{extension}' for variant in ('', f'@{abi}')
                            for extension in ('.apk', '.xapk', '.apks', '.zip')})
    if not files:
        raise InstallerRequired('Waze download produced no installer; supply an ARM64 Waze APK bundle')
    apks = []
    for file in files:
        if file.suffix == '.apk':
            apks.append(file)
            continue
        extract = cache / 'verified' / version
        extract.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(file) as archive:
            entries = [info for info in archive.infolist() if info.filename.endswith('.apk')]
            if sum(info.file_size for info in entries) > 512 * 1024 * 1024:
                raise RuntimeError('Waze installer archive exceeds the size limit')
            names = set()
            for info in entries:
                name = Path(info.filename).name
                if name in names or not re.fullmatch(r'[A-Za-z0-9._-]+\.apk', name):
                    raise RuntimeError('Invalid or duplicate APK archive member')
                names.add(name)
                target = extract / name
                with archive.open(info) as source, target.open('wb') as destination:
                    shutil.copyfileobj(source, destination)
                apks.append(target)
    if not apks:
        raise RuntimeError('Waze installer contains no APKs')
    for apk in apks:
        verify_apk(apk)
    base = next((apk for apk in apks if apk.name in ('com.waze.apk', 'base.apk')), apks[0])
    verify_apk(base, version)
    native_abis = set()
    for apk in apks:
        with zipfile.ZipFile(apk) as archive:
            native_abis.update(parts[1] for name in archive.namelist()
                               if len(parts := name.split('/')) >= 3 and parts[0] == 'lib' and name.endswith('.so'))
    if native_abis and abi not in native_abis:
        raise InstallerRequired(f'Waze installer does not support the Android guest architecture ({abi}); supply a compatible Waze APK bundle')
    return apks
