"""Change the SDK revision without dropping QName namespace declarations."""
from pathlib import Path
import re
import xml.etree.ElementTree as ET


def pin_revision(text):
    root = ET.fromstring(text)
    packages = [node for node in root.iter() if node.tag.split('}')[-1] == 'localPackage']
    if len(packages) != 1 or packages[0].get('path') != 'emulator':
        raise ValueError('Expected the emulator SDK package metadata')
    updated, count = re.subn(r'<revision>.*?</revision>',
        '<revision><major>36</major><minor>6</minor><micro>11</micro></revision>', text, count=1, flags=re.S)
    if count != 1:
        raise ValueError('Emulator SDK revision was not found')
    return updated


if __name__ == '__main__':
    path = Path('/opt/android/emulator/package.xml')
    path.write_text(pin_revision(path.read_text(encoding='utf-8')), encoding='utf-8')
