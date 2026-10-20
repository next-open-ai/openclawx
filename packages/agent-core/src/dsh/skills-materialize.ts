import fs from 'node:fs';
import path from 'node:path';
import type { AgentSkillRuntime } from '@openclawx/contracts';

/** Platform harness skills that overlap dsh built-in fs/bash — skip materializing. */
const SKIP_SKILL_IDS = new Set([
  'openclawx-workspace',
  'skill-discovery',
  'skill-authoring',
]);

function toKebab(raw: string): string {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || 'skill';
}

function uniqueKebab(base: string, used: Set<string>): string {
  let name = base;
  let n = 2;
  while (used.has(name)) {
    name = `${base}-${n}`.slice(0, 64);
    n += 1;
  }
  used.add(name);
  return name;
}

function buildSkillMarkdown(skill: AgentSkillRuntime, kebabName: string): string {
  const description = String(skill.description || skill.name || kebabName).replace(/\s+/g, ' ').trim().slice(0, 500);
  const body = String(skill.instructions || skill.description || '').trim()
    || `When the user task matches “${skill.name || kebabName}”, follow that skill’s purpose and obey the active OpenClawX workspace-mode contract for the final path.`;
  const resources = (skill.resources ?? [])
    .filter((item) => item.path && item.content)
    .slice(0, 20)
    .map((item) => `\n### Resource: ${item.path}\n\n\`\`\`\n${item.content.slice(0, 12_000)}\n\`\`\`\n`)
    .join('');
  return [
    '---',
    `name: ${kebabName}`,
    `description: ${JSON.stringify(description).slice(1, -1)}`,
    '---',
    '',
    body,
    resources,
    '',
  ].join('\n');
}

/**
 * Materialize OpenClawX-authorized skills into a dsh-discoverable directory:
 * `<cwd>/.agents/skills/<kebab>/SKILL.md`
 *
 * Returns the skills root path when at least one skill was written; otherwise null.
 *
 * Note: OpenClawX progressive disclosure often sends `available` skills without
 * `instructions` (pi hydrates via load_skill). dsh has no equivalent until the
 * files exist on disk — so we always write SKILL.md using instructions, else
 * description, else a short fallback, so associated skills stay callable.
 */
export function materializeOpenClawXSkillsForDsh(
  cwd: string,
  skills: AgentSkillRuntime[] | undefined,
): string | null {
  const list = (skills ?? []).filter((skill) => {
    if (!skill?.id) return false;
    if (SKIP_SKILL_IDS.has(skill.id)) return false;
    if (skill.mode !== 'available' && skill.mode !== 'default') return false;
    // Name/description alone is enough — body falls back in buildSkillMarkdown.
    return Boolean(skill.name?.trim() || skill.description?.trim() || skill.instructions?.trim() || skill.rootPath);
  });
  if (!list.length) return null;

  const root = path.join(cwd, '.agents', 'skills');
  fs.mkdirSync(root, { recursive: true });
  const used = new Set<string>();

  for (const skill of list.slice(0, 24)) {
    const kebab = uniqueKebab(toKebab(skill.id || skill.name), used);
    const dir = path.join(root, kebab);
    fs.mkdirSync(dir, { recursive: true });

    // Prefer copying an on-disk SKILL.md when rootPath points at a skill folder.
    const rootPath = skill.rootPath?.trim();
    if (rootPath) {
      const candidates = [
        path.join(rootPath, 'SKILL.md'),
        path.join(rootPath, 'skill.md'),
        rootPath.endsWith('.md') ? rootPath : '',
      ].filter(Boolean);
      const source = candidates.find((item) => {
        try { return fs.existsSync(item) && fs.statSync(item).isFile(); } catch { return false; }
      });
      if (source) {
        fs.copyFileSync(source, path.join(dir, 'SKILL.md'));
        continue;
      }
    }

    fs.writeFileSync(path.join(dir, 'SKILL.md'), buildSkillMarkdown(skill, kebab), 'utf8');
  }

  return root;
}
