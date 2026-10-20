import fs from 'node:fs';
import path from 'node:path';
import type { AgentEngineId } from '@openclawx/contracts';
import { AGENT_ENGINE_IDS } from '@openclawx/contracts';

export type ExecutionRoutingConfig = {
  /** Empty / omitted → all registered backends may be selected. */
  enabledEngines?: AgentEngineId[];
  /** Used when employee does not pin an engine. */
  defaultEngine?: AgentEngineId;
};

function runtimeSettingsFile(): string {
  const dataDir = process.env.OPENCLAWX_DATA_DIR
    || path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.openclawx');
  return path.join(dataDir, 'runtime-settings.json');
}

function normalizeEngineId(raw: unknown): AgentEngineId | null {
  const id = String(raw || '').trim().toLowerCase();
  return (AGENT_ENGINE_IDS as readonly string[]).includes(id) ? (id as AgentEngineId) : null;
}

function normalizeEnabled(raw: unknown): AgentEngineId[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .map((item) => normalizeEngineId(item))
    .filter((item): item is AgentEngineId => Boolean(item));
  // Deduplicate, preserve order.
  return [...new Set(out)];
}

/**
 * Read deployment-level engine routing from `runtime-settings.json` (same file
 * as AgentScope pool knobs). Malformed / missing → empty config (all allowed, default pi).
 */
export function loadExecutionRoutingConfig(): ExecutionRoutingConfig {
  try {
    const file = runtimeSettingsFile();
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { meta?: Record<string, unknown> };
    const meta = parsed?.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
    const enabledEngines = normalizeEnabled(meta.enabledEngines);
    const defaultEngine = normalizeEngineId(meta.defaultEngine) ?? undefined;
    return {
      ...(enabledEngines?.length ? { enabledEngines } : {}),
      ...(defaultEngine ? { defaultEngine } : {}),
    };
  } catch {
    return {};
  }
}
