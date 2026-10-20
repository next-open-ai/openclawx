import type { EnvCheckItem, EnvCheckReport } from './api.js';
import {
  DSH_ENV_FIX_ACTION_ID,
  buildDshRemediationPlan,
  isDshEnvFixAction,
} from '../features/dsh/environment-ui';

/** Whitelisted auto-fix actions executed by the API (desktop/web share this). */
export type EnvFixActionId =
  | 'fix-storage'
  | 'fix-pip'
  | 'fix-agentscope'
  | 'install-python'
  | 'clean-workspace-scrap'
  | typeof DSH_ENV_FIX_ACTION_ID;

export interface EnvRemediationPlan {
  summary: string;
  steps: string[];
  script?: string;
  logic?: string[];
  /** Dockerfile / apt fragment for image rebuilds */
  dockerSnippet?: string;
  /** docker compose / run fragment */
  composeSnippet?: string;
  /** Safe server-side auto-fix id when available */
  actionId?: EnvFixActionId;
  canAutoFix?: boolean;
}

export type PlatformKind = {
  os: 'macos' | 'windows' | 'linux' | 'unknown';
  docker: boolean;
  web: boolean;
};

export function detectPlatform(platform: string): PlatformKind {
  const lower = platform.toLowerCase();
  return {
    os: lower.includes('macos') ? 'macos' : lower.includes('windows') ? 'windows' : lower.includes('linux') ? 'linux' : 'unknown',
    docker: lower.includes('docker'),
    web: lower.includes('web'),
  };
}

function joinScript(lines: string[]): string {
  return lines.join('\n').trim();
}

function dockerHint(kind: PlatformKind): string[] {
  return kind.docker
    ? ['当前运行在 Docker 中。建议把缺失依赖写入 Dockerfile 或构建脚本，而不是只在临时容器里手工安装，否则容器重建后会丢失。']
    : [];
}

export function remediationForCheck(check: EnvCheckItem, report: EnvCheckReport | null): EnvRemediationPlan | null {
  if (!report || check.status === 'ok') return null;
  const kind = detectPlatform(report.platform);

  switch (check.id) {
    case 'node':
      if (kind.docker) {
        return {
          summary: 'Node 版本不足，需要升级基础镜像或构建环境。',
          steps: [
            '将基础镜像切到 Node 22+，或在宿主机构建阶段安装 Node 22 LTS。',
            '重新构建镜像并重新部署服务。',
            ...dockerHint(kind),
          ],
          script: joinScript(['# Dockerfile 示例', 'FROM node:22-bookworm-slim']),
          dockerSnippet: joinScript([
            'FROM node:22-bookworm-slim',
            'RUN apt-get update \\',
            '  && apt-get install -y --no-install-recommends ca-certificates python3 python3-pip python3-venv git \\',
            '  && rm -rf /var/lib/apt/lists/*',
          ]),
        };
      }
      if (kind.os === 'macos') {
        return {
          summary: '安装或升级到 Node 22 LTS。',
          steps: ['安装 Node 22 后重启 OpenClawX。', '确认 `node -v` 与 `npx --version` 都可用。'],
          script: joinScript(['brew install node@22', 'brew link --overwrite node@22']),
        };
      }
      if (kind.os === 'windows') {
        return {
          summary: '安装 Node 22 LTS 并加入 PATH。',
          steps: ['安装完成后重开终端/应用。', '确认 `node -v` 与 `npx --version` 输出正常。'],
          script: 'winget install OpenJS.NodeJS.LTS',
        };
      }
      return {
        summary: '安装 Node 22+。',
        steps: ['安装后重启服务。', ...dockerHint(kind)],
        script: joinScript([
          'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash',
          'nvm install 22',
          'nvm use 22',
        ]),
      };

    case 'python':
      if (kind.os === 'macos') {
        return {
          summary: '安装系统 Python 3.9+（推荐 3.12，匹配脚本与 AgentScope）并确保在 PATH 中；也可依赖预装 runtime。',
          steps: ['可点「尝试安装 Python 3.12」由本机包管理器安装。', '安装完成后执行 `python3 --version` 验证并重启 OpenClawX。'],
          script: 'brew install python@3.12',
          actionId: kind.docker ? undefined : 'install-python',
          canAutoFix: !kind.docker,
        };
      }
      if (kind.os === 'windows') {
        return {
          summary: '安装系统 Python 3.9+（推荐 3.12）并加入 PATH；也可依赖预装 runtime。',
          steps: ['可点「尝试安装 Python 3.12」使用 winget。', '安装后重新打开终端，再重启 OpenClawX。'],
          script: 'winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements',
          actionId: kind.docker ? undefined : 'install-python',
          canAutoFix: !kind.docker,
        };
      }
      return {
        summary: kind.docker ? '在镜像中补装 Python 3.9+（推荐 3.12）。' : '安装系统 Python 3.9+（推荐 3.12）。',
        steps: kind.docker
          ? ['把 Python 写入 Dockerfile 后重建镜像。', ...dockerHint(kind)]
          : ['可点「尝试安装」；若无权限请复制脚本用 sudo 在终端执行。', '安装完成后执行 `python3 --version`。'],
        script: kind.docker
          ? 'apt-get update && apt-get install -y python3 python3-pip python3-venv'
          : 'sudo apt update && sudo apt install -y python3 python3-pip python3-venv',
        dockerSnippet: 'RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/*',
        actionId: kind.docker ? undefined : 'install-python',
        canAutoFix: false,
      };

    case 'python-script-env':
      return {
        summary: '无法选定 Agent 脚本 Python（系统 3.9+ 与预装 runtime 均不可用）。',
        steps: [
          '优先安装系统 Python 3.12（流行且同时满足脚本与引擎版本门槛）。',
          '或重新打包/初始化带 agentscope-runtime 的安装包。',
          '确认依赖只会装到工作区 .python-packages，不会写入 agentscope-runtime。',
          ...(kind.os === 'linux' ? ['Linux 上一键安装可能需要管理员权限；失败时请复制脚本在终端执行。'] : []),
        ],
        script: kind.os === 'macos'
          ? 'brew install python@3.12'
          : kind.os === 'windows'
            ? 'winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements'
            : 'sudo apt update && sudo apt install -y python3 python3-pip',
        actionId: kind.docker ? undefined : 'install-python',
        canAutoFix: !kind.docker && kind.os !== 'linux' && kind.os !== 'unknown',
      };

    case 'workspace-scrap':
      return {
        summary: '工作区存在 Agent 临时脚本或隔离依赖，可安全清理。',
        steps: [
          '删除对话会自动清理对应 staging；删除项目会清理过程目录并保留交付物。',
          '可点「一键清理」立即释放空间。',
          '若自动清理失败，复制下方手动命令处理。',
        ],
        script: report.workspaceScrap?.manualHelp || check.help,
        actionId: 'clean-workspace-scrap',
        canAutoFix: true,
      };

    case 'pip':
      if (kind.os === 'macos') {
        return {
          summary: '为当前 Python 补齐 pip。',
          steps: ['可先尝试一键修复（ensurepip）。', '若仍失败，通过 Homebrew 重装 Python。'],
          script: 'python3 -m ensurepip --upgrade\n# 或\nbrew install python@3.12',
          actionId: 'fix-pip',
          canAutoFix: true,
        };
      }
      if (kind.os === 'windows') {
        return {
          summary: '启用或补装 pip。',
          steps: ['可先尝试一键修复（ensurepip）。', '若失败，请用官方安装器勾选 pip。'],
          script: 'python -m ensurepip --upgrade',
          actionId: 'fix-pip',
          canAutoFix: true,
        };
      }
      return {
        summary: kind.docker ? '在镜像中补装 `python3-pip`，或先尝试 ensurepip。' : '安装 `python3-pip`，或先尝试 ensurepip。',
        steps: ['优先点「一键修复」尝试 ensurepip。', '若仍失败，用系统包管理器安装 pip。', ...dockerHint(kind)],
        script: kind.docker
          ? 'python3 -m ensurepip --upgrade\n# 或写入 Dockerfile：\n# apt-get update && apt-get install -y python3-pip'
          : 'python3 -m ensurepip --upgrade\n# 或\nsudo apt update && sudo apt install -y python3-pip',
        dockerSnippet: 'RUN apt-get update && apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/*',
        actionId: 'fix-pip',
        canAutoFix: true,
      };

    case 'agentscope-python':
      return {
        summary: kind.docker
          ? '需要在镜像或项目内准备可用的 AgentScope Python runtime。'
          : '需要准备 Python 3.10+，并让 AgentScope runtime 可用。',
        steps: [
          '若项目自带 `runtimes/agentscope-runtime/.venv`，优先使用内置 runtime。',
          'Web/桌面可点「一键修复」执行 `openclawx init` 等价逻辑。',
          'Docker 建议把 venv 烘焙进镜像，而不是只在运行中临时安装。',
          ...dockerHint(kind),
        ],
        script: kind.docker
          ? joinScript([
              '# Docker 构建阶段示例',
              'python3 -m venv --copies runtimes/agentscope-runtime/.venv',
              'runtimes/agentscope-runtime/.venv/bin/python3 -m pip install --upgrade pip',
              'runtimes/agentscope-runtime/.venv/bin/python3 -m pip install -r runtimes/agentscope-runtime/requirements.txt',
            ])
          : joinScript(['pnpm openclawx:init', '# 如需强制重装 runtime', 'node bin/openclawx.mjs init --reinstall']),
        dockerSnippet: joinScript([
          'RUN python3 -m venv --copies runtimes/agentscope-runtime/.venv \\',
          '  && runtimes/agentscope-runtime/.venv/bin/python3 -m pip install --upgrade pip \\',
          '  && runtimes/agentscope-runtime/.venv/bin/python3 -m pip install -r runtimes/agentscope-runtime/requirements.txt',
        ]),
        logic: [
          'Web Launcher / Docker 会优先复用项目内置 AgentScope runtime。',
          '一键修复会调用 ensureAgentscopeRuntime：复制脚手架、创建 venv、安装 requirements。',
        ],
        actionId: kind.docker ? undefined : 'fix-agentscope',
        canAutoFix: !kind.docker,
      };

    case 'git':
      if (kind.os === 'macos') {
        return {
          summary: '安装 Git，用于导入 Skills 仓库。',
          steps: ['可使用 Xcode Command Line Tools 或 Homebrew 安装。', '安装后执行 `git --version`。'],
          script: 'xcode-select --install\n# 或\nbrew install git',
        };
      }
      if (kind.os === 'windows') {
        return {
          summary: '安装 Git for Windows 并加入 PATH。',
          steps: ['安装后重新打开终端。', '执行 `git --version` 验证。'],
          script: 'winget install Git.Git',
        };
      }
      return {
        summary: kind.docker ? '在镜像中补装 Git。' : '安装 Git。',
        steps: ['安装后执行 `git --version` 验证。', ...dockerHint(kind)],
        script: kind.docker ? 'apt-get update && apt-get install -y git' : 'sudo apt update && sudo apt install -y git',
        dockerSnippet: 'RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*',
      };

    case 'npx':
      return {
        summary: 'npx 通常随 Node.js 一起提供；若缺失，多半是 Node/npm 安装不完整。',
        steps: ['优先检查 `node -v` 与 `npm -v`。', '必要时重装 Node 22 LTS。', ...dockerHint(kind)],
        script: kind.os === 'windows'
          ? 'winget install OpenJS.NodeJS.LTS'
          : kind.os === 'macos'
            ? 'brew install node@22\nbrew link --overwrite node@22'
            : 'sudo apt update && sudo apt install -y nodejs npm',
        dockerSnippet: 'FROM node:22-bookworm-slim',
      };

    case 'storage': {
      const dataPath = check.found.includes('/') || check.found.includes('\\')
        ? check.found
        : kind.os === 'windows' ? '%USERPROFILE%\\.openclawx' : '~/.openclawx';
      return {
        summary: kind.docker ? '数据目录不可写，需要修正卷挂载或容器用户权限。' : '需要修正本地数据目录权限或磁盘状态。',
        steps: kind.docker
          ? [
              '确认 `OPENCLAWX_DATA_DIR` 指向的目录已挂载且容器用户可写。',
              '若使用 bind mount，检查宿主目录属主和权限。',
              '可先尝试一键修复创建目录；若仍失败，请检查 Compose 挂载。',
              '重新启动容器后再执行环境检查。',
            ]
          : [
              '确认磁盘空间充足。',
              '可点「一键修复」创建数据目录并设置权限。',
              '修正后重新执行环境检查。',
            ],
        script: kind.os === 'windows'
          ? 'mkdir %USERPROFILE%\\.openclawx'
          : `mkdir -p "${dataPath}"\nchmod 700 "${dataPath}"`,
        composeSnippet: joinScript([
          'services:',
          '  openclawx:',
          '    image: openclawx:cn',
          '    ports:',
          '      - "47832:47832"',
          '    environment:',
          '      OPENCLAWX_DATA_DIR: /opt/openclawx-data',
          '    volumes:',
          '      - openclawx-data:/opt/openclawx-data',
          '',
          'volumes:',
          '  openclawx-data:',
        ]),
        logic: kind.docker
          ? ['Docker 建议显式挂载数据卷，并确保容器进程用户对挂载点可写。一键修复只会在当前容器文件系统内尝试 mkdir。']
          : ['一键修复会创建 OPENCLAWX_DATA_DIR（默认 ~/.openclawx）并设置 0700。'],
        actionId: 'fix-storage',
        canAutoFix: true,
      };
    }

    case 'launcher':
      return {
        summary: '当前检查的是 Web/API 运行形态本身。',
        steps: [
          '若只看到 API 模式，说明服务端未同时托管前端静态页。',
          '要获得完整 Web UI，请先构建前端并通过 Web Launcher 启动。',
        ],
        script: 'pnpm web:build\npnpm web:start',
      };

    case 'dsh-runtime': {
      const plan = buildDshRemediationPlan({ docker: kind.docker, os: kind.os });
      return {
        summary: plan.summary,
        steps: plan.steps,
        script: plan.script,
        logic: plan.logic,
        actionId: plan.actionId,
        canAutoFix: plan.canAutoFix,
      };
    }

    case 'electron':
      return {
        summary: 'Electron 桌面壳异常。',
        steps: ['请重新安装桌面版 OpenClawX。', 'Web/Docker 形态不依赖 Electron。'],
      };

    default:
      return {
        summary: '请按当前项的帮助说明逐步修复。',
        steps: check.help.split('\n').map((line) => line.trim()).filter(Boolean),
      };
  }
}

export interface EnvRemediationPack {
  problems: number;
  hostScript: string;
  dockerSnippet: string;
  composeSnippet: string;
  autoFixIds: EnvFixActionId[];
}

/** Aggregate failing checks into one copyable pack for host / Docker. */
export function buildRemediationPack(report: EnvCheckReport | null): EnvRemediationPack | null {
  if (!report) return null;
  const problems = report.checks.filter((item) => item.status !== 'ok');
  if (!problems.length) return null;
  const kind = detectPlatform(report.platform);
  const plans = problems
    .map((item) => remediationForCheck(item, report))
    .filter((item): item is EnvRemediationPlan => Boolean(item));

  const hostLines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `# OpenClawX environment remediation pack (${report.platform})`,
    '',
  ];
  for (const plan of plans) {
    if (!plan.script) continue;
    hostLines.push(`# ${plan.summary}`);
    hostLines.push(plan.script);
    hostLines.push('');
  }

  const dockerLines = [
    '# OpenClawX Dockerfile remediation fragments',
    '# Merge these RUN/FROM lines into your image build as needed.',
    '',
  ];
  const seenDocker = new Set<string>();
  for (const plan of plans) {
    if (!plan.dockerSnippet || seenDocker.has(plan.dockerSnippet)) continue;
    seenDocker.add(plan.dockerSnippet);
    dockerLines.push(plan.dockerSnippet);
    dockerLines.push('');
  }
  if (kind.docker && seenDocker.size === 0) {
    dockerLines.push('FROM node:22-bookworm-slim');
    dockerLines.push('RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv git ca-certificates && rm -rf /var/lib/apt/lists/*');
    dockerLines.push('');
  }

  const compose = plans.find((item) => item.composeSnippet)?.composeSnippet
    || joinScript([
      'services:',
      '  openclawx:',
      '    image: openclawx:cn',
      '    ports:',
      '      - "47832:47832"',
      '    environment:',
      '      OPENCLAWX_DATA_DIR: /opt/openclawx-data',
      '    volumes:',
      '      - openclawx-data:/opt/openclawx-data',
      '',
      'volumes:',
      '  openclawx-data:',
    ]);

  // Exclude heavy optional installs (dsh) from batch "fix all".
  const autoFixIds = [...new Set(
    plans
      .filter((item) => item.canAutoFix && item.actionId && !isDshEnvFixAction(item.actionId))
      .map((item) => item.actionId as EnvFixActionId),
  )];

  return {
    problems: problems.length,
    hostScript: hostLines.join('\n').trim(),
    dockerSnippet: dockerLines.join('\n').trim(),
    composeSnippet: compose,
    autoFixIds,
  };
}
