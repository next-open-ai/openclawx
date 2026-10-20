/**
 * Pure dsh environment/UI copy (no Node APIs).
 * Used by server `environment.ts` and mirrored for the renderer adapter.
 */

export const DSH_ENV_CHECK_ID = 'dsh-runtime' as const;
export const DSH_ENV_FIX_ACTION_ID = 'fix-dsh' as const;
export const DSH_ENV_FIX_TIMEOUT_MS = 20 * 60_000;

export type DshRemediationKind = {
  docker?: boolean;
  os?: 'macos' | 'windows' | 'linux' | 'unknown';
};

export type DshRemediationPlan = {
  summary: string;
  steps: string[];
  script?: string;
  logic?: string[];
  actionId?: typeof DSH_ENV_FIX_ACTION_ID;
  canAutoFix: boolean;
  excludeFromBatchAutoFix: true;
};

export type DshInstallCardCopy = {
  title: string;
  body: string;
  runtimePathHint: string;
  openEnvLabel: string;
  installLabel: string;
  installingLabel: string;
};

function joinScript(lines: string[]): string {
  return lines.join('\n');
}

export function buildDshRemediationPlan(
  kind: DshRemediationKind = {},
  npmVersion = '0.1.1-rc.2',
): DshRemediationPlan {
  const rootHint = kind.os === 'windows'
    ? '%USERPROFILE%\\.openclawx\\dsh-runtime'
    : '$HOME/.openclawx/dsh-runtime';

  return {
    summary: kind.docker
      ? '镜像/容器内可选安装 dsh JSON-RPC runtime（编码引擎）。'
      : '可按需安装 dsh 编码引擎到本机数据目录（首次启用 dsh 前建议安装）。',
    steps: [
      '一键安装会写入 ~/.openclawx/dsh-runtime（或 OPENCLAWX_DATA_DIR/dsh-runtime）。',
      '需要本机可用的 npm，并允许访问 npm registry（约 200MB，可能需数分钟）。',
      '安装完成后即可在设置中启用「dsh（编码）」引擎。',
      '也可手动设置 OPENCLAWX_DSH_BIN 指向 dsh-jsonrpc-agent。',
      ...(kind.docker ? ['Docker 建议在构建阶段预装，或挂载已安装的 dsh-runtime 目录。'] : []),
    ],
    script: kind.os === 'windows'
      ? `mkdir ${rootHint}\ncd ${rootHint}\nnpm install @deepseek-ai/dsh-sdk-jsonrpc-demo@${npmVersion} --omit=dev`
      : joinScript([
          `mkdir -p "${rootHint}"`,
          `cd "${rootHint}"`,
          '# 推荐在 OpenClawX「环境检查」点一键安装（会装齐 cordis 插件）',
          `npm install @deepseek-ai/dsh-sdk-jsonrpc-demo@${npmVersion} --omit=dev`,
        ]),
    logic: [
      'OpenClawX 通过 stdio JSON-RPC 调用 dsh-jsonrpc-agent，不走 dsh Web。',
      '一键修复会按 OpenClawX cordis 所需插件清单安装到用户数据目录，并优先于 sibling harness。',
    ],
    actionId: kind.docker ? undefined : DSH_ENV_FIX_ACTION_ID,
    canAutoFix: !kind.docker,
    excludeFromBatchAutoFix: true,
  };
}

export function dshInstallCardCopy(): DshInstallCardCopy {
  return {
    title: 'dsh 编码引擎（按需安装）',
    body: '正式安装包不内置 dsh。首次使用前可安装到用户数据目录（需联网与 npm，约 200MB）。也可在「环境检查」中安装/重试。',
    runtimePathHint: '~/.openclawx/dsh-runtime',
    openEnvLabel: '打开环境检查',
    installLabel: '安装 / 重装 dsh',
    installingLabel: '安装中…（可能需数分钟）',
  };
}

export function isDshEnvCheckId(checkId: string): checkId is typeof DSH_ENV_CHECK_ID {
  return checkId === DSH_ENV_CHECK_ID;
}

export function isDshEnvFixAction(actionId: string): actionId is typeof DSH_ENV_FIX_ACTION_ID {
  return actionId === DSH_ENV_FIX_ACTION_ID;
}
