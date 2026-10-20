#!/usr/bin/env python3
"""Local, single-worker test console. Python standard library only."""
import argparse
import fcntl
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import secrets
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from urllib.parse import urlparse
import uuid

ROOT = Path(__file__).resolve().parents[2]
STATIC = Path(__file__).parent / 'static'
GROUPS = {'quick': '快速回归', 'voice': '实时语音回归', 'core': '核心编排回归', 'full': '完整仓库回归'}
ACTIVE = ('running', 'stopping')


def now():
    return datetime.now(timezone.utc).isoformat()


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def number(data, key, default, low, high, integer=False):
    value = data.get(key, default)
    if isinstance(value, bool):
        raise ValueError(f'{key} 必须为数值')
    try:
        parsed = float(value)
    except (ValueError, TypeError):
        raise ValueError(f'{key} 必须为数值')
    if not math.isfinite(parsed) or not low <= parsed <= high or (integer and not parsed.is_integer()):
        raise ValueError(f'{key} 范围为 {low}–{high}')
    return int(parsed) if integer else parsed


def clean_config(data):
    if not isinstance(data, dict):
        raise ValueError('配置必须为对象')
    kind = data.get('kind', 'regression')
    if kind == 'regression':
        group = data.get('group', 'quick')
        if group not in GROUPS:
            raise ValueError('未知回归组')
        return dict(kind=kind, group=group)
    if kind != 'load':
        raise ValueError('未知测试类型')
    scenario = data.get('scenario', 'dispatcher')
    if scenario not in ('dispatcher', 'runtime', 'durable'):
        raise ValueError('未知压测场景')
    concurrency = str(data.get('concurrency', '1,2,4'))
    try:
        stages = [int(x.strip()) for x in concurrency.split(',')]
    except ValueError:
        raise ValueError('并发阶梯示例：1,2,4')
    if not 1 <= len(stages) <= 10 or any(x < 1 or x > 64 for x in stages):
        raise ValueError('最多 10 个阶段，每阶段 1–64 并发')
    live, writes = data.get('live', False), data.get('allowWrites', False)
    if type(live) is not bool or type(writes) is not bool:
        raise ValueError('实测与写入开关必须为布尔值')
    return dict(kind=kind, scenario=scenario, concurrency=','.join(map(str, stages)),
                duration=number(data, 'duration', 30, 1, 3600),
                maxRequests=number(data, 'maxRequests', 3000, 1, 100000, True),
                p95=number(data, 'p95', 5000, 1, 3600000),
                errorRate=number(data, 'errorRate', .01, 0, 1),
                runTimeout=number(data, 'runTimeout', 120, 1, 600, True), live=live, allowWrites=writes)


class Manager:
    def __init__(self, data, target, benchmark):
        self.data, self.target, self.benchmark = Path(data), target, benchmark
        self.data.mkdir(parents=True, exist_ok=True)
        self.db = self.data / 'runs.sqlite3'
        self.lock = threading.RLock()
        self.process = None
        self.worker = None
        self.active = None
        self.closing = False
        with self.connect() as con:
            con.execute('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
        for row in self.rows():
            if row['status'] in ACTIVE:
                row.update(status='interrupted', finishedAt=now(), error='服务异常退出，未确认测试完成。请核查遗留测试进程。')
                self.save(row)
        self.import_history()

    def connect(self):
        return sqlite3.connect(self.db, timeout=10)

    def save(self, row):
        with self.connect() as con:
            con.execute('INSERT OR REPLACE INTO runs VALUES (?, ?)', (row['id'], json.dumps(row, ensure_ascii=False)))

    def rows(self):
        with self.connect() as con:
            return sorted([json.loads(x[0]) for x in con.execute('SELECT body FROM runs')], key=lambda x: x['startedAt'], reverse=True)

    def get(self, ident):
        with self.connect() as con:
            item = con.execute('SELECT body FROM runs WHERE id=?', (ident,)).fetchone()
        if not item:
            raise KeyError(ident)
        return json.loads(item[0])

    def import_history(self):
        # Only fixed repository report directories; no user-supplied filesystem paths.
        paths = []
        for path in paths:
            report = read_json(path)
            if not isinstance(report, dict) or not isinstance(report.get('passed'), bool):
                continue
            kind = 'regression' if isinstance(report.get('suites'), list) else 'load' if isinstance(report.get('stages'), list) else None
            if not kind:
                continue
            ident = 'import-' + hashlib.sha256(str(path).encode()).hexdigest()[:20]
            try:
                self.get(ident)
                continue
            except KeyError:
                pass
            stamp = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
            self.save(dict(id=ident, title='历史 · ' + (report.get('group') or report.get('scenario', path.stem)), kind=kind,
                           config={}, status='passed' if report['passed'] else 'failed', startedAt=report.get('startedAt', stamp),
                           finishedAt=stamp, reportPath=str(path), imported=True))

    def command(self, config, directory):
        if config['kind'] == 'regression':
            return [sys.executable, '-u', str(ROOT / 'tests/console/run_regression.py'), '--group', config['group'],
                    '--output-dir', str(directory)]
        command = [sys.executable, '-u', str(ROOT / 'tests/console/run_load.py'), '--target', self.target,
                   '--scenario', config['scenario'], '--output', str(directory / 'report.json')]
        if config['live']:
            command += ['--live']
        return command

    def start(self, data):
        config = clean_config(data)
        with self.lock:
            if self.active or self.closing:
                raise RuntimeError('已有测试执行中，请等待完成或先停止。')
            ident = uuid.uuid4().hex
            directory = self.data / ident
            directory.mkdir()
            title = GROUPS[config['group']] if config['kind'] == 'regression' else ('压测 · ' if config['live'] else '计划预览 · ') + config['scenario']
            row = dict(id=ident, title=title, kind=config['kind'], config=config, status='running', startedAt=now(),
                       reportPath=str(directory / 'report.json'), imported=False)
            if config['kind'] == 'load':
                row['target'] = self.target
            self.save(row)
            self.active = ident
            self.worker = threading.Thread(target=self.run, args=(row, directory), daemon=False)
            self.worker.start()
            return self.public(row)

    def run(self, row, directory):
        try:
            with (directory / 'console.log').open('w') as log:
                with self.lock:
                    # Stop may arrive before Popen.
                    if self.get(row['id'])['status'] == 'stopping':
                        row.update(status='stopped', finishedAt=now())
                        self.save(row)
                        return
                    self.process = subprocess.Popen(self.command(row['config'], directory), cwd=ROOT, stdout=log,
                                                    stderr=subprocess.STDOUT, start_new_session=True)
                code = self.process.wait()
            with self.lock:
                stopped = self.get(row['id'])['status'] == 'stopping'
                report = read_json(directory / 'report.json')
                preview = row['kind'] == 'load' and not row['config']['live']
                status = 'stopped' if stopped else 'previewed' if preview and code == 0 else 'passed' if code == 0 and report and report.get('passed') is True else 'failed'
                row.update(status=status, exitCode=code, finishedAt=now())
                self.save(row)
        except Exception as error:
            row.update(status='failed', error=type(error).__name__, finishedAt=now())
            self.save(row)
        finally:
            with self.lock:
                self.process = None
                self.active = None

    def stop(self, ident):
        with self.lock:
            row = self.get(ident)
            if ident != self.active or row['status'] not in ACTIVE:
                raise ValueError('此任务已结束，不能停止')
            if row['status'] == 'stopping':
                return
            row['status'] = 'stopping'
            self.save(row)
            if self.process and self.process.poll() is None:
                # Both launchers handle KeyboardInterrupt and drain their own children.
                try:
                    self.process.send_signal(signal.SIGINT)
                except ProcessLookupError:
                    pass

    def close(self):
        with self.lock:
            self.closing = True
            if self.active:
                self.stop(self.active)
            worker = self.worker
        if worker:
            worker.join()  # Allow bounded CLI requests to drain; do not orphan test processes.

    def redact(self, text):
        for key in ('BENCHMARK_PASSWORD',):
            value = os.getenv(key)
            if value:
                text = text.replace(value, '[REDACTED]')
        return text

    def report(self, row):
        report = read_json(Path(row['reportPath']))
        return json.loads(self.redact(json.dumps(report, ensure_ascii=False)))

    def public(self, row):
        return {key: value for key, value in row.items() if key != 'reportPath'}

    def detail(self, ident):
        row = self.get(ident)
        directory = Path(row['reportPath']).parent
        logs = []
        if not row.get('imported'):
            for path in sorted(directory.glob('*.log')):
                with path.open('rb') as file:
                    file.seek(max(0, path.stat().st_size - 24000))
                    logs.append('── ' + path.name + ' ──\n' + file.read(24000).decode('utf-8', errors='replace'))
        return dict(**self.public(row), report=self.report(row), log=self.redact('\n'.join(logs))[-100000:])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, status, body, content='application/json; charset=utf-8', download=False):
        raw = json.dumps(body, ensure_ascii=False).encode() if content.startswith('application/json') else body
        self.send_response(status)
        self.send_header('Content-Type', content)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if download:
            self.send_header('Content-Disposition', 'attachment; filename="test-report.json"')
        self.end_headers()
        self.wfile.write(raw)

    def host_ok(self):
        port = self.server.server_port
        return self.headers.get('Host') in (f'127.0.0.1:{port}', f'localhost:{port}')

    def do_GET(self):
        if not self.host_ok():
            return self.respond(403, {'error': '仅接受本机访问'})
        path = urlparse(self.path).path
        manager = self.server.manager
        try:
            if path == '/api/config':
                return self.respond(200, dict(token=self.server.token, target=manager.target, benchmark=manager.benchmark,
                    credentialsReady=True))
            if path == '/api/health':
                active = next((r for r in manager.rows() if r['status'] in ACTIVE), None)
                return self.respond(200, dict(status='ok', service='openclawx-test-console', version=1,
                                              activeRunId=active['id'] if active else None))
            if path == '/api/runs':
                return self.respond(200, [manager.public(r) for r in manager.rows()])
            if path.startswith('/api/runs/'):
                parts = path.split('/')
                if len(parts) == 5 and parts[4] == 'report':
                    report = manager.report(manager.get(parts[3]))
                    if report is None:
                        return self.respond(404, {'error': '尚未产生报告'})
                    return self.respond(200, report, download=True)
                if len(parts) == 4:
                    return self.respond(200, manager.detail(parts[3]))
            files = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8'), '/style.css': ('style.css', 'text/css; charset=utf-8')}
            if path in files:
                file, mime = files[path]
                return self.respond(200, (STATIC / file).read_bytes(), mime)
            self.respond(404, {'error': '不存在的入口'})
        except KeyError:
            self.respond(404, {'error': '测试记录不存在'})

    def do_POST(self):
        if not self.host_ok() or self.headers.get('Origin') != 'http://' + self.headers.get('Host', '') or self.headers.get('X-Console-Token') != self.server.token:
            return self.respond(403, {'error': '操作来源无效，请刷新页面'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 8192 or self.headers.get('Content-Type') != 'application/json':
                raise ValueError('请求格式无效')
            data = json.loads(self.rfile.read(length))
            path = urlparse(self.path).path
            if path == '/api/runs':
                return self.respond(201, self.server.manager.start(data))
            parts = path.split('/')
            if len(parts) == 5 and parts[1:3] == ['api', 'runs'] and parts[4] == 'stop':
                self.server.manager.stop(parts[3])
                return self.respond(200, {'ok': True})
            self.respond(404, {'error': '不存在的入口'})
        except (ValueError, TypeError) as error:
            self.respond(400, {'error': str(error)})
        except RuntimeError as error:
            self.respond(409, {'error': str(error)})
        except KeyError:
            self.respond(404, {'error': '测试记录不存在'})


def make_server(manager, port):
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.manager, server.token = manager, secrets.token_urlsafe(32)
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=47840)
    parser.add_argument('--data-dir', type=Path, default=Path(__file__).parent / 'data')
    args = parser.parse_args()
    target = os.getenv('OPENCLAWX_TEST_TARGET', 'http://127.0.0.1:47832/api').rstrip('/')
    benchmark = os.getenv('OPENCLAWX_BENCHMARK_URL', 'http://127.0.0.1:47840/')
    for url in (target, benchmark):
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            parser.error('目标地址必须为无凭据的 HTTP(S) URL')
    if urlparse(target).hostname not in ('localhost', '127.0.0.1', '::1') and urlparse(target).scheme != 'https':
        parser.error('远端测试目标必须使用 HTTPS')
    # Bind first: a second launch must not modify the active server database.
    server = make_server(None, args.port)
    args.data_dir.mkdir(parents=True, exist_ok=True)
    data_lock = (args.data_dir / 'console.lock').open('a')
    try:
        fcntl.flock(data_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        server.server_close()
        parser.error('此数据目录已有控制台使用，请连接现有服务')
    server.manager = Manager(args.data_dir.resolve(), target, benchmark)
    def shutdown(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, shutdown)
    print(f'Test console: http://127.0.0.1:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('Stopping tests and waiting for in-flight operations…', flush=True)
    finally:
        server.server_close()
        server.manager.close()
        data_lock.close()


if __name__ == '__main__':
    main()
