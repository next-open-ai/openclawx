import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function defaultDataDir() {
  return process.env.OPENCLAWX_DATA_DIR || path.join(os.homedir(), '.openclawx');
}

export function runtimeSourceRoot(projectRoot) {
  return path.join(projectRoot, 'runtimes', 'agentscope-runtime');
}

export function installedRuntimeRoot(dataDir = defaultDataDir()) {
  return path.join(dataDir, 'agentscope-runtime');
}

export function installedRuntimePython(runtimeRoot = installedRuntimeRoot()) {
  const portable = process.platform === 'win32'
    ? path.join(runtimeRoot, 'python', 'python.exe')
    : path.join(runtimeRoot, 'python', 'bin', 'python3');
  if (fs.existsSync(portable)) return portable;
  return process.platform === 'win32'
    ? path.join(runtimeRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(runtimeRoot, '.venv', 'bin', 'python3');
}

function readPythonVersion(command) {
  const args = command === 'py'
    ? ['-3', '-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}")']
    : ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}")'];
  const result = spawnSync(command, args, { encoding: 'utf8', env: process.env });
  if (result.status !== 0) return null;
  const match = `${result.stdout || ''}${result.stderr || ''}`.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

function isSupportedPython(version) {
  return Boolean(version && version.major === 3 && version.minor >= 10);
}

export function resolveBasePython() {
  if (process.env.OPENCLAWX_AGENTSCOPE_PYTHON?.trim()) {
    const forced = process.env.OPENCLAWX_AGENTSCOPE_PYTHON.trim();
    const version = readPythonVersion(forced);
    return isSupportedPython(version) ? forced : null;
  }
  const candidates = process.platform === 'win32'
    ? ['py', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python', 'python3']
    : ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'];
  for (const command of candidates) {
    const version = readPythonVersion(command);
    if (isSupportedPython(version)) return command;
  }
  return null;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw new Error(`Command failed: ${command} ${args.join(' ')}`);
}

function copyRuntimeScaffold(projectRoot, targetRoot) {
  const sourceRoot = runtimeSourceRoot(projectRoot);
  if (!fs.existsSync(sourceRoot)) throw new Error(`Missing AgentScope runtime source: ${sourceRoot}`);
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  for (const entry of ['src', 'requirements.txt', 'pyproject.toml']) {
    const source = path.join(sourceRoot, entry);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(targetRoot, entry), { recursive: true, force: true });
  }
}

export function detectAgentscopeRuntime(projectRoot, dataDir = defaultDataDir()) {
  const runtimeRoot = installedRuntimeRoot(dataDir);
  const python = installedRuntimePython(runtimeRoot);
  const sourceRoot = runtimeSourceRoot(projectRoot);
  const pythonVersion = fs.existsSync(python) ? readPythonVersion(python) : null;
  return {
    dataDir,
    sourceRoot,
    runtimeRoot,
    python,
    hasSource: fs.existsSync(sourceRoot),
    hasRuntime: fs.existsSync(runtimeRoot),
    hasPython: fs.existsSync(python),
    pythonVersion,
    basePython: resolveBasePython(),
  };
}

/**
 * Prefer a project-bundled runtime (Docker / packaged installs) when it already
 * ships a usable portable Python. This keeps volume mounts over OPENCLAWX_DATA_DIR from
 * wiping the baked AgentScope environment.
 */
export function resolveBundledAgentscopeRuntime(projectRoot) {
  const runtimeRoot = runtimeSourceRoot(projectRoot);
  const python = installedRuntimePython(runtimeRoot);
  const pythonVersion = fs.existsSync(python) ? readPythonVersion(python) : null;
  if (!fs.existsSync(python) || !isSupportedPython(pythonVersion)) return null;
  return { runtimeRoot, python, pythonVersion };
}

export function ensureAgentscopeRuntime(projectRoot, options = {}) {
  const dataDir = options.dataDir || defaultDataDir();
  const bundled = !options.reinstall ? resolveBundledAgentscopeRuntime(projectRoot) : null;
  if (bundled) {
    return {
      dataDir,
      runtimeRoot: bundled.runtimeRoot,
      python: bundled.python,
      basePython: resolveBasePython() || bundled.python,
    };
  }

  const runtimeRoot = installedRuntimeRoot(dataDir);
  const python = installedRuntimePython(runtimeRoot);
  copyRuntimeScaffold(projectRoot, runtimeRoot);
  const basePython = resolveBasePython();
  if (!basePython) throw new Error('No usable Python 3 interpreter found. Install Python 3.10+ first.');
  const existingVersion = fs.existsSync(python) ? readPythonVersion(python) : null;
  if (fs.existsSync(python) && !isSupportedPython(existingVersion)) {
    fs.rmSync(path.join(runtimeRoot, '.venv'), { recursive: true, force: true });
  }
  if (!fs.existsSync(python)) {
    const args = basePython === 'py' ? ['-3', '-m', 'venv', '--copies', path.join(runtimeRoot, '.venv')] : ['-m', 'venv', '--copies', path.join(runtimeRoot, '.venv')];
    run(basePython, args, runtimeRoot);
    run(python, ['-m', 'pip', 'install', '--upgrade', 'pip'], runtimeRoot);
    run(python, ['-m', 'pip', 'install', '-r', path.join(runtimeRoot, 'requirements.txt')], runtimeRoot);
  } else if (options.reinstall) {
    run(python, ['-m', 'pip', 'install', '--upgrade', 'pip'], runtimeRoot);
    run(python, ['-m', 'pip', 'install', '-r', path.join(runtimeRoot, 'requirements.txt')], runtimeRoot);
  }
  return { dataDir, runtimeRoot, python, basePython };
}
