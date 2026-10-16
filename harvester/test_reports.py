import gzip
import unittest
from unittest.mock import patch, MagicMock
from rt_reports import parse_rt_reports
from rt_stream import ReportStore, ReportCollector

def varint(value):
    value %= 2**64
    out = bytearray()
    while value > 127:
        out.append((value & 127) | 128); value >>= 7
    out.append(value)
    return bytes(out)

def integer(field, value): return varint(field << 3) + varint(value)
def message(field, data): return varint(field << 3 | 2) + varint(len(data)) + data
def text(field, value): return message(field, value.encode())
def report(uuid='reported-police', police_type=2, report_time=1791987461):
    point = integer(101, 151209674) + integer(102, -33876869)
    details = message(2, integer(1, police_type))
    info = integer(1, 2) + message(3, point) + message(9, details)
    reporting = (integer(4, report_time) if report_time is not None else b'') + message(8, text(2, 'Example Road'))
    alert = integer(1, 123) + message(2, info) + message(3, reporting) + text(6, uuid)
    return message(1001, message(2708, message(1, alert)))

def frame(data, end=True): return len(data).to_bytes(3, 'big') + bytes([0, int(end)]) + (1).to_bytes(4, 'big') + data

class ReportTests(unittest.TestCase):
    def test_report_schema_and_negative_latitude(self):
        alerts, removed = parse_rt_reports(report())
        self.assertEqual(removed, [])
        self.assertEqual(alerts[0]['point'], [151.209674, -33.876869])
        self.assertEqual(alerts[0]['type'], 'POLICE')
        self.assertEqual(alerts[0]['subType'], 'POLICE_HIDDEN')
        self.assertEqual(alerts[0]['reportTime'], 1791987461000)
        self.assertEqual(alerts[0]['street'], 'Example Road')

    def test_fragmented_http2_gzip_and_removal(self):
        store = ReportStore()
        compressed = gzip.compress(report())
        stream = frame(compressed[:10], False) + frame(compressed[10:])
        for i in range(0, len(stream), 3): store.receive('connection', stream[i:i+3])
        self.assertEqual(len(store.reports), 1)
        store.receive('connection', frame(message(1001, message(2794, text(1, 'reported-police')))))
        self.assertEqual(store.reports, {})

    def test_mobile_speed_camera_subtype_and_absent_timestamps(self):
        alerts, _ = parse_rt_reports(report(police_type=3, report_time=None))
        self.assertEqual(alerts[0]['subType'], 'POLICE_MOBILE_CAMERA')
        self.assertIsNone(alerts[0]['reportTime'])
        self.assertTrue(alerts[0]['id'])

    def test_expiry_removes_stored_reports_and_unknown_times_do_not_live_forever(self):
        store = ReportStore()
        with patch('rt_stream.time.time', return_value=10000):
            store.reports['untimed'] = {'id': 'untimed', 'type': 'POLICE', 'reportTime': None}
            store.seen_at['untimed'] = 9900
            self.assertEqual(len(store.snapshot()['alerts']), 1)
        with patch('rt_stream.time.time', return_value=18000):
            self.assertEqual(store.snapshot()['alerts'], [])
            self.assertEqual(store.reports, {})
            self.assertEqual(store.seen_at, {})

    def test_truncated_and_oversized_payloads_fail(self):
        for data in (b'\x80', b'\x0a\x05\x01', b'\x00'):
            with self.assertRaises(ValueError): parse_rt_reports(data)
        with self.assertRaises(ValueError): ReportStore().receive('c', b'\xff\xff\xff\x00\x01\x00\x00\x00\x01')

    def test_physical_phone_is_rejected_before_touching_waze(self):
        collector = ReportCollector()
        with patch.object(collector, 'adb_run') as adb, patch('rt_stream.frida.get_device') as device:
            adb.return_value.stdout = ''
            with self.assertRaisesRegex(RuntimeError, 'requires an Android emulator'):
                collector.start()
            device.assert_not_called()
            self.assertEqual(adb.call_count, 2)
            self.assertTrue(all(call.args[:2] == ('shell', 'getprop') for call in adb.call_args_list))

    def test_software_guest_uses_normal_fresh_launch_and_does_not_resume_it(self):
        collector = ReportCollector(software_guest=True)
        collector.serial = 'emulator-5554'
        device = MagicMock()
        results = [MagicMock(stdout='1\n'), MagicMock(stdout=''),
                   MagicMock(stdout='com.waze/.FreeMapAppActivity\n'),
                   MagicMock(stdout='Starting: Intent'), MagicMock(stdout='7783\n')]
        with patch.object(collector, 'adb_run', side_effect=results) as adb, patch('rt_stream.frida.get_device', return_value=device), patch.dict('os.environ', {'FRIDA_DEVICE_ID': 'emulator-5554'}):
            collector.start()
            adb.assert_any_call('shell', 'am', 'force-stop', 'com.waze')
            adb.assert_any_call('shell', 'am', 'start', '-n', 'com.waze/.FreeMapAppActivity')
            device.attach.assert_called_once_with(7783)
            device.spawn.assert_not_called()
            device.resume.assert_not_called()

    def test_software_mode_still_rejects_a_physical_phone_before_app_launch(self):
        collector = ReportCollector(software_guest=True)
        with patch.object(collector, 'adb_run', return_value=MagicMock(stdout='')) as adb, patch('rt_stream.frida.get_device') as device:
            with self.assertRaisesRegex(RuntimeError, 'requires an Android emulator'):
                collector.start()
            device.assert_not_called()
            self.assertTrue(all(call.args[:2] == ('shell', 'getprop') for call in adb.call_args_list))

if __name__ == '__main__': unittest.main()
