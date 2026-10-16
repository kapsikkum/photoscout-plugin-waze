import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
import harvester
from report_queue import ReportQueue


class ReportApiTests(unittest.TestCase):
    def setUp(self):
        self.auth = patch.object(harvester, 'SERVICE_API_KEY', 'isolated-test-key')
        self.auth.start()
        self.addCleanup(self.auth.stop)
        self.collector = patch.object(harvester, 'report_collector')
        self.mock = self.collector.start()
        self.addCleanup(self.collector.stop)
        self.mock.store.snapshot.return_value = {'alerts': [{'id': 'report', 'point': [151.2, -33.88]}],
            'connected': True, 'observedAt': 1000, 'policeCount': 1, 'mock': False}
        self.client = TestClient(harvester.app)

    def test_health_exposes_no_report_locations_and_alerts_require_a_key(self):
        response = self.client.get('/health')
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('alerts', response.json()['reports'])
        self.assertNotIn('point', response.text)
        self.assertEqual(self.client.get('/alerts').status_code, 401)
        self.assertEqual(self.client.get('/alerts', headers={'X-API-Key': 'wrong'}).status_code, 401)
        self.assertEqual(self.client.get('/alerts', headers=[(b'x-api-key', '😀'.encode())]).status_code, 401)

    def test_readiness_check_does_not_move_or_queue_the_emulator(self):
        self.mock.centre = [151.2, -33.88]
        response = self.client.get('/alerts', headers={'X-API-Key': 'isolated-test-key'})
        self.assertEqual(response.status_code, 200)
        self.mock.scan.assert_not_called()
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    def test_bounds_queue_and_scan_failure_returns_service_unavailable(self):
        queue = ReportQueue(lambda *args: {'connected': False})
        with patch.object(harvester, 'report_queue', queue):
            headers = {'X-API-Key': 'isolated-test-key'}
            params = {'minLng': 151.2, 'minLat': -33.9, 'maxLng': 151.22, 'maxLat': -33.88}
            self.assertEqual(self.client.get('/alerts', params=params, headers=headers).status_code, 202)
            queue.run_one()
            response = self.client.get('/alerts', params=params, headers=headers)
            self.assertEqual(response.status_code, 503)
            self.assertIn('Retry-After', response.headers)
            self.assertEqual(self.client.get('/alerts?minLng=nan', headers=headers).status_code, 400)

if __name__ == '__main__': unittest.main()
