import {
  DSH_RUNTIME_NPM_VERSION,
  dshRuntimeRoot,
  ensureDshRuntimeInstalled,
  ensureDshRuntimeInstalledWithProgress,
  probeDshRuntime,
  resolveDshJsonrpcBin,
  type DshInstallProgressEvent,
  type DshRuntimeStatus,
} from './runtime-install.js';
import {
  DSH_ENV_CHECK_ID,
  DSH_ENV_FIX_ACTION_ID,
  DSH_ENV_FIX_TIMEOUT_MS,
  buildDshRemediationPlan as buildDshRemediationPlanCopy,
  dshInstallCardCopy,
  isDshEnvCheckId,
  isDshEnvFixAction,
  type DshInstallCardCopy,
  type DshRemediationKind,
  type DshRemediationPlan,
} from './environment-copy.js';

export {
  DSH_ENV_CHECK_ID,
  DSH_ENV_FIX_ACTION_ID,
  DSH_ENV_FIX_TIMEOUT_MS,
  dshInstallCardCopy,
  isDshEnvCheckId,
  isDshEnvFixAction,
};
export type { DshInstallCardCopy, DshRemediationKind, DshRemediationPlan };
export type { DshInstallProgressEvent };

export type DshEnvCheckItem = {
  id: typeof DSH_ENV_CHECK_ID;
  name: string;
  status: 'ok' | 'warn' | 'error';
  required: string;
  found: string;
  command?: string;
  help: string;
};

export type DshEnvFixResult = {
  ok: true;
  message: string;
  detail: string;
  skipped?: boolean;
};

/** Build the environment-check row for dsh (optional coding engine). */
export function buildDshEnvironmentCheck(status?: DshRuntimeStatus): DshEnvCheckItem {
  const dsh = status ?? probeDshRuntime();
  const root = dshRuntimeRoot();
  return {
    id: DSH_ENV_CHECK_ID,
    name: 'dsh 编码引擎（JSON-RPC）',
    status: dsh.ok ? 'ok' : 'warn',
    required: `可选；按需安装到 ${root}（${DSH_RUNTIME_NPM_VERSION}）`,
    found: dsh.detail,
    command: dsh.bin || undefined,
    help: dsh.ok
      ? `编码引擎可用（来源：${dsh.source}）。启用员工引擎 dsh 时将通过 stdio JSON-RPC 调用。`
      : '未安装 dsh runtime。仅在使用「dsh（编码）」引擎时需要；可点一键安装（需联网，约 200MB），或设置 OPENCLAWX_DSH_BIN。',
  };
}

/** Install / reinstall user-local dsh runtime (environment fix action). */
export function runDshEnvironmentFix(options?: { reinstall?: boolean }): DshEnvFixResult {
  const result = ensureDshRuntimeInstalled({ reinstall: options?.reinstall ?? true });
  return {
    ok: true,
    message: result.detail,
    detail: `${result.root}\n${result.bin}`,
    skipped: result.skipped,
  };
}

/** Async install with progress events for SSE / UI. */
export async function runDshEnvironmentFixWithProgress(options?: {
  reinstall?: boolean;
  onProgress?: (event: DshInstallProgressEvent) => void;
}): Promise<DshEnvFixResult> {
  const result = await ensureDshRuntimeInstalledWithProgress({
    reinstall: options?.reinstall ?? true,
    onProgress: options?.onProgress,
  });
  return {
    ok: true,
    message: result.detail,
    detail: `${result.root}\n${result.bin}`,
    skipped: result.skipped,
  };
}

export function buildDshRemediationPlan(kind: DshRemediationKind = {}): DshRemediationPlan {
  return buildDshRemediationPlanCopy(kind, DSH_RUNTIME_NPM_VERSION);
}

/**
 * Resolve preferred OPENCLAWX_DSH_ROOT for desktop/API process env.
 * User on-demand runtime wins over sibling harness checkouts.
 */
export function resolvePreferredDshRoot(options?: {
  dataDir?: string;
  siblingHarnessRoot?: string | null;
}): string {
  const fromEnv = process.env.OPENCLAWX_DSH_ROOT?.trim();
  if (fromEnv) return fromEnv;
  const userRoot = dshRuntimeRoot(options?.dataDir);
  if (resolveDshJsonrpcBin(userRoot)) return userRoot;
  return String(options?.siblingHarnessRoot || '').trim();
}
