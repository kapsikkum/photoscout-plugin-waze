import unittest
from pin_emulator_metadata import pin_revision

class SdkMetadataTests(unittest.TestCase):
    def test_type_namespace_and_other_metadata_survive_the_revision_change(self):
        xml = '''<r xmlns:ns5="http://schemas.android.com/repository/android/generic/02">
          <localPackage path="emulator"><type-details xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ns5:genericDetailsType"/>
          <revision><major>37</major><minor>2</minor><micro>12</micro></revision><display-name>Android Emulator</display-name></localPackage></r>'''
        result = pin_revision(xml)
        self.assertIn('xmlns:ns5="http://schemas.android.com/repository/android/generic/02"', result)
        self.assertIn('xsi:type="ns5:genericDetailsType"', result)
        self.assertIn('<major>36</major><minor>6</minor><micro>11</micro>', result)
        self.assertEqual(result.split('<revision>')[0], xml.split('<revision>')[0])
        self.assertEqual(result.split('</revision>')[1], xml.split('</revision>')[1])

if __name__ == '__main__': unittest.main()
