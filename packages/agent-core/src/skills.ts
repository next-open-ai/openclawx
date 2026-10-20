import type { McpConnectionRuntime } from '@openclawx/contracts';

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'local';
  path?: string;
  enabled: boolean;
}

export type {
  McpConnection,
  McpProbeResult,
  McpProbeTool,
} from './mcp-runtime.js';

export {
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  connectMcpClient,
  loadMcpToolset,
  probeMcpConnection,
} from './mcp-runtime.js';

/** Parses the portable SKILL.md frontmatter used by Agent Skills. */
export function parseSkillManifest(content: string, path?: string): AgentSkill | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields = Object.fromEntries(
    match[1]
      .split(/\r?\n/)
      .map((line) => line.split(/:\s*/, 2))
      .filter(([key, value]) => key && value),
  );
  if (!fields.name || !fields.description) return null;
  return {
    id: String(fields.name),
    name: String(fields.name),
    description: String(fields.description),
    source: 'local',
    path,
    enabled: true,
  };
}

/** @deprecated Prefer loadMcpToolset from mcp-runtime; kept for type imports. */
export type McpConnectionRuntimeAlias = McpConnectionRuntime;
