import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/** Pinned npm dist-tag/version for on-demand desktop installs. Override with OPENCLAWX_DSH_NPM_VERSION. */
export const DSH_RUNTIME_NPM_VERSION = process.env.OPENCLAWX_DSH_NPM_VERSION?.trim() || '0.1.1-rc.2';

const READY_MARKER = '.openclawx-dsh-ready.json';

/** Packages required by OpenClawX-generated cordis + JSON-RPC bin. */
export const DSH_RUNTIME_PACKAGES = [
  '@deepseek-ai/dsh-sdk-jsonrpc-demo',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-agent-spine-demo',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-checkpoint-policy',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-fs-observation-policy',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-compaction-basic',
] as const;

export type DshRuntimeStatus = {
  ok: boolean;
  root: string;
  bin: string | null;
  version: string | null;
  source: 'user-runtime' | 'env-bin' | 'node_modules' | 'sibling' | 'missing';
  detail: string;
};

function openclawxDataDir(): string {
  return process.env.OPENCLAWX_DATA_DIR?.trim()
    || path.join(os.homedir(), '.openclawx');
}

export function dshRuntimeRoot(dataDir = openclawxDataDir()): string {
  return path.join(dataDir, 'dsh-runtime');
}

function exists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

export function resolveDshJsonrpcBin(runtimeRoot: string): string | null {
  const candidates = [
    path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-demo', 'lib', 'bin.js'),
    path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-demo', 'lib', 'packaged-bin.js'),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  const shim = process.platform === 'win32'
    ? path.join(runtimeRoot, 'node_modules', '.bin', 'dsh-jsonrpc-agent.cmd')
    : path.join(runtimeRoot, 'node_modules', '.bin', 'dsh-jsonrpc-agent');
  if (exists(shim)) return shim;
  return null;
}

function readReadyMarker(runtimeRoot: string): { version: string; installedAt: string } | null {
  const file = path.join(runtimeRoot, READY_MARKER);
  if (!exists(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string; installedAt?: string };
    if (!raw.version) return null;
    return { version: String(raw.version), installedAt: String(raw.installedAt || '') };
  } catch {
    return null;
  }
}

function writeReadyMarker(runtimeRoot: string, version: string) {
  fs.writeFileSync(
    path.join(runtimeRoot, READY_MARKER),
    `${JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

function isHarnessRoot(dir: string): boolean {
  return exists(path.join(dir, 'pnpm-workspace.yaml'))
    && (
      exists(path.join(dir, 'packages/examples/jsonrpc-demo'))
      || exists(path.join(dir, 'examples/jsonrpc-agent'))
    );
}

function findSiblingHarness(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 10; i += 1) {
    const sibling = path.resolve(dir, '../deepseek-harness');
    if (isHarnessRoot(sibling)) return sibling;
    const nested = path.join(dir, 'deepseek-harness');
    if (isHarnessRoot(nested)) return nested;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Probe whether a usable dsh JSON-RPC runtime is available for OpenClawX.
 * Prefers on-demand user install under ~/.openclawx/dsh-runtime.
 */
export function probeDshRuntime(options?: { moduleDir?: string }): DshRuntimeStatus {
  const root = dshRuntimeRoot();
  const binEnv = process.env.OPENCLAWX_DSH_BIN?.trim();
  if (binEnv) {
    return {
      ok: true,
      root,
      bin: binEnv,
      version: DSH_RUNTIME_NPM_VERSION,
      source: 'env-bin',
      detail: `OPENCLAWX_DSH_BIN=${binEnv}`,
    };
  }

  const userBin = resolveDshJsonrpcBin(root);
  const marker = readReadyMarker(root);
  if (userBin && (marker || exists(path.join(root, 'node_modules', '@deepseek-ai')))) {
    return {
      ok: true,
      root,
      bin: userBin,
      version: marker?.version || DSH_RUNTIME_NPM_VERSION,
      source: 'user-runtime',
      detail: `已安装到 ${root}${marker?.version ? `（${marker.version}）` : ''}`,
    };
  }

  try {
    const require = createRequire(options?.moduleDir || import.meta.url);
    const resolved = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin');
    if (resolved) {
      return {
        ok: true,
        root: path.dirname(path.dirname(resolved)),
        bin: resolved,
        version: DSH_RUNTIME_NPM_VERSION,
        source: 'node_modules',
        detail: `node_modules: ${resolved}`,
      };
    }
  } catch {
    /* not in openclawx deps */
  }

  const fromEnvRoot = process.env.OPENCLAWX_DSH_ROOT?.trim();
  if (fromEnvRoot && isHarnessRoot(fromEnvRoot)) {
    const built = path.join(fromEnvRoot, 'packages/examples/jsonrpc-demo/lib/bin.js');
    const src = path.join(fromEnvRoot, 'packages/examples/jsonrpc-demo/src/bin.ts');
    if (exists(built) || exists(src)) {
      return {
        ok: true,
        root: fromEnvRoot,
        bin: exists(built) ? built : src,
        version: null,
        source: 'sibling',
        detail: `OPENCLAWX_DSH_ROOT=${fromEnvRoot}`,
      };
    }
  }

  const sibling = findSiblingHarness(options?.moduleDir || process.cwd());
  if (sibling) {
    const built = path.join(sibling, 'packages/examples/jsonrpc-demo/lib/bin.js');
    const src = path.join(sibling, 'packages/examples/jsonrpc-demo/src/bin.ts');
    return {
      ok: true,
      root: sibling,
      bin: exists(built) ? built : src,
      version: null,
      source: 'sibling',
      detail: `开发 sibling：${sibling}`,
    };
  }

  return {
    ok: false,
    root,
    bin: null,
    version: null,
    source: 'missing',
    detail: `未安装。可在环境检查中一键安装到 ${root}（需联网，约 200MB）。`,
  };
}

/**
 * GUI / packaged Electron apps often inherit a minimal PATH without nvm / Homebrew.
 * Build a PATH that includes common Node install locations for npm discovery & installs.
 */
export function enrichedProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extras: string[] = [];
  const push = (dir: string) => {
    if (dir && exists(dir) && !extras.includes(dir)) extras.push(dir);
  };

  if (process.platform === 'darwin') {
    push('/opt/homebrew/bin');
    push('/usr/local/bin');
  } else if (process.platform === 'linux') {
    push('/usr/local/bin');
    push('/home/linuxbrew/.linuxbrew/bin');
  }

  push(path.join(home, '.local', 'bin'));
  push(path.join(home, '.volta', 'bin'));
  push(path.join(home, '.fnm', 'current', 'bin'));
  push(path.join(home, '.asdf', 'shims'));
  push(path.join(home, '.nodenv', 'shims'));

  // Prefer newest nvm Node >= 18 (scan versions dirs).
  const nvmRoot = process.env.NVM_DIR?.trim() || path.join(home, '.nvm');
  const nvmVersions = path.join(nvmRoot, 'versions', 'node');
  if (exists(nvmVersions)) {
    try {
      const versions = fs.readdirSync(nvmVersions)
        .filter((name) => /^v\d+\.\d+\.\d+/.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions.slice(0, 8)) {
        push(path.join(nvmVersions, version, 'bin'));
      }
    } catch {
      /* ignore */
    }
  }

  const sep = path.delimiter;
  const current = base.PATH || base.Path || '';
  const merged = [...extras, ...current.split(sep).filter(Boolean)].join(sep);
  return { ...base, PATH: merged };
}

function npmCliBesideNode(nodePath: string): string | null {
  const nodeDir = path.dirname(nodePath);
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [
      path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(nodeDir, 'npm.cmd'),
      path.join(nodeDir, 'npm'),
    ]
    : [
      path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(nodeDir, 'npm'),
    ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

function probeNpmBinary(command: string, env: NodeJS.ProcessEnv, isWin: boolean): string | null {
  const probe = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 8_000,
    env,
    shell: isWin,
    windowsHide: true,
  });
  if ((probe.status ?? 1) !== 0) return null;
  return String(probe.stdout || '').trim() || 'ok';
}

function resolveNpmViaLoginShell(env: NodeJS.ProcessEnv): string | null {
  if (process.platform === 'win32') return null;
  const shell = process.env.SHELL?.trim() || (exists('/bin/zsh') ? '/bin/zsh' : '/bin/bash');
  const probe = spawnSync(shell, ['-ilc', 'command -v npm'], {
    encoding: 'utf8',
    timeout: 10_000,
    env,
    windowsHide: true,
  });
  const found = String(probe.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  if ((probe.status ?? 1) === 0 && found && exists(found)) return found;
  return null;
}

function listAbsoluteNpmCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const out: string[] = [];
  const push = (file: string) => {
    if (file && exists(file) && !out.includes(file)) out.push(file);
  };

  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    push(path.join(dir, isWin ? 'npm.cmd' : 'npm'));
  }

  if (!isWin) {
    push('/opt/homebrew/bin/npm');
    push('/usr/local/bin/npm');
    const nvmRoot = process.env.NVM_DIR?.trim() || path.join(home, '.nvm');
    const nvmVersions = path.join(nvmRoot, 'versions', 'node');
    if (exists(nvmVersions)) {
      try {
        const versions = fs.readdirSync(nvmVersions)
          .filter((name) => /^v\d+\.\d+\.\d+/.test(name))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const version of versions.slice(0, 12)) {
          push(path.join(nvmVersions, version, 'bin', 'npm'));
        }
      } catch {
        /* ignore */
      }
    }
  }

  return out;
}

function resolveNpmCommand(): { command: string; argsPrefix: string[]; label: string; env: NodeJS.ProcessEnv } {
  const env = enrichedProcessEnv();
  const fromEnv = process.env.OPENCLAWX_NPM?.trim();
  if (fromEnv) {
    return { command: fromEnv, argsPrefix: [], label: fromEnv, env };
  }

  const isWin = process.platform === 'win32';
  const pathCandidates = isWin ? ['npm.cmd', 'npm'] : ['npm'];
  for (const command of pathCandidates) {
    const version = probeNpmBinary(command, env, isWin);
    if (version) {
      return { command, argsPrefix: [], label: `${command} ${version}`, env };
    }
  }

  for (const absolute of listAbsoluteNpmCandidates(env)) {
    const version = probeNpmBinary(absolute, env, isWin);
    if (version) {
      return { command: absolute, argsPrefix: [], label: `${absolute} ${version}`, env };
    }
  }

  const viaShell = resolveNpmViaLoginShell(env);
  if (viaShell) {
    const version = probeNpmBinary(viaShell, env, false);
    if (version) {
      return { command: viaShell, argsPrefix: [], label: `${viaShell} ${version}`, env };
    }
  }

  // Resolve a real Node binary, then npm-cli.js beside it.
  // Prefer filesystem/PATH node — not Electron's process.execPath.
  const nodeCandidates = [
    ...String(env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, isWin ? 'node.exe' : 'node')),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ].filter((file, index, all) => file && exists(file) && all.indexOf(file) === index);

  for (const nodePath of nodeCandidates) {
    const npmPath = npmCliBesideNode(nodePath);
    if (!npmPath) continue;
    if (npmPath.endsWith('npm-cli.js')) {
      return {
        command: nodePath,
        argsPrefix: [npmPath],
        label: `${nodePath} + ${npmPath}`,
        env: { ...env, npm_node_execpath: nodePath },
      };
    }
    const version = probeNpmBinary(npmPath, env, isWin);
    if (version) {
      return { command: npmPath, argsPrefix: [], label: `${npmPath} ${version}`, env };
    }
  }

  // Last resort: Electron-as-Node can sometimes execute npm-cli.js if we find it.
  if (process.env.ELECTRON_RUN_AS_NODE === '1' && process.execPath) {
    for (const nodePath of nodeCandidates) {
      const npmCli = npmCliBesideNode(nodePath);
      if (npmCli?.endsWith('npm-cli.js')) {
        return {
          command: process.execPath,
          argsPrefix: [npmCli],
          label: `electron-as-node + ${npmCli}`,
          env: { ...env, ELECTRON_RUN_AS_NODE: '1', npm_node_execpath: process.execPath },
        };
      }
    }
  }

  throw new Error(
    '未找到 npm，无法按需安装 dsh。请先安装 Node.js（含 npm），或设置 OPENCLAWX_NPM 指向 npm 可执行文件后重试。桌面版已尝试 nvm / Homebrew / 登录 Shell PATH。',
  );
}

function rmrf(target: string) {
  fs.rmSync(target, { recursive: true, force: true });
}

export type DshInstallPhase =
  | 'idle'
  | 'prepare'
  | 'resolve-npm'
  | 'npm-install'
  | 'verify'
  | 'activate'
  | 'done'
  | 'error'
  | 'skipped';

export type DshInstallProgressEvent = {
  type: 'phase' | 'log' | 'done' | 'error';
  phase?: DshInstallPhase;
  message: string;
  percent?: number;
  detail?: string;
  root?: string;
  bin?: string;
  version?: string;
};

export type DshInstallResult = {
  ok: true;
  root: string;
  bin: string;
  version: string;
  detail: string;
  skipped?: boolean;
};

function runNpmInstall(options: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: {
        ...enrichedProcessEnv(options.env || process.env),
        npm_config_fund: 'false',
        npm_config_audit: 'false',
        npm_config_progress: 'true',
        ...(process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrTail = '';
    const pushChunk = (chunk: Buffer | string, stream: 'stdout' | 'stderr') => {
      const text = String(chunk);
      if (stream === 'stderr') {
        stderrTail = `${stderrTail}${text}`.slice(-4000);
      }
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        options.onLog?.(trimmed.slice(0, 300));
      }
    };

    child.stdout?.on('data', (chunk) => pushChunk(chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => pushChunk(chunk, 'stderr'));
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if ((code ?? 1) === 0) resolve();
      else reject(new Error(`npm install 失败（exit ${code ?? 'null'}）：${stderrTail.slice(-1500) || 'unknown error'}`));
    });
  });
}

/**
 * Install OpenClawX's dsh JSON-RPC runtime with progress events.
 * Atomic: installs into a temp directory then renames into place.
 */
export async function ensureDshRuntimeInstalledWithProgress(options?: {
  reinstall?: boolean;
  version?: string;
  onProgress?: (event: DshInstallProgressEvent) => void;
}): Promise<DshInstallResult> {
  const emit = (event: DshInstallProgressEvent) => {
    try {
      options?.onProgress?.(event);
    } catch {
      /* ignore UI callback errors */
    }
  };

  const version = options?.version?.trim() || DSH_RUNTIME_NPM_VERSION;
  const finalRoot = dshRuntimeRoot();
  const existing = probeDshRuntime();

  if (!options?.reinstall && existing.ok && existing.bin) {
    const result = {
      ok: true as const,
      root: existing.root,
      bin: existing.bin,
      version: existing.version || version,
      detail: `已就绪：${existing.detail}`,
      skipped: true,
    };
    emit({
      type: 'done',
      phase: 'skipped',
      message: result.detail,
      percent: 100,
      root: result.root,
      bin: result.bin,
      version: result.version,
    });
    return result;
  }

  emit({ type: 'phase', phase: 'prepare', message: `准备安装目录 ${finalRoot}`, percent: 6 });
  const staging = `${finalRoot}.installing-${process.pid}`;
  rmrf(staging);
  fs.mkdirSync(path.dirname(finalRoot), { recursive: true, mode: 0o700 });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  emit({ type: 'log', message: `已创建临时目录：${staging}` });

  const packageJson = {
    name: 'openclawx-dsh-runtime',
    private: true,
    version: '0.0.0',
    description: 'On-demand DeepSeek Harness JSON-RPC runtime for OpenClawX',
  };
  fs.writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  emit({ type: 'log', message: '已写入 package.json' });

  emit({ type: 'phase', phase: 'resolve-npm', message: '解析本机 npm…', percent: 12 });
  let npm: { command: string; argsPrefix: string[]; label: string; env: NodeJS.ProcessEnv };
  try {
    npm = resolveNpmCommand();
    emit({ type: 'log', message: `使用 ${npm.label}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', phase: 'error', message, percent: 12 });
    throw error;
  }

  const specs = DSH_RUNTIME_PACKAGES.map((name) => `${name}@${version}`);
  emit({
    type: 'phase',
    phase: 'npm-install',
    message: `正在下载并安装 dsh 依赖（${specs.length} 个包，约 200MB，可能需数分钟）…`,
    percent: 18,
  });
  emit({ type: 'log', message: `npm install ${specs.slice(0, 3).join(' ')} …` });

  try {
    await runNpmInstall({
      command: npm.command,
      args: [
        ...npm.argsPrefix,
        'install',
        ...specs,
        '--omit=dev',
        '--no-fund',
        '--no-audit',
        '--no-package-lock',
      ],
      cwd: staging,
      env: npm.env,
      onLog: (line) => emit({ type: 'log', phase: 'npm-install', message: line, percent: 45 }),
    });
  } catch (error) {
    rmrf(staging);
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', phase: 'error', message: `dsh runtime 安装失败（${npm.label}）：${message}`, percent: 45 });
    throw new Error(`dsh runtime 安装失败（${npm.label}）：${message}`);
  }

  emit({ type: 'phase', phase: 'verify', message: '校验 dsh-jsonrpc-agent…', percent: 82 });
  const bin = resolveDshJsonrpcBin(staging);
  if (!bin) {
    rmrf(staging);
    const message = 'dsh runtime 安装完成但未找到 dsh-jsonrpc-agent（@deepseek-ai/dsh-sdk-jsonrpc-demo）。';
    emit({ type: 'error', phase: 'error', message, percent: 82 });
    throw new Error(message);
  }
  emit({ type: 'log', message: `已找到 bin：${bin}` });
  writeReadyMarker(staging, version);

  emit({ type: 'phase', phase: 'activate', message: '激活用户 runtime 目录…', percent: 90 });
  const backup = `${finalRoot}.bak-${Date.now()}`;
  if (exists(finalRoot)) {
    try {
      fs.renameSync(finalRoot, backup);
    } catch {
      rmrf(finalRoot);
    }
  }
  try {
    fs.renameSync(staging, finalRoot);
  } catch (error) {
    rmrf(staging);
    if (exists(backup)) {
      try { fs.renameSync(backup, finalRoot); } catch { /* ignore */ }
    }
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', phase: 'error', message: `激活失败：${message}`, percent: 90 });
    throw error instanceof Error ? error : new Error(message);
  }
  rmrf(backup);

  const finalBin = resolveDshJsonrpcBin(finalRoot);
  if (!finalBin) {
    const message = `安装后校验失败：${finalRoot} 中找不到 dsh-jsonrpc-agent`;
    emit({ type: 'error', phase: 'error', message, percent: 95 });
    throw new Error(message);
  }

  const result = {
    ok: true as const,
    root: finalRoot,
    bin: finalBin,
    version,
    detail: `已安装到 ${finalRoot}（${version}，${npm.label}）`,
  };
  emit({
    type: 'done',
    phase: 'done',
    message: result.detail,
    percent: 100,
    root: result.root,
    bin: result.bin,
    version: result.version,
  });
  return result;
}

/**
 * Sync wrapper around {@link ensureDshRuntimeInstalledWithProgress}.
 * Prefer the async progress API for UI flows.
 */
export function ensureDshRuntimeInstalled(options?: {
  reinstall?: boolean;
  version?: string;
}): DshInstallResult {
  const existing = probeDshRuntime();
  const version = options?.version?.trim() || DSH_RUNTIME_NPM_VERSION;
  if (!options?.reinstall && existing.ok && existing.bin) {
    return {
      ok: true,
      root: existing.root,
      bin: existing.bin,
      version: existing.version || version,
      detail: `已就绪：${existing.detail}`,
      skipped: true,
    };
  }

  const npm = resolveNpmCommand();
  const finalRoot = dshRuntimeRoot();
  const staging = `${finalRoot}.installing-${process.pid}`;
  rmrf(staging);
  fs.mkdirSync(path.dirname(finalRoot), { recursive: true, mode: 0o700 });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(staging, 'package.json'),
    `${JSON.stringify({
      name: 'openclawx-dsh-runtime',
      private: true,
      version: '0.0.0',
      description: 'On-demand DeepSeek Harness JSON-RPC runtime for OpenClawX',
    }, null, 2)}\n`,
    'utf8',
  );
  const specs = DSH_RUNTIME_PACKAGES.map((name) => `${name}@${version}`);
  const syncResult = spawnSync(npm.command, [
    ...npm.argsPrefix,
    'install',
    ...specs,
    '--omit=dev',
    '--no-fund',
    '--no-audit',
    '--no-package-lock',
  ], {
    cwd: staging,
    encoding: 'utf8',
    timeout: 15 * 60_000,
    env: {
      ...enrichedProcessEnv(npm.env),
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      ...(process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    shell: process.platform === 'win32',
  });
  if ((syncResult.status ?? 1) !== 0) {
    rmrf(staging);
    throw new Error(`dsh runtime 安装失败（${npm.label}）：${String(syncResult.stderr || syncResult.stdout || 'unknown error').slice(-2000)}`);
  }
  const bin = resolveDshJsonrpcBin(staging);
  if (!bin) {
    rmrf(staging);
    throw new Error('dsh runtime 安装完成但未找到 dsh-jsonrpc-agent（@deepseek-ai/dsh-sdk-jsonrpc-demo）。');
  }
  writeReadyMarker(staging, version);
  const backup = `${finalRoot}.bak-${Date.now()}`;
  if (exists(finalRoot)) {
    try { fs.renameSync(finalRoot, backup); } catch { rmrf(finalRoot); }
  }
  try {
    fs.renameSync(staging, finalRoot);
  } catch (cause) {
    rmrf(staging);
    if (exists(backup)) {
      try { fs.renameSync(backup, finalRoot); } catch { /* ignore */ }
    }
    throw cause;
  }
  rmrf(backup);
  const finalBin = resolveDshJsonrpcBin(finalRoot);
  if (!finalBin) throw new Error(`安装后校验失败：${finalRoot} 中找不到 dsh-jsonrpc-agent`);
  return {
    ok: true,
    root: finalRoot,
    bin: finalBin,
    version,
    detail: `已安装到 ${finalRoot}（${version}，${npm.label}）`,
  };
}
