import { existsSync, lstatSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(projectRoot, 'runtimes', 'agentscope-runtime');
const pythonRoot = path.join(runtimeRoot, 'python');
const installRoot = path.join(runtimeRoot, '.python-install');
const isWin = process.platform === 'win32';
const uv = process.env.OPENCLAWX_UV?.trim() || 'uv';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: runtimeRoot, stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw new Error(`Command failed: ${command} ${args.join(' ')}`);
}

function portablePython() {
  return isWin ? path.join(pythonRoot, 'python.exe') : path.join(pythonRoot, 'bin', 'python3');
}

function pruneRuntime(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    const target = path.join(directory, entry);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (entry === '__pycache__' || entry === '.pytest_cache' || entry === '.mypy_cache' || entry === 'tests' || entry === 'test') {
        rmSync(target, { recursive: true, force: true });
      } else {
        pruneRuntime(target);
      }
    } else if (entry.endsWith('.pyc') || entry.endsWith('.pyo')) {
      rmSync(target, { force: true });
    }
  }
}

const uvProbe = spawnSync(uv, ['--version'], { encoding: 'utf8', env: process.env });
if (uvProbe.status !== 0) {
  throw new Error('uv is required to package the portable Python runtime. Install uv or run the release workflow with astral-sh/setup-uv.');
}

rmSync(pythonRoot, { recursive: true, force: true });
rmSync(installRoot, { recursive: true, force: true });
console.log('[agentscope-runtime] installing relocatable CPython 3.11 with uv');
run(uv, ['python', 'install', '3.11', '--install-dir', installRoot, '--no-bin', '--no-registry']);
const installation = readdirSync(installRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith('cpython-3.11.'))
  .map((entry) => path.join(installRoot, entry.name))
  .find((entry) => existsSync(isWin ? path.join(entry, 'python.exe') : path.join(entry, 'bin', 'python3')));
if (!installation) throw new Error(`uv did not produce a portable CPython installation under ${installRoot}`);
renameSync(installation, pythonRoot);
rmSync(installRoot, { recursive: true, force: true });
const python = portablePython();
console.log(`[agentscope-runtime] installing requirements into ${pythonRoot}`);
// This is a disposable application-owned copy of uv's distribution. PEP 668
// protects the shared uv installation, but modifying this copied runtime is the
// intended packaging operation.
run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--break-system-packages', '-r', path.join(runtimeRoot, 'requirements.txt')]);
const verify = spawnSync(python, ['-c', 'import agentscope, pypdf; print("portable-runtime-ok")'], { cwd: runtimeRoot, encoding: 'utf8', env: process.env });
if (verify.status !== 0) throw new Error(`Portable runtime verification failed: ${verify.stderr || verify.stdout}`);
// Development headers, bundled bootstrapping wheels and GUI/documentation
// modules are unnecessary in the desktop runtime. pip itself remains available
// for isolated optional-component installs.
for (const relative of [
  'include', 'share',
  'lib/python3.11/ensurepip', 'lib/python3.11/idlelib',
  'lib/python3.11/lib2to3', 'lib/python3.11/pydoc_data',
  'lib/python3.11/tkinter', 'lib/python3.11/turtledemo',
]) rmSync(path.join(pythonRoot, relative), { recursive: true, force: true });
pruneRuntime(pythonRoot);
console.log(`[agentscope-runtime] ready: ${python}`);
