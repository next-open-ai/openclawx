/**
 * Bridge OpenClawX AgentSkillRuntime (employee policy + progressive disclosure)
 * onto pi-coding-agent's Agent Skills prompt format (agentskills.io).
 *
 * Execution / approval gates stay in skill-runtime tools; this module only
 * shapes the catalog the model sees.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill as PiSkill,
} from '@mariozechner/pi-coding-agent';
import type { AgentSkillRuntime } from '@openclawx/contracts';

function skillMdPath(rootPath: string) {
  const direct = path.join(rootPath, 'SKILL.md');
  if (existsSync(direct)) return direct;
  const lower = path.join(rootPath, 'skill.md');
  return existsSync(lower) ? lower : direct;
}

/** Map authorized OpenClawX runtimes onto pi Skill records for prompt formatting. */
export function toPiSkills(skills: AgentSkillRuntime[]): PiSkill[] {
  const out: PiSkill[] = [];
  for (const skill of skills) {
    const root = skill.rootPath?.trim();
    if (!root) {
      // Metadata-only packages: synthesize a virtual skill entry.
      out.push({
        name: skill.id,
        description: skill.description,
        filePath: `${skill.id}.md`,
        baseDir: skill.id,
        source: 'openclawx',
        disableModelInvocation: skill.mode !== 'default',
      });
      continue;
    }
    out.push({
      name: skill.id,
      description: skill.description,
      filePath: skillMdPath(root),
      baseDir: root,
      source: 'openclawx',
      disableModelInvocation: skill.mode !== 'default',
    });
  }
  return out;
}

/**
 * Catalog block for the system prompt using pi's XML formatter when possible.
 * Falls back to a compact bullet list for empty / invalid sets.
 */
export function formatAuthorizedSkillsCatalog(skills: AgentSkillRuntime[]): string {
  if (!skills.length) return 'No Skill packages are authorized for this run.';
  const piSkills = toPiSkills(skills);
  try {
    const formatted = formatSkillsForPrompt(piSkills).trim();
    if (formatted) {
      return [
        formatted,
        '',
        'OpenClawX policy: call load_skill with the exact skill id (name) before reading files or running scripts. Default-mode skills may already include instructions in this prompt.',
      ].join('\n');
    }
  } catch {
    /* fall through */
  }
  return skills.map((skill) => `- ${skill.id} (${skill.mode}): ${skill.description}`).join('\n');
}

/**
 * Optionally enrich from on-disk skill trees (managed library dirs) using
 * pi-coding-agent discovery, then intersect with authorized ids.
 */
export function discoverPiSkillsUnder(dir: string, source = 'openclawx-library'): PiSkill[] {
  if (!dir || !existsSync(dir)) return [];
  try {
    return loadSkillsFromDir({ dir, source }).skills ?? [];
  } catch {
    return [];
  }
}

export function mergeDiscoveredSkillDescriptions(
  authorized: AgentSkillRuntime[],
  discovered: PiSkill[],
): AgentSkillRuntime[] {
  if (!discovered.length) return authorized;
  const byName = new Map(discovered.map((item) => [item.name, item]));
  return authorized.map((skill) => {
    const hit = byName.get(skill.id) || byName.get(skill.name);
    if (!hit?.description?.trim()) return skill;
    if (skill.description.trim() === hit.description.trim()) return skill;
    return { ...skill, description: hit.description.trim() };
  });
}
