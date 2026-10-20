import type { McpConnection, McpLocalRunner, McpUpsertInput } from './mcp-config.js';

/**
 * Built-in MCP catalog shipped with OpenClawX.
 * Stable ids are merged once (capabilities.mcp.seeded.v1); user edits are preserved.
 */
export type BaselineMcpSeed = McpUpsertInput & {
  id: string;
  /** When true, startup probe is skipped until secrets look configured. */
  requiresCredentials?: boolean;
  /** Env keys that must be non-empty / non-placeholder for probe. */
  credentialEnvKeys?: string[];
  /** Arg values that must not remain placeholders for probe. */
  credentialArgPlaceholders?: string[];
};

function localSeed(input: {
  id: string;
  name: string;
  description: string;
  runner?: McpLocalRunner;
  command?: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  requiresCredentials?: boolean;
  credentialEnvKeys?: string[];
  credentialArgPlaceholders?: string[];
}): BaselineMcpSeed {
  const runner = input.runner ?? 'npx';
  return {
    id: input.id,
    name: input.name,
    kind: 'local',
    transport: 'stdio',
    runner,
    command: input.command ?? (runner === 'uvx' ? 'uvx' : runner === 'custom' ? input.command : 'npx'),
    args: input.args,
    env: input.env ?? {},
    cwd: input.cwd ?? '',
    enabled: input.enabled !== false,
    description: input.description,
    requiresCredentials: input.requiresCredentials,
    credentialEnvKeys: input.credentialEnvKeys,
    credentialArgPlaceholders: input.credentialArgPlaceholders,
  };
}

/**
 * 10 commonly used MCP connectors.
 * Prefer zero-config packages that probe cleanly; credential-gated ones are
 * pre-installed so users only fill secrets and re-test.
 */
export const BASELINE_MCPS: BaselineMcpSeed[] = [
  localSeed({
    id: 'mcp-baseline-stock-sdk',
    name: '证券行情 Stock SDK',
    description: 'A股/港股/美股/基金行情与 K 线（零依赖，开箱即用）。',
    args: ['-y', 'stock-sdk', 'mcp'],
  }),
  localSeed({
    id: 'mcp-baseline-akshare',
    name: 'AKShare 证券数据',
    description: 'AKShare 风格 A 股/ETF/期货等行情数据（纯 Node，无需 Python）。',
    args: ['-y', 'quanters-akshare-mcp'],
  }),
  localSeed({
    id: 'mcp-baseline-memory',
    name: 'Memory 记忆图谱',
    description: '持久化实体关系记忆，便于跨会话回忆项目与人事物。',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  }),
  localSeed({
    id: 'mcp-baseline-sequential-thinking',
    name: 'Sequential Thinking',
    description: '分步推理工具，适合复杂问题拆解与校验。',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  }),
  localSeed({
    id: 'mcp-baseline-filesystem',
    name: 'Filesystem 文件',
    description: '读写本地沙箱目录 ~/.openclawx/mcp-files（安全受限路径）。',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '~/.openclawx/mcp-files'],
  }),
  localSeed({
    id: 'mcp-baseline-playwright',
    name: 'Playwright 浏览器',
    description: '结构化网页自动化（打开页面、抽取内容、点击填写）。',
    args: ['-y', '@playwright/mcp@latest'],
  }),
  localSeed({
    id: 'mcp-baseline-chrome-devtools',
    name: 'Chrome DevTools',
    description: '通过 Chrome DevTools 协议检查与操控浏览器页面。',
    args: ['-y', 'chrome-devtools-mcp'],
  }),
  localSeed({
    id: 'mcp-baseline-fetch',
    name: 'Fetch 网页抓取',
    description: '抓取并转换网页内容（uvx mcp-server-fetch，需本机已装 uv）。',
    runner: 'uvx',
    command: 'uvx',
    args: ['mcp-server-fetch'],
  }),
  localSeed({
    id: 'mcp-baseline-feishu',
    name: '飞书文档 Lark',
    description: '飞书/Lark 官方 OpenAPI MCP（文档、消息、日历等）。请将 args 中的 APP_ID / APP_SECRET 换成真实凭证后启用并重测。',
    args: ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '-a', 'YOUR_FEISHU_APP_ID', '-s', 'YOUR_FEISHU_APP_SECRET'],
    enabled: false,
    requiresCredentials: true,
    credentialArgPlaceholders: ['YOUR_FEISHU_APP_ID', 'YOUR_FEISHU_APP_SECRET'],
  }),
  localSeed({
    id: 'mcp-baseline-wecom',
    name: '企业微信 / 腾讯文档',
    description: '企业微信通讯录、审批、微盘与文档（腾讯文档/智能表格）。填写 WECOM_* 环境变量后启用并重测。',
    args: ['-y', '@qwang007/wecom-mcp'],
    env: {
      WECOM_CORP_ID: '',
      WECOM_CORP_SECRET: '',
      WECOM_ADMIN_USERID: '',
    },
    enabled: false,
    requiresCredentials: true,
    credentialEnvKeys: ['WECOM_CORP_ID', 'WECOM_CORP_SECRET'],
  }),
];

export const MCP_SEED_KEY = 'capabilities.mcp.seeded.v1';

const PLACEHOLDER_RE = /^(YOUR_|<.*>|your[_-]|ww1234567890abcdef)?$/i;

export function baselineCredentialsReady(seed: BaselineMcpSeed, connection?: Pick<McpConnection, 'args' | 'env'>): boolean {
  if (!seed.requiresCredentials) return true;
  const args = connection?.args ?? seed.args ?? [];
  const env = connection?.env ?? seed.env ?? {};
  for (const key of seed.credentialEnvKeys ?? []) {
    const value = String(env[key] || '').trim();
    if (!value || PLACEHOLDER_RE.test(value)) return false;
  }
  for (const placeholder of seed.credentialArgPlaceholders ?? []) {
    if (args.some((arg) => arg === placeholder)) return false;
  }
  return true;
}

export function shouldProbeBaseline(seed: BaselineMcpSeed, connection: McpConnection): boolean {
  if (!connection.enabled) return false;
  if (!baselineCredentialsReady(seed, connection)) return false;
  // Re-probe never-tested or previously failed; skip recent passes.
  if (connection.lastTestStatus === 'passed' && connection.lastTestTools?.length) return false;
  return true;
}
