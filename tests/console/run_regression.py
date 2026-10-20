#!/usr/bin/env python3
"""Run a fixed OpenClawX regression group and write a machine-readable report."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
GROUPS = {
    'quick': [
        ('API 单元测试', ['pnpm', '--filter', '@openclawx/api', 'test']),
        ('Renderer 类型检查', ['pnpm', '--filter', '@openclawx/renderer', 'typecheck']),
    ],
    'voice': [
        ('语音 API 测试', ['pnpm', '--filter', '@openclawx/api', 'test']),
        ('语音界面回归', ['pnpm', 'voice:ui:regression']),
        ('语音命令回归', ['pnpm', 'voice:command:regression']),
    ],
    'core': [
        ('Contracts 构建', ['pnpm', '--filter', '@openclawx/contracts', 'build']),
        ('Orchestrator 构建', ['pnpm', '--filter', '@openclawx/orchestrator', 'build']),
        ('API 构建', ['pnpm', '--filter', '@openclawx/api', 'build']),
    ],
    'full': [('全仓测试', ['pnpm', 'test']), ('全仓构建', ['pnpm', 'build'])],
}

def iso():
    return datetime.now(timezone.utc).isoformat()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--group', choices=GROUPS, default='quick')
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    started = iso()
    suites = []
    passed = True
    for name, command in GROUPS[args.group]:
        print(f'\n▶ {name}\n$ {" ".join(command)}', flush=True)
        before = time.monotonic()
        code = subprocess.call(command, cwd=ROOT)
        suites.append({'name': name, 'passed': code == 0, 'exitCode': code,
                       'durationSeconds': round(time.monotonic() - before, 2)})
        if code:
            passed = False
            break
    report = {'version': 1, 'kind': 'regression', 'group': args.group, 'startedAt': started,
              'finishedAt': iso(), 'passed': passed, 'suites': suites}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if passed else 1)

if __name__ == '__main__':
    main()
