"""Console contracts, subprocess lifecycle and HTTP security (no business traffic)."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location('console_server', Path(__file__).with_name('server.py'))
console = importlib.util.module_from_spec(spec)
spec.loader.exec_module(console)


class ConsoleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        with patch.object(console.Manager, 'import_history'):
            self.manager = console.Manager(self.temp.name, 'http://127.0.0.1:47832/api', 'http://127.0.0.1:47840/')

    def tearDown(self):
        self.manager.close()
        self.temp.cleanup()

    def wait(self, ident):
        until = time.monotonic() + 8
        while time.monotonic() < until:
            row = self.manager.get(ident)
            if row['status'] not in console.ACTIVE and self.manager.active is None:
                return row
            time.sleep(.02)
        self.fail('job did not finish')

    def fake(self, report=True, code=0):
        def command(config, directory):
            script = "import json,pathlib;print('safe test log',flush=True);"
            if report:
                result = {'passed': code == 0, 'suites': []}
                script += f"pathlib.Path({str(directory / 'report.json')!r}).write_text(json.dumps({result!r}));"
            script += f'raise SystemExit({code})'
            return [sys.executable, '-u', '-c', script]
        return command

    def test_validation_ranges_and_nonfinite(self):
        for data in ({'kind':'shell'}, {'group':'../../bad'}, {'kind':'load','concurrency':'1;sh'},
                     {'kind':'load','concurrency':'65'}, {'kind':'load','duration':float('nan')},
                     {'kind':'load','duration':0}, {'kind':'load','maxRequests':1.5}, {'kind':'load','live':'yes'}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                console.clean_config(data)

    def test_load_defaults_to_preview(self):
        valid = console.clean_config({'kind':'load','scenario':'dispatcher'})
        self.assertFalse(valid['live'])

    def test_command_does_not_accept_user_shell_target_or_path(self):
        config = console.clean_config({'kind':'load','command':'rm -rf /','baseUrl':'http://evil','output':'/tmp/x'})
        command = self.manager.command(config, Path(self.temp.name))
        self.assertNotIn('http://evil', command)
        self.assertIn(self.manager.target, command)
        self.assertNotIn('--live', command)

    def test_success_and_persisted_detail(self):
        self.manager.command = self.fake()
        run = self.manager.start({'group':'quick'})
        self.assertEqual(self.wait(run['id'])['status'], 'passed')
        detail = self.manager.detail(run['id'])
        self.assertTrue(detail['report']['passed'])
        self.assertIn('safe test log', detail['log'])
        self.assertNotIn('reportPath', detail)

    def test_exit_zero_without_report_is_not_pass(self):
        self.manager.command = self.fake(report=False)
        run = self.manager.start({})
        self.assertEqual(self.wait(run['id'])['status'], 'failed')

    def test_preview_not_pass(self):
        self.manager.command = self.fake(report=False)
        run = self.manager.start({'kind':'load'})
        self.assertEqual(self.wait(run['id'])['status'], 'previewed')

    def test_failed_process(self):
        self.manager.command = self.fake(code=1)
        run = self.manager.start({})
        self.assertEqual(self.wait(run['id'])['status'], 'failed')

    def test_single_worker_and_cancel(self):
        self.manager.command = lambda *_: [sys.executable, '-u', '-c', 'import time; print("waiting",flush=True); time.sleep(60)']
        run = self.manager.start({})
        with self.assertRaises(RuntimeError):
            self.manager.start({})
        self.manager.stop(run['id'])
        self.assertEqual(self.wait(run['id'])['status'], 'stopped')

    def test_recover_interrupted(self):
        self.manager.save(dict(id='old', status='running', startedAt=console.now(), title='old', reportPath='/missing'))
        with patch.object(console.Manager, 'import_history'):
            recovered = console.Manager(self.temp.name, self.manager.target, self.manager.benchmark)
        self.assertEqual(recovered.get('old')['status'], 'interrupted')
        recovered.close()

    def test_secret_redaction(self):
        with patch.dict(os.environ, {'BENCHMARK_PASSWORD':'test-secret'}):
            self.assertNotIn('test-secret', self.manager.redact('x test-secret x'))

    def test_http_security_and_report_download(self):
        self.manager.command = self.fake()
        server = console.make_server(self.manager, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        def call(path, data=None, headers=None):
            req = Request(base+path, data=json.dumps(data).encode() if data is not None else None, headers=headers or {})
            return urlopen(req, timeout=3)
        try:
            with call('/api/health') as response:
                self.assertEqual(json.load(response)['service'], 'openclawx-test-console')
            with call('/api/config') as response:
                config = json.load(response)
            for headers in ({}, {'Content-Type':'application/json','Origin':'https://evil.example','X-Console-Token':config['token']}, {'Host':'evil.example'}):
                with self.assertRaises(HTTPError) as caught:
                    call('/api/runs', {}, headers)
                self.assertEqual(caught.exception.code, 403)
            headers={'Content-Type':'application/json','Origin':base,'X-Console-Token':config['token']}
            with call('/api/runs', {}, headers) as response:
                run=json.load(response)
            self.wait(run['id'])
            with call('/api/runs/'+run['id']+'/report') as response:
                self.assertIn('attachment', response.headers['Content-Disposition'])
                self.assertTrue(json.load(response)['passed'])
            with self.assertRaises(HTTPError):
                call('/../../AGENTS.md')
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
