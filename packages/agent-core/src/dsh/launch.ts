import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dshRuntimeRoot, probeDshRuntime, resolveDshJsonrpcBin } from './runtime-install.js';
import { resolveAgentWorkspaceRoot } from '../workspace-mode.js';

export type DshLaunchSpec = {
  command: string;
  args: string[];
  /** Absolute path to cordis.yml (passed as argv and/or DSH_CORDIS_CONFIG). */
  cordisConfig: string;
  /** Working directory for the runtime process (plugin resolution). */
  spawnCwd?: string;
  /** Hint for diagnostics. */
  source: string;
};

function exists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function isHarnessRoot(dir: string): boolean {
  return exists(path.join(dir, 'pnpm-workspace.yaml'))
    && (
      exists(path.join(dir, 'packages/examples/jsonrpc-demo'))
      || exists(path.join(dir, 'examples/jsonrpc-agent'))
    );
}

/**
 * Walk ancestors of `start` looking for a sibling `deepseek-harness` checkout.
 * Works from agent-core source, agent-core dist, bundled api/dist, and
 * Electron cwd (`apps/desktop`).
 */
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

function moduleDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

function siblingHarnessRoot(): string | null {
  const fromEnv = process.env.OPENCLAWX_DSH_ROOT?.trim();
  if (fromEnv && isHarnessRoot(fromEnv)) return path.resolve(fromEnv);
  if (fromEnv && exists(fromEnv)) return path.resolve(fromEnv);

  return findSiblingHarness(moduleDir())
    || findSiblingHarness(process.cwd())
    || null;
}

function resolveCordis(harnessRoot: string | null): string | null {
  const fromEnv = process.env.OPENCLAWX_DSH_CORDIS?.trim();
  if (fromEnv && exists(fromEnv)) return path.resolve(fromEnv);
  if (!harnessRoot) return null;
  const example = path.join(harnessRoot, 'examples/jsonrpc-agent/cordis.yml');
  if (exists(example)) return example;
  return null;
}

function resolveBin(harnessRoot: string | null): {
  command: string;
  args: string[];
  source: string;
  spawnCwd?: string;
} | null {
  const binEnv = process.env.OPENCLAWX_DSH_BIN?.trim();
  if (binEnv) {
    const extra = String(process.env.OPENCLAWX_DSH_ARGS || '')
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
    return {
      command: binEnv,
      args: extra,
      source: 'OPENCLAWX_DSH_BIN',
      spawnCwd: process.env.OPENCLAWX_DSH_ROOT?.trim() || harnessRoot || undefined,
    };
  }

  // Prefer on-demand install under ~/.openclawx/dsh-runtime (release path).
  const userRoot = dshRuntimeRoot();
  const userBin = resolveDshJsonrpcBin(userRoot);
  if (userBin) {
    if (userBin.endsWith('.js')) {
      return {
        command: process.execPath,
        args: [userBin],
        source: `user-runtime:${userBin}`,
        spawnCwd: userRoot,
      };
    }
    return {
      command: userBin,
      args: [],
      source: `user-runtime:${userBin}`,
      spawnCwd: userRoot,
    };
  }

  // Prefer a globally / locally installed dsh-jsonrpc-agent if present.
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin');
    if (resolved) {
      return {
        command: process.execPath,
        args: [resolved],
        source: 'node_modules',
        spawnCwd: path.dirname(path.dirname(path.dirname(resolved))),
      };
    }
  } catch {
    /* not installed in openclawx */
  }

  if (harnessRoot) {
    const built = path.join(harnessRoot, 'packages/examples/jsonrpc-demo/lib/bin.js');
    if (exists(built)) {
      return {
        command: process.execPath,
        args: [built],
        source: `sibling:${built}`,
        spawnCwd: harnessRoot,
      };
    }
    const srcBin = path.join(harnessRoot, 'packages/examples/jsonrpc-demo/src/bin.ts');
    const tsxCandidates = [
      path.join(harnessRoot, 'node_modules/.bin/tsx'),
      path.join(harnessRoot, 'node_modules/tsx/dist/cli.mjs'),
    ];
    const tsxBin = tsxCandidates.find((item) => exists(item));
    if (exists(srcBin) && tsxBin) {
      if (tsxBin.endsWith('.mjs') || tsxBin.endsWith('.js')) {
        return {
          command: process.execPath,
          args: [tsxBin, srcBin],
          source: `sibling-tsx:${srcBin}`,
          spawnCwd: harnessRoot,
        };
      }
      return {
        command: tsxBin,
        args: [srcBin],
        source: `sibling-tsx:${srcBin}`,
        spawnCwd: harnessRoot,
      };
    }
  }

  return null;
}

/**
 * Resolve how to spawn the DeepSeek Harness JSON-RPC runtime.
 * @param options.cordisConfig — absolute cordis.yml (OpenClawX-generated or override).
 */
export function resolveDshLaunch(options?: { cordisConfig?: string }): DshLaunchSpec {
  const harnessRoot = siblingHarnessRoot();
  const cordisConfig = (() => {
    const fromOpt = options?.cordisConfig?.trim();
    if (fromOpt) {
      const resolved = path.resolve(fromOpt);
      if (!exists(resolved)) {
        throw new Error(`DeepSeek Harness cordis config not found: ${resolved}`);
      }
      return resolved;
    }
    return resolveCordis(harnessRoot);
  })();
  const bin = resolveBin(harnessRoot);

  if (!bin) {
    const probe = probeDshRuntime({ moduleDir: moduleDir() });
    throw new Error(
      'DeepSeek Harness runtime not found. '
      + 'Open 环境检查 and run「安装 dsh 编码引擎」, or set OPENCLAWX_DSH_BIN. '
      + `Expected user runtime at ${dshRuntimeRoot()}. `
      + `(${probe.detail}; looked relative to ${moduleDir()} and cwd ${process.cwd()}).`,
    );
  }
  if (!cordisConfig) {
    throw new Error(
      'DeepSeek Harness cordis config missing. OpenClawX normally generates one per run; '
      + 'or set OPENCLAWX_DSH_CORDIS to an absolute cordis.yml path.',
    );
  }

  return {
    command: bin.command,
    args: [...bin.args, cordisConfig],
    cordisConfig,
    spawnCwd: bin.spawnCwd ?? harnessRoot ?? path.dirname(cordisConfig),
    source: bin.source,
  };
}

export function resolveDshWorkspace(input: {
  runId?: string;
  projectWorkspacePath?: string;
}): string {
  return resolveAgentWorkspaceRoot({
    runId: input.runId || 'dsh-run',
    projectWorkspacePath: input.projectWorkspacePath,
  });
}
