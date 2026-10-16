import unittest
import threading
from report_queue import ReportQueue

class QueueTests(unittest.TestCase):
    def setUp(self):
        self.now = 1000
        self.scans = []
        def scan(lng, lat):
            self.scans.append((lng, lat))
            return {'alerts': [{'id': f'{lng}:{lat}', 'point': [lng, lat], 'type': 'POLICE'}], 'coverage': 'viewport', 'connected': True, 'observedAt': int(self.now * 1000), 'mock': False}
        self.queue = ReportQueue(scan, clock=lambda: self.now, max_pending=4)
        self.sydney = (151.2, -33.88, 151.22, -33.86)
        self.bathurst = (149.55, -33.43, 149.57, -33.41)

    def test_users_in_same_area_share_one_scan(self):
        self.assertEqual(self.queue.request(self.sydney)['state'], 'queued')
        self.queue.request(self.sydney, navigation=True)
        self.assertEqual(len(self.queue.pending), 1)
        self.queue.run_one()
        first = self.queue.request(self.sydney)
        self.assertEqual(first['state'], 'fresh')
        self.assertEqual(len(self.scans), 1)

    def test_caches_do_not_cross_user_areas_and_expire(self):
        self.queue.request(self.sydney); self.queue.run_one()
        self.assertEqual(self.queue.request(self.bathurst)['alerts'], [])
        self.queue.run_one()
        self.assertEqual(len(self.scans), 2)
        self.now += 61
        self.assertEqual(self.queue.request(self.sydney)['state'], 'stale')
        self.now += 300
        self.assertEqual(self.queue.request(self.sydney)['state'], 'queued')

    def test_navigation_priority_is_fair_to_browsing(self):
        self.queue.request(self.bathurst)
        for offset in range(3):
            box = (151 + offset, -34, 151.01 + offset, -33.99)
            self.queue.request(box, navigation=True)
        self.queue.run_one(); self.queue.run_one(); self.queue.run_one(); self.queue.run_one()
        self.assertEqual(self.scans[-1], self.queue.centre(self.queue.area(149.56, -33.42)))

    def test_backpressure_and_failed_scan_are_honest(self):
        for offset in range(4): self.queue.request((offset, 0, offset + .01, .01))
        self.assertEqual(self.queue.request((10, 0, 10.01, .01))['state'], 'busy')
        self.queue.scanner = lambda *args: {'connected': False}
        self.queue.run_one()
        self.assertEqual(self.queue.cache, {})
        self.assertEqual(self.queue.status()['lastError'], 'Waze area scan failed')

    def test_failed_area_has_a_cooldown_then_can_recover(self):
        scanner = self.queue.scanner
        self.queue.scanner = lambda *args: {'connected': False}
        self.queue.request(self.sydney); self.queue.run_one()
        for _ in range(10):
            self.assertEqual(self.queue.request(self.sydney)['state'], 'unavailable')
        self.assertFalse(self.queue.run_one())
        self.now += 21
        self.queue.scanner = scanner
        self.assertEqual(self.queue.request(self.sydney)['state'], 'queued')
        self.queue.run_one()
        self.assertEqual(self.queue.request(self.sydney)['state'], 'fresh')

    def test_concurrent_consumers_cannot_move_the_emulator_together(self):
        entered, release = threading.Event(), threading.Event()
        scanner = self.queue.scanner
        def blocked_scan(*args):
            entered.set()
            if not release.wait(2):
                raise RuntimeError('Test scanner timed out')
            return scanner(*args)
        self.queue.scanner = blocked_scan
        self.queue.request(self.sydney); self.queue.request(self.bathurst)
        worker = threading.Thread(target=self.queue.run_one)
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertFalse(self.queue.run_one())
            self.assertEqual(len(self.queue.pending), 1)
        finally:
            release.set(); worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(self.scans), 1)

    def test_abandoned_map_views_expire_but_waiting_clients_keep_their_place(self):
        self.queue.request(self.sydney)
        self.queue.request(self.bathurst)
        self.now += 80
        self.queue.request(self.bathurst)
        self.now += 11
        self.queue.run_one()
        self.assertEqual(self.scans, [self.queue.centre(self.queue.area(149.56, -33.42))])
        self.assertFalse(self.queue.run_one())

if __name__ == '__main__': unittest.main()
