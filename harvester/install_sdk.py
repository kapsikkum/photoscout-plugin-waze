"""Install Google command-line tools from the published, checksum-verified SDK manifest."""
import hashlib
from pathlib import Path
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

BASE = 'https://dl.google.com/android/repository/'
root = ET.fromstring(urllib.request.urlopen(BASE + 'repository2-1.xml', timeout=60).read())
packages = []
for package in root.iter():
    if package.tag.split('}')[-1] != 'remotePackage' or not package.attrib.get('path', '').startswith('cmdline-tools;'):
        continue
    if package.find('channelRef') is not None and package.find('channelRef').attrib.get('ref') != 'channel-0':
        continue
    revision = package.find('revision')
    if revision is not None:
        packages.append((int(revision.findtext('major', '0')), package))
for _, package in sorted(packages, key=lambda p: p[0], reverse=True):
    archive = next((a for a in package.findall('archives/archive') if a.findtext('host-os') == 'linux'), None)
    if archive is not None:
        complete = archive.find('complete')
        url, checksum = complete.findtext('url'), complete.findtext('checksum')
        break
else:
    raise RuntimeError('Google SDK manifest contains no Linux command-line tools')
dest = Path('/tmp/android-tools.zip')
urllib.request.urlretrieve(BASE + url, dest)
if hashlib.sha1(dest.read_bytes()).hexdigest() != checksum:
    raise RuntimeError('Google SDK download checksum mismatch')
target = Path('/opt/android/cmdline-tools/latest')
target.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(dest) as archive:
    for info in archive.infolist():
        parts = Path(info.filename).parts
        if not parts or parts[0] != 'cmdline-tools' or '..' in parts:
            continue
        output = target.joinpath(*parts[1:])
        if info.is_dir():
            output.mkdir(parents=True, exist_ok=True)
        else:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(archive.read(info))
            if output.parent.name == 'bin':
                output.chmod(0o755)
dest.unlink()
