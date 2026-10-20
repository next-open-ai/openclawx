import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type PythonVersion = { major: number; minor: number; patch: number };

export type PythonCandidate = {
  command: string;
  version: PythonVersion;
};

export type ScriptPythonSource = 'override' | 'system' | 'bundled' | 'none';

export type ScriptPythonDecision = {
  source: ScriptPythonSource;
  /** Executable or launcher used for Agent-authored scripts (`python3` / absolute path / `py`). */
  command: string | null;
  version: PythonVersion | null;
  reason: string;
  isolationNote: string;
  system: PythonCandidate | null;
  bundled: PythonCandidate | null;
};

/** Minimum Python for Agent workspace / skill scripts. */
export const SCRIPT_PYTHON_MIN_MINOR = 9;

export const SCRIPT_PYTHON_ISOLATION_NOTE =
  'Agent 自编脚本的依赖只安装到运行工作区 `.python-packages`（`pip install --target`），不会写入 agentscope-runtime 或系统 site-packages。';

function execCapture(command: string, args: string[], timeoutMs = 8_000) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, env: process.env });
    return {
      code: result.status ?? 1,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim(),
    };
  } catch {
    return null;
  }
}

export function parsePythonVersion(text: string): PythonVersion | null {
  const match = String(text).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: match[3] ? Number(match[3]) : 0 };
}

export function meetsScriptPythonMin(version: PythonVersion | null | undefined): boolean {
  return Boolean(version && version.major === 3 && version.minor >= SCRIPT_PYTHON_MIN_MINOR);
}

export function formatPythonVersion(version: PythonVersion | null | undefined): string {
  if (!version) return '';
  return `v${version.major}.${version.minor}.${version.patch}`;
}

/** Build argv for running a Python module/script; handles Windows `py -3`. */
export function pythonArgv(command: string, rest: string[]): { command: string; args: string[] } {
  if (command === 'py') return { command: 'py', args: ['-3', ...rest] };
  return { command, args: rest };
}

function readVersionForCommand(command: string): PythonVersion | null {
  const probe = pythonArgv(command, ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}")']);
  const result = execCapture(probe.command, probe.args, 8_000);
  if (!result || result.code !== 0) return null;
  return parsePythonVersion(`${result.stdout} ${result.stderr}`);
}

export function detectSystemPython(): PythonCandidate | null {
  const candidates = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const command of candidates) {
    const version = readVersionForCommand(command);
    if (version) return { command, version };
  }
  return null;
}

function bundledPythonCandidates(agentscopeRoot?: string): string[] {
  const roots: string[] = [];
  const fromEnv = process.env.OPENCLAWX_AGENTSCOPE_ROOT?.trim();
  if (fromEnv) roots.push(fromEnv);
  if (agentscopeRoot?.trim()) roots.push(agentscopeRoot.trim());
  roots.push(path.resolve(process.cwd(), 'runtimes', 'agentscope-runtime'));

  const override = process.env.OPENCLAWX_AGENTSCOPE_PYTHON?.trim();
  const out: string[] = [];
  if (override) out.push(override);

  for (const root of roots) {
    if (process.platform === 'win32') {
      out.push(path.join(root, '.venv', 'Scripts', 'python.exe'));
      out.push(path.join(root, 'python', 'python.exe'));
    } else {
      out.push(path.join(root, '.venv', 'bin', 'python3'));
      out.push(path.join(root, '.venv', 'bin', 'python'));
      out.push(path.join(root, 'python', 'bin', 'python3'));
    }
  }
  return [...new Set(out)];
}

export function detectBundledPython(agentscopeRoot?: string): PythonCandidate | null {
  for (const candidate of bundledPythonCandidates(agentscopeRoot)) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const version = readVersionForCommand(candidate);
    if (version) return { command: candidate, version };
  }
  return null;
}

function probePip(command: string): boolean {
  const { command: cmd, args } = pythonArgv(command, ['-m', 'pip', '--version']);
  const result = execCapture(cmd, args, 8_000);
  return Boolean(result && result.code === 0);
}

/**
 * Decide which Python runs Agent-authored scripts.
 * Priority: OPENCLAWX_PYTHON → system 3.9+ → bundled agentscope runtime → none.
 * Never install script deps into agentscope-runtime (callers must use --target + PYTHONPATH).
 */
export function resolveScriptPython(options?: { agentscopeRoot?: string }): ScriptPythonDecision {
  const system = detectSystemPython();
  const bundled = detectBundledPython(options?.agentscopeRoot);
  const isolationNote = SCRIPT_PYTHON_ISOLATION_NOTE;

  const override = process.env.OPENCLAWX_PYTHON?.trim();
  if (override) {
    const version = readVersionForCommand(override);
    if (version) {
      return {
        source: 'override',
        command: override,
        version,
        reason: `使用环境变量 OPENCLAWX_PYTHON=${override}（显式覆盖）。`,
        isolationNote,
        system,
        bundled,
      };
    }
  }

  if (system && meetsScriptPythonMin(system.version)) {
    return {
      source: 'system',
      command: system.command,
      version: system.version,
      reason: `系统 Python 满足最低要求 3.${SCRIPT_PYTHON_MIN_MINOR}+，Agent 自编脚本使用系统解释器：${system.command} ${formatPythonVersion(system.version)}。`,
      isolationNote,
      system,
      bundled,
    };
  }

  if (bundled && meetsScriptPythonMin(bundled.version)) {
    const systemNote = system
      ? `系统 Python ${formatPythonVersion(system.version)} 低于 3.${SCRIPT_PYTHON_MIN_MINOR} 或不满足要求`
      : '系统未检测到可用的 Python 3';
    return {
      source: 'bundled',
      command: bundled.command,
      version: bundled.version,
      reason: `${systemNote}；回退使用预装 agentscope-runtime：${bundled.command} ${formatPythonVersion(bundled.version)}。`,
      isolationNote,
      system,
      bundled,
    };
  }

  return {
    source: 'none',
    command: null,
    version: null,
    reason: system
      ? `系统 Python ${formatPythonVersion(system.version)} 过低，且未找到可用的预装 runtime（需 3.${SCRIPT_PYTHON_MIN_MINOR}+）。`
      : `系统无 Python，且未找到可用的预装 agentscope-runtime（需 3.${SCRIPT_PYTHON_MIN_MINOR}+）。`,
    isolationNote,
    system,
    bundled,
  };
}

/** Executable string for script/pip invocation; throws if none available. */
export function resolveOpenClawXPython(options?: { agentscopeRoot?: string }): string {
  const decision = resolveScriptPython(options);
  if (!decision.command) {
    throw new Error(decision.reason || 'No usable Python for Agent scripts.');
  }
  return decision.command;
}

export function scriptPythonHasPip(command: string): boolean {
  return probePip(command);
}
