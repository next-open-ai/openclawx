import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { DEFAULT_AGENT_ID } from '../agent-config/agent-config.service.js';
import { readdir, readFile, stat, mkdir, writeFile, rm, cp, realpath } from 'fs/promises';
import { join, resolve, basename } from 'path';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getOpenbotAgentDir, getOpenbotWorkspaceDir } from '../../core/agent/agent-dir.js';

const execAsync = promisify(exec);

export interface Skill {
    name: string;
    description: string;
    path: string;
    category?: string;
    source?: 'system' | 'global' | 'workspace';
    metadata?: any;
}

/** 工作区技能名仅允许英文、数字、下划线、连字符 */
const SKILL_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * 系统技能目录：仅两条规则，不做复杂搜索。
 * - 运行时/打包：由桌面 main 或部署方设置 OPENBOT_SYSTEM_SKILLS_DIR，用该目录。
 * - 开发/测试：未设置时仅尝试「当前工作目录下的 skills」（从项目根启动时即项目目录下的 skills）。
 */
function resolveSystemSkillsDir(): string | null {
    const envDir = process.env.OPENBOT_SYSTEM_SKILLS_DIR?.trim();
    if (envDir) {
        const abs = resolve(envDir);
        if (existsSync(abs)) return abs;
        return null;
    }
    const cwdSkills = resolve(process.cwd(), 'skills');
    if (existsSync(cwdSkills)) return cwdSkills;
    return null;
}

/** 技能目录与来源：全局=OPENBOT_AGENT_DIR/skills，系统=项目根/skills，工作区=OPENBOT_WORKSPACE_DIR/xxx/skills */
@Injectable()
export class SkillsService {
    /** 待扫描的目录列表 */
    private skillPaths: Array<{ path: string; source: 'system' | 'global' | 'workspace' }> = [];

    constructor() {
        const cwd = process.cwd();
        const workspaceName = process.env.OPENBOT_WORKSPACE || 'default';

        // 全局技能：OPENBOT_AGENT_DIR/skills（默认 ~/.openbot/agent/skills）
        const globalSkillsDir = join(getOpenbotAgentDir(), 'skills');
        // 系统技能：OPENBOT_SYSTEM_SKILLS_DIR 或 cwd/skills（仅此两种）
        const systemSkillsDir = resolveSystemSkillsDir();
        // 工作区技能：OPENBOT_WORKSPACE_DIR/<name>/skills（默认 ~/.openbot/workspace/xxx/skills）
        const workspaceSkillsDir = join(getOpenbotWorkspaceDir(), workspaceName, 'skills');

        if (existsSync(globalSkillsDir)) {
            this.skillPaths.push({ path: globalSkillsDir, source: 'global' });
        }
        if (systemSkillsDir) {
            this.skillPaths.push({ path: systemSkillsDir, source: 'system' });
        }
        if (existsSync(workspaceSkillsDir)) {
            this.skillPaths.push({ path: workspaceSkillsDir, source: 'workspace' });
        }
    }

    /** 指定工作区的 skills 目录绝对路径（受 OPENBOT_WORKSPACE_DIR 影响） */
    getWorkspaceSkillsDir(workspaceName: string): string {
        return join(getOpenbotWorkspaceDir(), workspaceName, 'skills');
    }

    /** 全局技能目录（受 OPENBOT_AGENT_DIR 影响，默认 ~/.openbot/agent/skills） */
    getGlobalSkillsDir(): string {
        return join(getOpenbotAgentDir(), 'skills');
    }

    /** 仅返回全局技能（OPENBOT_AGENT_DIR/skills） */
    async getGlobalSkills(): Promise<Skill[]> {
        const skillPath = this.getGlobalSkillsDir();
        if (!existsSync(skillPath)) return [];
        const skills: Skill[] = [];
        try {
            const entries = await readdir(skillPath);
            for (const entry of entries) {
                const fullPath = join(skillPath, entry);
                const stats = await stat(fullPath);
                if (stats.isDirectory()) {
                    const skillMdPath = join(fullPath, 'SKILL.md');
                    if (existsSync(skillMdPath)) {
                        const content = await readFile(skillMdPath, 'utf-8');
                        skills.push(this.parseSkillFile(entry, content, fullPath, 'global'));
                    }
                }
            }
        } catch (error) {
            console.error('Error reading global skills:', error);
        }
        return skills;
    }

    /** 删除全局技能 */
    async deleteGlobalSkill(name: string): Promise<void> {
        const skillDir = join(this.getGlobalSkillsDir(), name);
        if (!existsSync(skillDir)) {
            throw new NotFoundException('技能不存在');
        }
        await rm(skillDir, { recursive: true });
    }

    /**
     * 通过 npx skills add 安装技能到指定目录。
     * @param url 安装地址（Git 简写、URL 或 owner/repo@skill）
     * @param options.scope 'global' 安装到 OPENBOT_AGENT_DIR/skills；'workspace' 安装到指定工作区的 skills
     * @param options.workspace 当 scope 为 'workspace' 时的工作区名（对应 OPENBOT_WORKSPACE_DIR/<workspace>/skills）
     */
    async installSkillByUrl(
        url: string,
        options?: { scope?: 'global' | 'workspace'; workspace?: string },
    ): Promise<{ stdout: string; stderr: string; installDir: string }> {
        if (!url || !url.trim()) {
            throw new BadRequestException('安装地址不能为空');
        }
        const scope = options?.scope ?? 'global';
        const workspaceName = options?.workspace ?? 'default';
        const targetDir =
            scope === 'workspace'
                ? this.getWorkspaceSkillsDir(workspaceName)
                : this.getGlobalSkillsDir();

        console.log(`[install_skill] 开始安装: url=${url.trim()}, scope=${scope}, workspace=${workspaceName}, 目标目录=${targetDir}`);

        const tempDir = join(tmpdir(), `openbot-skills-${randomUUID()}`);
        // skills CLI 实际安装到 tempDir/.agents/skills，-a pi 时可能用 .pi/skills，两处都尝试
        const tempAgentsSkills = join(tempDir, '.agents', 'skills');
        const tempPiSkills = join(tempDir, '.pi', 'skills');
        let stdout = '';
        let stderr = '';
        const copiedNames: string[] = [];
        try {
            await mkdir(tempPiSkills, { recursive: true });
            const { stdout: out, stderr: err } = await execAsync(
                `npx skills add "${url.trim()}" -a pi -y`,
                { cwd: tempDir, maxBuffer: 4 * 1024 * 1024 },
            );
            stdout = out || '';
            stderr = err || '';
            await mkdir(targetDir, { recursive: true });
            const sourceDir = existsSync(tempAgentsSkills) ? tempAgentsSkills : tempPiSkills;
            const entries = await readdir(sourceDir).catch(() => []);
            for (const entry of entries) {
                const src = join(sourceDir, entry);
                const entryStat = await stat(src).catch(() => null);
                if (!entryStat?.isDirectory()) continue;
                const dest = join(targetDir, entry);
                const srcResolved = await realpath(src).catch(() => src);
                await cp(srcResolved, dest, { recursive: true });
                copiedNames.push(entry);
            }
        } finally {
            await rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }

        console.log(`[install_skill] 安装完成: 最终目录=${targetDir}, 技能名=${copiedNames.join(', ') || '(无)'}`);
        return { stdout, stderr, installDir: targetDir };
    }

    /**
     * 从本地目录安装技能：将指定目录复制到目标 skills 目录。
     * @param localPath 本地技能目录绝对路径（须包含 SKILL.md）
     * @param options.scope 'global' 安装到全局；'workspace' 安装到指定工作区
     * @param options.workspace 当 scope 为 'workspace' 时的工作区名
     */
    async installSkillFromPath(
        localPath: string,
        options?: { scope?: 'global' | 'workspace'; workspace?: string },
    ): Promise<{ installDir: string; name: string }> {
        const pathToUse = resolve(localPath.trim());
        if (!existsSync(pathToUse)) {
            throw new BadRequestException('本地路径不存在');
        }
        const pathStat = await stat(pathToUse);
        if (!pathStat.isDirectory()) {
            throw new BadRequestException('请选择技能目录');
        }
        const skillMdPath = join(pathToUse, 'SKILL.md');
        if (!existsSync(skillMdPath)) {
            throw new BadRequestException('该目录下未找到 SKILL.md，不是有效的技能目录');
        }
        const scope = options?.scope ?? 'global';
        const workspaceName = options?.workspace ?? 'default';
        const targetDir =
            scope === 'workspace'
                ? this.getWorkspaceSkillsDir(workspaceName)
                : this.getGlobalSkillsDir();
        const baseName = basename(pathToUse) || 'skill';
        if (!baseName || !SKILL_NAME_REGEX.test(baseName)) {
            throw new BadRequestException('技能目录名须为英文、数字、下划线或连字符');
        }
        const destPath = join(targetDir, baseName);
        try {
            await mkdir(targetDir, { recursive: true });
            if (existsSync(destPath)) {
                await rm(destPath, { recursive: true });
            }
            const srcResolved = await realpath(pathToUse).catch(() => pathToUse);
            await cp(srcResolved, destPath, { recursive: true });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new BadRequestException(`复制失败: ${msg}`);
        }
        console.log(`[install_skill_from_path] 已安装: ${pathToUse} -> ${destPath}`);
        return { installDir: targetDir, name: baseName };
    }

    async getSkills(): Promise<Skill[]> {
        const skills: Skill[] = [];

        for (const { path: skillPath, source } of this.skillPaths) {
            try {
                const entries = await readdir(skillPath);

                for (const entry of entries) {
                    const fullPath = join(skillPath, entry);
                    const stats = await stat(fullPath);

                    if (stats.isDirectory()) {
                        const skillMdPath = join(fullPath, 'SKILL.md');
                        if (existsSync(skillMdPath)) {
                            const content = await readFile(skillMdPath, 'utf-8');
                            const skill = this.parseSkillFile(entry, content, fullPath, source);
                            skills.push(skill);
                        }
                    }
                }
            } catch (error) {
                console.error(`Error reading skills from ${skillPath}:`, error);
            }
        }

        return skills;
    }

    async getSkill(name: string): Promise<Skill | null> {
        const skills = await this.getSkills();
        return skills.find(s => s.name === name) || null;
    }

    async getSkillContent(name: string): Promise<string | null> {
        const skill = await this.getSkill(name);
        if (!skill) return null;

        try {
            const skillMdPath = join(skill.path, 'SKILL.md');
            return await readFile(skillMdPath, 'utf-8');
        } catch (error) {
            console.error(`Error reading skill content for ${name}:`, error);
            return null;
        }
    }

    /** 仅返回指定工作区下的技能（文件目录管理，不涉及 SQLite） */
    async getSkillsForWorkspace(workspaceName: string): Promise<Skill[]> {
        const skillPath = this.getWorkspaceSkillsDir(workspaceName);
        if (!existsSync(skillPath)) {
            if (workspaceName === DEFAULT_AGENT_ID || workspaceName === 'default') {
                try {
                    await mkdir(skillPath, { recursive: true });
                } catch (e) {
                    console.warn(`[skills] 创建 default 工作区技能目录失败: ${skillPath}`, e);
                }
            }
            if (!existsSync(skillPath)) {
                console.warn(`[skills] 工作区技能目录不存在，返回空列表: workspace=${workspaceName}, path=${skillPath}`);
                return [];
            }
        }

        const skills: Skill[] = [];
        try {
            const entries = await readdir(skillPath);
            for (const entry of entries) {
                const fullPath = join(skillPath, entry);
                try {
                    const stats = await stat(fullPath);
                    if (!stats.isDirectory()) continue;
                    const skillMdPath = join(fullPath, 'SKILL.md');
                    const skillJsonPath = join(fullPath, 'skill.json');
                    const packageJsonPath = join(fullPath, 'package.json');
                    if (existsSync(skillMdPath)) {
                        const content = await readFile(skillMdPath, 'utf-8');
                        skills.push(this.parseSkillFile(entry, content, fullPath, 'workspace'));
                    } else if (existsSync(skillJsonPath)) {
                        const skill = await this.parseSkillJson(entry, skillJsonPath, fullPath);
                        if (skill) skills.push(skill);
                    } else if (existsSync(packageJsonPath)) {
                        const skill = await this.parseSkillJson(entry, packageJsonPath, fullPath);
                        if (skill) skills.push(skill);
                    }
                } catch (entryError: any) {
                    if (entryError?.code !== 'ENOENT') {
                        console.warn(`Skipping workspace skill entry ${entry}:`, entryError?.message ?? entryError);
                    }
                }
            }
        } catch (error) {
            console.error(`Error reading workspace skills from ${skillPath}:`, error);
        }
        return skills;
    }

    /** 从 skill.json 或 package.json 解析出 Skill（兼容无 SKILL.md 的 npm 风格技能目录） */
    private async parseSkillJson(entryName: string, jsonPath: string, fullPath: string): Promise<Skill | null> {
        try {
            const content = await readFile(jsonPath, 'utf-8');
            const data = JSON.parse(content) as { name?: string; description?: string };
            const name = (data.name || entryName).trim() || entryName;
            const description = (data.description || '').trim() || 'No description available';
            return { name: entryName, description, path: fullPath, source: 'workspace' };
        } catch {
            return null;
        }
    }

    async getSkillContentForWorkspace(workspaceName: string, name: string): Promise<string | null> {
        const skillPath = this.getWorkspaceSkillsDir(workspaceName);
        const fullPath = join(skillPath, name);
        const skillMdPath = join(fullPath, 'SKILL.md');
        const readmePath = join(fullPath, 'README.md');
        if (existsSync(skillMdPath)) {
            try {
                return await readFile(skillMdPath, 'utf-8');
            } catch {
                return null;
            }
        }
        if (existsSync(readmePath)) {
            try {
                return await readFile(readmePath, 'utf-8');
            } catch {
                return null;
            }
        }
        return null;
    }

    /** 在工作区下新增技能（创建目录 + SKILL.md） */
    async addSkill(
        workspaceName: string,
        name: string,
        options?: { description?: string; content?: string },
    ): Promise<Skill> {
        if (!name || !SKILL_NAME_REGEX.test(name)) {
            throw new BadRequestException('技能名必须为英文、数字、下划线或连字符');
        }
        const skillDir = join(this.getWorkspaceSkillsDir(workspaceName), name);
        if (existsSync(skillDir)) {
            throw new ConflictException('该技能名已存在');
        }
        await mkdir(skillDir, { recursive: true });
        const description = options?.description ?? 'No description available';
        const body = options?.content ?? '';
        const content = `---\ndescription: ${description}\n---\n\n${body}`;
        await writeFile(join(skillDir, 'SKILL.md'), content, 'utf-8');
        return this.parseSkillFile(name, content, skillDir, 'workspace');
    }

    /** 删除工作区下的技能目录；主智能体（default）下的 Skill 不可删除 */
    async deleteSkill(workspaceName: string, name: string): Promise<void> {
        if (workspaceName === DEFAULT_AGENT_ID || workspaceName === 'default') {
            throw new BadRequestException('主智能体下的 Skill 不可删除');
        }
        const skillDir = join(this.getWorkspaceSkillsDir(workspaceName), name);
        if (!existsSync(skillDir)) {
            throw new NotFoundException('技能不存在');
        }
        await rm(skillDir, { recursive: true });
    }

    private parseSkillFile(name: string, content: string, path: string, source: 'system' | 'global' | 'workspace' = 'system'): Skill {
        // Extract YAML frontmatter
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let description = 'No description available';
        let metadata: any = {};

        if (frontmatterMatch) {
            const frontmatter = frontmatterMatch[1];
            const descMatch = frontmatter.match(/description:\s*(.+)/);
            if (descMatch) {
                description = descMatch[1].trim();
            }

            // Parse other metadata
            const categoryMatch = frontmatter.match(/category:\s*(.+)/);
            if (categoryMatch) {
                metadata.category = categoryMatch[1].trim();
            }
        }

        return {
            name,
            description,
            path,
            category: metadata.category,
            source,
            metadata,
        };
    }
}
