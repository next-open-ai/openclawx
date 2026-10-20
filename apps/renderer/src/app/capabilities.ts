import { ref } from 'vue';
import { BASELINE_CATALOG_SKILLS, isBaselineCatalogSkill } from './baseline-catalog-skills.js';
import { readStored, writeStored } from './storage.js';
import {
  getServerCapabilitySkills,
  saveServerCapabilitySkills,
} from '../services/api.js';

export type SkillSource = 'builtin' | 'local' | 'registry';
export type SkillStatus = 'ready' | 'draft' | 'disabled';
export type PolicyMode = 'disabled' | 'available' | 'default';
export type ExecutionLevel = 'read-only' | 'default' | 'full';
export const defaultSkillExecution = (level: ExecutionLevel = 'default') => ({ allowWorkspaceWrite: level !== 'read-only', allowScriptExecution: level !== 'read-only', allowedNetworkHosts: [] as string[], allowAllNonDestructive: level === 'full' });

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  status: SkillStatus;
  risk: 'low' | 'medium' | 'high';
  path?: string;
  /** Inline SKILL body for builtin catalog packs (no path). */
  instructions?: string;
  tags: string[];
  systemOnly?: boolean;
  execution: { allowWorkspaceWrite: boolean; allowScriptExecution: boolean; allowedNetworkHosts: string[]; allowAllNonDestructive: boolean };
}

export interface EmployeeSkillPolicy {
  employeeId: string;
  skillId: string;
  mode: PolicyMode;
  priority: number;
  approvalRequired: boolean;
}

const skillKey = 'capabilities.skills.v2';
const policyKey = 'capabilities.employee-policies';
const seededKey = 'capabilities.seeded.v1';

export { isBaselineCatalogSkill };

export const builtinSkills: SkillRecord[] = [
  { id: 'skill-discovery', name: 'Skill Discovery', description: 'Search the open skill ecosystem and review a package before installation.', source: 'builtin', status: 'ready', risk: 'medium', tags: ['平台', 'registry', 'web'], systemOnly: true, execution: defaultSkillExecution() },
  { id: 'skill-authoring', name: 'Skill Authoring', description: 'Create and validate portable SKILL.md packages with progressive disclosure.', source: 'builtin', status: 'ready', risk: 'low', tags: ['平台', 'developer', 'local'], systemOnly: true, execution: defaultSkillExecution() },
  { id: 'mcp-governance', name: 'MCP Governance', description: 'Review MCP connections, tool scopes, and approval boundaries before activation.', source: 'builtin', status: 'ready', risk: 'high', tags: ['平台', 'mcp', 'security'], systemOnly: true, execution: defaultSkillExecution() },
  { id: 'document-workbench', name: 'Document Workbench', description: 'Structure, summarize, and improve documents without external side effects.', source: 'builtin', status: 'ready', risk: 'low', tags: ['文档', 'writing', 'office'], execution: defaultSkillExecution('read-only'), instructions: '处理文档类任务时：先澄清受众与目标，再给出清晰结构（标题层级、摘要、正文要点、待办）。优先可读、可执行，避免空话。' },
];

const skills = ref<SkillRecord[]>([]);
const policies = ref<EmployeeSkillPolicy[]>([]);

function parse<T>(raw: string | null, fallback: T): T { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } }
function canonicalName(value: string) { return value.trim().replace(/^['"]|['"]$/g, '').toLowerCase(); }

function toPersistedSkill(seed: SkillRecord): SkillRecord {
  return {
    id: seed.id,
    name: seed.name,
    description: seed.description,
    source: seed.source,
    status: seed.status,
    risk: seed.risk,
    tags: [...seed.tags],
    ...(seed.systemOnly ? { systemOnly: true } : {}),
    ...(seed.path ? { path: seed.path } : {}),
    ...(seed.instructions ? { instructions: seed.instructions } : {}),
    execution: {
      allowWorkspaceWrite: Boolean(seed.execution?.allowWorkspaceWrite),
      allowScriptExecution: Boolean(seed.execution?.allowScriptExecution),
      allowedNetworkHosts: [...(seed.execution?.allowedNetworkHosts ?? [])],
      allowAllNonDestructive: Boolean(seed.execution?.allowAllNonDestructive),
    },
  };
}

/** Idempotent merge of platform + popular catalog skills (same pattern as baseline MCPs). */
function ensureBaselineCatalogSkills(): boolean {
  let changed = false;
  const byId = new Map(skills.value.map((skill) => [skill.id, skill]));
  const seeds: SkillRecord[] = [
    ...builtinSkills.map(toPersistedSkill),
    ...BASELINE_CATALOG_SKILLS.map((seed) => toPersistedSkill(seed)),
  ];
  for (const seed of seeds) {
    const existing = byId.get(seed.id);
    if (!existing) {
      const next = { ...seed };
      skills.value.push(next);
      byId.set(seed.id, next);
      changed = true;
      continue;
    }
    // Upgrade path: fill missing inline instructions / refresh catalog copy for builtin packs.
    if (seed.instructions && !existing.instructions) {
      existing.instructions = seed.instructions;
      changed = true;
    }
    if (existing.source === 'builtin' && isBaselineCatalogSkill(seed.id)) {
      if (existing.description !== seed.description) {
        existing.description = seed.description;
        changed = true;
      }
      if (!existing.tags?.length && seed.tags.length) {
        existing.tags = [...seed.tags];
        changed = true;
      }
    }
  }
  return changed;
}

export function useCapabilities() {
  const load = async () => {
    const desktop = Boolean(window.openclawxDesktop);
    const seeded = await readStored(seededKey);
    const restoredStored: SkillRecord[] | unknown = desktop
      ? parse<SkillRecord[]>(await readStored(skillKey), seeded ? [] : builtinSkills)
      : await getServerCapabilitySkills();
    const restored: SkillRecord[] = desktop
      ? (restoredStored as SkillRecord[])
      : (Array.isArray(restoredStored) ? restoredStored as SkillRecord[] : builtinSkills);
    const unique = new Map<string, SkillRecord>();
    for (const skill of restored) {
      const normalized = {
        ...skill,
        name: skill.name.replace(/^['"]|['"]$/g, ''),
        execution: skill.execution?.allowAllNonDestructive !== undefined ? skill.execution : defaultSkillExecution(),
        ...(skill.instructions ? { instructions: skill.instructions } : {}),
      };
      const key = normalized.source === 'builtin' ? normalized.id : canonicalName(normalized.name);
      const current = unique.get(key);
      if (!current || (current.source === 'registry' && normalized.path)) unique.set(key, normalized);
    }
    skills.value = [...unique.values()];
    if (skills.value.length !== restored.length) {
      if (desktop) await writeStored(skillKey, JSON.stringify(skills.value));
      else await saveServerCapabilitySkills(skills.value).catch(() => undefined);
    }
    const storedPolicies = parse<EmployeeSkillPolicy[]>(await readStored(policyKey), []);
    policies.value = Array.isArray(storedPolicies) ? storedPolicies as EmployeeSkillPolicy[] : [];
    if (!seeded) {
      policies.value = [
        ...builtinSkills.filter((skill) => skill.systemOnly).map((skill) => ({ employeeId: 'administrator', skillId: skill.id, mode: 'default' as PolicyMode, priority: 100, approvalRequired: true })),
        { employeeId: 'general', skillId: 'document-workbench', mode: 'available', priority: 50, approvalRequired: false },
      ];
      if (desktop) await writeStored(skillKey, JSON.stringify(skills.value));
      await writeStored(policyKey, JSON.stringify(policies.value));
      await writeStored(seededKey, 'true');
    }
    if (ensureBaselineCatalogSkills()) {
      if (desktop) await writeStored(skillKey, JSON.stringify(skills.value));
      else await saveServerCapabilitySkills(skills.value).catch(() => undefined);
    }
  };
  const saveSkills = async () => (
    window.openclawxDesktop
      ? writeStored(skillKey, JSON.stringify(skills.value))
      : saveServerCapabilitySkills(skills.value)
  );
  const setExecutionPolicy = async (skillId: string, execution: SkillRecord['execution']) => {
    const skill = skills.value.find((item) => item.id === skillId);
    if (!skill) return;
    skill.execution = {
      allowWorkspaceWrite: Boolean(execution.allowWorkspaceWrite),
      allowScriptExecution: Boolean(execution.allowScriptExecution),
      allowedNetworkHosts: [...new Set(execution.allowedNetworkHosts.map((host) => host.trim().toLowerCase()).filter((host) => /^[a-z0-9.-]+$/i.test(host)))].slice(0, 32),
      allowAllNonDestructive: Boolean(execution.allowAllNonDestructive),
    };
    await saveSkills();
  };
  const removeSkill = async (id: string) => {
    if (id.startsWith('skill-baseline-') || builtinSkills.some((skill) => skill.id === id)) return;
    skills.value = skills.value.filter((skill) => skill.id !== id);
    policies.value = policies.value.filter((policy) => policy.skillId !== id);
    await Promise.all([saveSkills(), savePolicies()]);
  };
  const savePolicies = async () => (
    writeStored(policyKey, JSON.stringify(policies.value))
  );
  const policyFor = (employeeId: string, skillId: string) => policies.value.find((item) => item.employeeId === employeeId && item.skillId === skillId);
  const setPolicy = async (employeeId: string, skillId: string, mode: PolicyMode) => {
    const found = policyFor(employeeId, skillId);
    if (found) found.mode = mode;
    else policies.value.push({ employeeId, skillId, mode, priority: 50, approvalRequired: mode !== 'disabled' });
    await savePolicies();
  };
  const allowedSkillsFor = (employeeId: string) => skills.value.filter((skill) => policyFor(employeeId, skill.id)?.mode !== 'disabled' && policyFor(employeeId, skill.id));
  return { skills, policies, load, saveSkills, removeSkill, setExecutionPolicy, policyFor, setPolicy, allowedSkillsFor };
}
