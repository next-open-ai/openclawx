import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import {
    formatSkillsForPrompt as piFormatSkillsForPrompt,
    loadSkillsFromDir as piLoadSkillsFromDir,
    type Skill,
} from "@mariozechner/pi-coding-agent";

export type { Skill };

export interface LoadSkillsFromDirOptions {
    dir: string;
    source: string;
}

/**
 * 简单 frontmatter 解析：--- 与 --- 之间的 YAML 风格键值
 */
function parseFrontmatter(raw: string): { name?: string; description?: string } {
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return {};
    const block = match[1];
    const out: Record<string, string> = {};
    for (const line of block.split("\n")) {
        const m = line.match(/^\s*([a-z-]+)\s*:\s*(.*)$/);
        if (m) out[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return {
        name: out.name,
        description: out.description,
    };
}

/**
 * 从单文件加载一个 Skill（与 pi-coding-agent Skill 结构一致）
 */
function loadSkillFromFile(filePath: string, source: string): Skill | null {
    try {
        const raw = readFileSync(filePath, "utf-8");
        const { name, description } = parseFrontmatter(raw);
        const skillDir = dirname(filePath);
        const parentDirName = basename(skillDir);
        const finalName = (name || parentDirName).trim();
        const finalDesc = (description || "").trim();
        if (!finalDesc) return null;
        return {
            name: finalName,
            description: finalDesc,
            filePath,
            baseDir: skillDir,
            source,
            disableModelInvocation: false,
        };
    } catch {
        return null;
    }
}

/**
 * 从目录加载 skills（委托给 pi-coding-agent，规则与其一致）
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): Skill[] {
    const result = piLoadSkillsFromDir(options);
    return result.skills ?? [];
}

/**
 * 从多个路径加载 skills（文件或目录），合并去重（按 name）
 * 目录使用 pi-coding-agent 的 loadSkillsFromDir，单文件使用本地解析
 */
export function loadSkillsFromPaths(paths: string[], source = "user"): Skill[] {
    const byName = new Map<string, Skill>();
    for (const p of paths) {
        const resolved = p.startsWith("~") ? join(process.env.HOME || "", p.slice(1)) : p;
        if (!existsSync(resolved)) continue;
        const stat = statSync(resolved);
        if (stat.isFile() && resolved.endsWith(".md")) {
            const skill = loadSkillFromFile(resolved, source);
            if (skill) byName.set(skill.name, skill);
        } else if (stat.isDirectory()) {
            for (const skill of loadSkillsFromDir({ dir: resolved, source })) {
                byName.set(skill.name, skill);
            }
        }
    }
    return Array.from(byName.values());
}

/**
 * 将 Skill[] 格式化为系统提示中的一段（委托给 pi-coding-agent，对齐 agentskills.io）
 */
function formatSkillsForPrompt(skills: Skill[]): string {
    return piFormatSkillsForPrompt(skills);
}

export { formatSkillsForPrompt };
