#!/usr/bin/env python3
"""Preview or execute OpenClawX's bounded concurrency regression."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]

def iso():
    return datetime.now(timezone.utc).isoformat()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', required=True)
    parser.add_argument('--scenario', choices=('dispatcher', 'runtime', 'durable'), default='dispatcher')
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    plan = {'scenario': args.scenario, 'target': args.target, 'live': args.live}
    print(json.dumps({'plan': plan}, ensure_ascii=False, indent=2), flush=True)
    if not args.live:
        return
    commands = {
        'dispatcher': ['pnpm', 'concurrency:regression'],
        'runtime': ['pnpm', 'concurrency:loadtest'],
        'durable': ['pnpm', 'durable-task:regression'],
    }
    env = {**os.environ, 'OPENCLAWX_LOADTEST_BASE_URL': args.target}
    code = subprocess.call(commands[args.scenario], cwd=ROOT, env=env)
    report = {'version': 1, 'kind': 'load', 'scenario': args.scenario, 'startedAt': iso(),
              'finishedAt': iso(), 'passed': code == 0, 'stages': []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(code)

if __name__ == '__main__':
    main()
