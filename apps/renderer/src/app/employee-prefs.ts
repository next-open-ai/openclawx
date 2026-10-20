import { ref } from 'vue';
import type { SearchProviderId } from './search-config';
import type { KnowledgeProviderId } from './kb-config';
import { knowledgeProviderIds } from './kb-config';
import { getStorageNamespace, readStored, writeStored } from './storage';

export type EmployeeSearchMode = 'inherit' | 'auto' | 'off' | 'llm-builtin' | SearchProviderId;
/** Which knowledge provider this employee uses; then pick bases under that provider. */
export type EmployeeKnowledgeProvider = KnowledgeProviderId | 'off';

export interface EmployeeRuntimePrefs {
  /** null / empty = follow workspace active model */
  defaultModelId: string | null;
  searchMode: EmployeeSearchMode;
  /** Agent tool/LLM step budget; default 50 */
  maxSteps: number;
  /** Whole-run wall-clock timeout in ms. */
  runTimeoutMs: number;
  /** Per MCP tool call timeout in ms. */
  mcpToolTimeoutMs: number;
  /** Associated MCP connector ids (enabled connectors are injected at runtime). */
  mcpIds: string[];
  /** Knowledge provider this employee is bound to (`off` = no KB tools). */
  knowledgeProvider: EmployeeKnowledgeProvider;
  /** Associated knowledge base ids (must belong to knowledgeProvider). */
  knowledgeBaseIds: string[];
  /**
   * Execution backend for this employee.
   * `null` = inherit deployment defaultEngine from runtime-settings.
   */
  engine: 'pi' | 'agentscope' | 'dsh' | 'opencode' | 'claude-code' | null;
  /** Expose all configured non-chat application models to this employee. */
  useApplicationModels: boolean;
}

export const DEFAULT_MAX_STEPS = 50;
/** Kept for compatibility; every employee starts from the same platform floor. */
export const RESEARCH_DEFAULT_MAX_STEPS = DEFAULT_MAX_STEPS;
/** A configured budget may increase the platform default, never lower it. */
export const MIN_MAX_STEPS = DEFAULT_MAX_STEPS;
export const MAX_MAX_STEPS = 64;

/** Default whole-run budget: 30 minutes. */
export const DEFAULT_RUN_TIMEOUT_MS = 1_800_000;
const LEGACY_DEFAULT_RUN_TIMEOUT_MS = 600_000;
export const MIN_RUN_TIMEOUT_MS = 60_000;
export const MAX_RUN_TIMEOUT_MS = 1_800_000;

export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000;
export const MIN_MCP_TOOL_TIMEOUT_MS = 5_000;
export const MAX_MCP_TOOL_TIMEOUT_MS = 300_000;

export const defaultEmployeeRuntimePrefs = (employeeId?: string): EmployeeRuntimePrefs => ({
  defaultModelId: null,
  searchMode: 'inherit',
  maxSteps: DEFAULT_MAX_STEPS,
  runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
  mcpToolTimeoutMs: DEFAULT_MCP_TOOL_TIMEOUT_MS,
  mcpIds: [],
  knowledgeProvider: 'off',
  knowledgeBaseIds: [],
  engine: null,
  useApplicationModels: true,
});

const key = 'workspace.employee-runtime-prefs';
const prefsByEmployee = ref<Record<string, EmployeeRuntimePrefs>>({});
/** Tracks which auth namespace the in-memory prefs were loaded for (`null` = logged out). */
const loadedForNamespace = ref<string | null | undefined>(undefined);

function clampSteps(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_STEPS;
  return Math.min(MAX_MAX_STEPS, Math.max(MIN_MAX_STEPS, Math.round(n)));
}

function clampTimeout(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeKnowledgeProvider(value: unknown): EmployeeKnowledgeProvider {
  if (value === 'off') return 'off';
  if (typeof value === 'string' && knowledgeProviderIds.includes(value as KnowledgeProviderId)) {
    return value as KnowledgeProviderId;
  }
  return 'off';
}

function normalizeEngine(value: unknown): EmployeeRuntimePrefs['engine'] {
  const id = String(value || '').trim().toLowerCase();
  if (id === 'pi' || id === 'agentscope' || id === 'dsh' || id === 'opencode' || id === 'claude-code') return id;
  return null;
}

function normalizeOne(value: unknown): EmployeeRuntimePrefs {
  const raw = value && typeof value === 'object' ? (value as Partial<EmployeeRuntimePrefs> & { knowledgeBaseIds?: unknown }) : {};
  const searchMode = raw.searchMode;
  const allowedSearch =
    searchMode === 'inherit' ||
    searchMode === 'auto' ||
    searchMode === 'off' ||
    searchMode === 'llm-builtin' ||
    searchMode === 'bocha' ||
    searchMode === 'tavily' ||
    searchMode === 'brave' ||
    searchMode === 'exa' ||
    searchMode === 'zhipu' ||
    searchMode === 'aliyun';
  const knowledgeBaseIds = Array.isArray(raw.knowledgeBaseIds)
    ? raw.knowledgeBaseIds.map((id) => String(id)).filter(Boolean).slice(0, 24)
    : [];
  return {
    defaultModelId: raw.defaultModelId ? String(raw.defaultModelId) : null,
    searchMode: allowedSearch ? searchMode : 'inherit',
    maxSteps: clampSteps(raw.maxSteps),
    // Migrate the former persisted default (10 minutes). Other explicit values
    // remain untouched, so customized employee budgets still work.
    runTimeoutMs: Number(raw.runTimeoutMs) === LEGACY_DEFAULT_RUN_TIMEOUT_MS
      ? DEFAULT_RUN_TIMEOUT_MS
      : clampTimeout(raw.runTimeoutMs, DEFAULT_RUN_TIMEOUT_MS, MIN_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS),
    mcpToolTimeoutMs: clampTimeout(raw.mcpToolTimeoutMs, DEFAULT_MCP_TOOL_TIMEOUT_MS, MIN_MCP_TOOL_TIMEOUT_MS, MAX_MCP_TOOL_TIMEOUT_MS),
    mcpIds: Array.isArray(raw.mcpIds) ? raw.mcpIds.map((id) => String(id)).filter(Boolean).slice(0, 24) : [],
    knowledgeProvider: normalizeKnowledgeProvider(raw.knowledgeProvider),
    knowledgeBaseIds,
    engine: normalizeEngine(raw.engine),
    useApplicationModels: raw.useApplicationModels !== false,
  };
}

function normalizeAll(value: unknown): Record<string, EmployeeRuntimePrefs> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([id, prefs]) => [id, normalizeOne(prefs)]),
  );
}

export function useEmployeeRuntimePrefs() {
  const load = async (opts?: { force?: boolean }) => {
    const ns = getStorageNamespace();
    // Avoid sticky empty loads from before auth sets `user:<id>` namespace.
    if (!opts?.force && loadedForNamespace.value === ns) return;
    try {
      prefsByEmployee.value = normalizeAll(JSON.parse((await readStored(key)) || '{}'));
    } catch {
      prefsByEmployee.value = {};
    }
    loadedForNamespace.value = ns;
  };

  const persist = async () => {
    await writeStored(key, JSON.stringify(prefsByEmployee.value));
  };

  const get = (employeeId: string): EmployeeRuntimePrefs =>
    prefsByEmployee.value[employeeId] ? { ...prefsByEmployee.value[employeeId] } : defaultEmployeeRuntimePrefs(employeeId);

  const set = async (employeeId: string, patch: Partial<EmployeeRuntimePrefs>) => {
    const next = normalizeOne({ ...get(employeeId), ...patch });
    prefsByEmployee.value = { ...prefsByEmployee.value, [employeeId]: next };
    await persist();
    return next;
  };

  const reset = async (employeeId: string) => {
    const next = { ...prefsByEmployee.value };
    delete next[employeeId];
    prefsByEmployee.value = next;
    await persist();
  };

  return { prefsByEmployee, load, get, set, reset, defaultEmployeeRuntimePrefs };
}
