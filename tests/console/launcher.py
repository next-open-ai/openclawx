#!/usr/bin/env python3
"""Lifecycle launcher for the local OpenClawX test console."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen
import webbrowser

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PORT = int(os.getenv('TEST_CONSOLE_PORT', '47840'))
DATA = Path(os.getenv('TEST_CONSOLE_DATA_DIR', str(HERE / 'data'))).expanduser().resolve()
PYTHON = os.getenv('TEST_CONSOLE_PYTHON', sys.executable)
URL = f'http://127.0.0.1:{PORT}'
PID_FILE = DATA / 'test-console.pid'
LOG_FILE = DATA / 'test-console.log'


def health():
    try:
        with urlopen(URL + '/api/health', timeout=.8) as response:
            body = json.load(response)
        return body if response.status == 200 and body.get('service') == 'openclawx-test-console' else None
    except (OSError, URLError, ValueError):
        return None


def saved_pid():
    try:
        value = int(PID_FILE.read_text().strip())
        if value <= 0:
            raise ValueError
        os.kill(value, 0)
        return value
    except (OSError, ValueError):
        PID_FILE.unlink(missing_ok=True)
        return None


def wait_ready(seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = health()
        if result:
            return result
        time.sleep(.25)
    return None


def start():
    current = health()
    if current:
        print(f'✓ 测试控制台已在运行：{URL}')
        if not saved_pid():
            print('  当前进程不是由快捷脚本启动，stop 不会终止它。')
        return 0
    DATA.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open('a') as log:
        log.write(f'\n[launcher] {time.strftime("%Y-%m-%dT%H:%M:%S%z")} starting test console\n')
        log.flush()
        process = subprocess.Popen(
            [PYTHON, str(HERE / 'server.py'), '--port', str(PORT), '--data-dir', str(DATA)],
            cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=True, env=os.environ.copy())
    PID_FILE.write_text(f'{process.pid}\n')
    if not wait_ready():
        print(f'✗ 启动失败，请执行 ./tests/test-console logs 查看 {LOG_FILE}', file=sys.stderr)
        return 1
    print(f'✓ 测试控制台启动成功：{URL}')
    print(f'  PID {process.pid} · 日志 {LOG_FILE}')
    return 0


def stop():
    pid = saved_pid()
    if not pid:
        if health():
            print(f'! 控制台正在运行，但不是由快捷脚本启动；监听地址：{URL}')
            return 1
        print('✓ 测试控制台未运行')
        return 0
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        PID_FILE.unlink(missing_ok=True)
        return 0
    for _ in range(300):
        if not health():
            PID_FILE.unlink(missing_ok=True)
            print('✓ 测试控制台已停止')
            return 0
        time.sleep(.1)
    print('! 控制台仍在等待测试请求收尾；未强制终止。稍后执行 status 或 stop。', file=sys.stderr)
    return 1


def status():
    value = health()
    if not value:
        print(f'✗ 测试控制台未运行（{URL}）', file=sys.stderr)
        return 1
    active = f" · 执行中 {value['activeRunId'][:12]}" if value.get('activeRunId') else ' · 当前空闲'
    owner = f' · PID {saved_pid()}' if saved_pid() else ' · 非快捷脚本进程'
    print(f'✓ 运行中：{URL}')
    print(f'  Python 测试服务 v{value.get("version", 1)}{active}{owner}')
    return 0


def logs():
    DATA.mkdir(parents=True, exist_ok=True)
    LOG_FILE.touch()
    try:
        return subprocess.call(['tail', '-n', '100', '-f', str(LOG_FILE)])
    except FileNotFoundError:
        print(f'日志文件：{LOG_FILE}')
        return 1


def foreground():
    DATA.mkdir(parents=True, exist_ok=True)
    return subprocess.call([PYTHON, str(HERE / 'server.py'), '--port', str(PORT), '--data-dir', str(DATA)], cwd=ROOT)


def help_text():
    print('''OpenClawX 统一测试控制台快捷命令

  ./tests/test-console start     后台启动（默认）
  ./tests/test-console open      启动并打开浏览器
  ./tests/test-console status    查看运行状态和当前任务
  ./tests/test-console stop      安全停止后台服务
  ./tests/test-console restart   重启后台服务
  ./tests/test-console logs      持续查看服务日志（Ctrl+C 退出）
  ./tests/test-console run       前台运行
  ./tests/test-console help      查看帮助

环境变量：TEST_CONSOLE_PORT、TEST_CONSOLE_DATA_DIR、TEST_CONSOLE_PYTHON、
OPENCLAWX_TEST_TARGET、OPENCLAWX_BENCHMARK_URL''')


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('command', nargs='?', default='start')
    command = parser.parse_args().command
    if command == 'start':
        return start()
    if command == 'open':
        result = start()
        if result == 0 and health() and not webbrowser.open(URL):
            print(f'! 无法自动打开浏览器，请访问 {URL}')
        return result
    if command == 'status':
        return status()
    if command == 'stop':
        return stop()
    if command == 'restart':
        stopped = stop()
        return start() if stopped == 0 else stopped
    if command == 'logs':
        return logs()
    if command == 'run':
        return foreground()
    if command in ('help', '--help', '-h'):
        help_text()
        return 0
    print(f'✗ 未知命令：{command}', file=sys.stderr)
    help_text()
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
