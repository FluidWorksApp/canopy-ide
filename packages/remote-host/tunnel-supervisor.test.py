import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).with_name('tunnel-supervisor.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class TunnelHealthTest(unittest.TestCase):
    def test_startup_grace_and_repeated_failure(self):
        health = module.Health(0)
        for now in [0, 5, 10, 29]:
            self.assertFalse(health.observe(False, now))
        self.assertFalse(health.observe(False, 30))
        self.assertFalse(health.observe(False, 35))
        self.assertTrue(health.observe(False, 40))

    def test_transient_failure_does_not_restart(self):
        health = module.Health(0)
        health.observe(False, 30)
        health.observe(False, 35)
        self.assertFalse(health.observe(True, 40))
        self.assertFalse(health.observe(False, 45))
        self.assertEqual(health.failures, 1)

    def test_http_errors_are_not_transport_failure(self):
        for code in [401, 403, 500, 503]:
            with patch.object(module.urllib.request, 'build_opener') as opener:
                opener.return_value.open.side_effect = urllib.error.HTTPError('http://localhost', code, '', {}, None)
                self.assertTrue(module.reachable('http://localhost'))

    def test_timeout_is_transport_failure(self):
        with patch.object(module.urllib.request, 'build_opener') as opener:
            opener.return_value.open.side_effect = TimeoutError()
            self.assertFalse(module.reachable('http://localhost'))

    def test_backoff_is_bounded(self):
        for attempt in [1, 5, 1000]:
            self.assertLessEqual(module.retry_delay(attempt), 31)


if __name__ == '__main__':
    unittest.main()
