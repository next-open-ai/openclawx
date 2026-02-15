/**
 * 核心安装模块：按 URL 或按路径安装技能到全局或工作区，不依赖 Nest。
 * 供 install_skill 工具、Gateway、CLI 等统一使用。
 */
import { readFile, readdir, stat, mkdir, rm, cp, realpath } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve, basename } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import AdmZip from "adm-zip";
import { exec } from "child_process";
import { promisify } from "util";
import { homedir } from "os";
import { getOpenbotAgentDir, getOpenbotWorkspaceDir } from "../agent/agent-dir.js";

const execAsync = promisify(exec);

function getDesktopDir(): string {
    const home = process.env.HOME || process.env.USERPROFILE || homedir();
    return join(home, ".openbot", "desktop");
}

interface AgentItem {
    id: string;
    workspace: string;
}

interface AgentsFile {
    agents?: AgentItem[];
}

/** 解析 targetAgentId 得到安装目标：global 或 workspace + 工作区名 */
export async function resolveInstallTarget(
    targetAgentId: string | undefined,
): Promise<{ scope: "global" | "workspace"; workspace: string }> {
    const tid = (targetAgentId ?? "").trim().toLowerCase();
    if (tid === "global" || tid === "all") {
        return { scope: "global", workspace: "default" };
    }
    if (!tid) {
        return { scope: "workspace", workspace: "default" };
    }
    const agentsPath = join(getDesktopDir(), "agents.json");
    if (!existsSync(agentsPath)) {
        return { scope: "workspace", workspace: tid };
    }
    try {
        const raw = await readFile(agentsPath, "utf-8");
        const data = JSON.parse(raw) as AgentsFile;
        const agents = Array.isArray(data.agents) ? data.agents : [];
        const agent = agents.find((a) => a.id === tid);
        const workspace = agent?.workspace?.trim() || tid;
        return { scope: "workspace", workspace };
    } catch {
        return { scope: "workspace", workspace: tid };
    }
}

function getGlobalSkillsDir(): string {
    return join(getOpenbotAgentDir(), "skills");
}

function getWorkspaceSkillsDir(workspaceName: string): string {
    return join(getOpenbotWorkspaceDir(), workspaceName, "skills");
}

export interface InstallByUrlOptions {
    scope: "global" | "workspace";
    workspace?: string;
}

export interface InstallByUrlResult {
    stdout: string;
    stderr: string;
    installDir: string;
}

/**
 * 通过 npx skills add 安装技能到指定目录（与 Nest SkillsService 逻辑一致）。
 */
export async function installSkillByUrl(
    url: string,
    options: InstallByUrlOptions = { scope: "global", workspace: "default" },
): Promise<InstallByUrlResult> {
    const scope = options.scope ?? "global";
    const workspaceName = options.workspace ?? "default";
    const targetDir =
        scope === "workspace"
            ? getWorkspaceSkillsDir(workspaceName)
            : getGlobalSkillsDir();

    const tempDir = join(tmpdir(), `openbot-skills-${randomUUID()}`);
    const tempAgentsSkills = join(tempDir, ".agents", "skills");
    const tempPiSkills = join(tempDir, ".pi", "skills");
    let stdout = "";
    let stderr = "";
    try {
        await mkdir(tempPiSkills, { recursive: true });
        const { stdout: out, stderr: err } = await execAsync(
            `npx skills add "${url.trim()}" -a pi -y`,
            { cwd: tempDir, maxBuffer: 4 * 1024 * 1024 },
        );
        stdout = out || "";
        stderr = err || "";
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
        }
    } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    return { stdout, stderr, installDir: targetDir };
}

const SKILL_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

export interface InstallFromPathOptions {
    scope: "global" | "workspace";
    workspace?: string;
}

export interface InstallFromPathResult {
    installDir: string;
    name: string;
}

/**
 * 从本地目录安装技能：将指定目录复制到目标 skills 目录。
 */
export async function installSkillFromPath(
    localPath: string,
    options: InstallFromPathOptions = { scope: "global", workspace: "default" },
): Promise<InstallFromPathResult> {
    const pathToUse = resolve(localPath.trim());
    if (!existsSync(pathToUse)) {
        throw new Error("本地路径不存在");
    }
    const pathStat = await stat(pathToUse);
    if (!pathStat.isDirectory()) {
        throw new Error("请选择技能目录");
    }
    const skillMdPath = join(pathToUse, "SKILL.md");
    if (!existsSync(skillMdPath)) {
        throw new Error("该目录下未找到 SKILL.md，不是有效的技能目录");
    }
    const scope = options.scope ?? "global";
    const workspaceName = options.workspace ?? "default";
    const targetDir =
        scope === "workspace"
            ? getWorkspaceSkillsDir(workspaceName)
            : getGlobalSkillsDir();
    const baseName = basename(pathToUse) || "skill";
    if (!baseName || !SKILL_NAME_REGEX.test(baseName)) {
        throw new Error("技能目录名须为英文、数字、下划线或连字符");
    }
    const destPath = join(targetDir, baseName);
    await mkdir(targetDir, { recursive: true });
    if (existsSync(destPath)) {
        await rm(destPath, { recursive: true });
    }
    const srcResolved = await realpath(pathToUse).catch(() => pathToUse);
    await cp(srcResolved, destPath, { recursive: true });
    return { installDir: targetDir, name: baseName };
}

/** 上传 zip 包最大体积（字节） */
const MAX_UPLOAD_ZIP_BYTES = 10 * 1024 * 1024;

export interface InstallFromUploadOptions {
    scope: "global" | "workspace";
    workspace?: string;
}

/** 解压后忽略的条目（系统/打包产生的噪音） */
const IGNORED_ZIP_ENTRIES = new Set(["__MACOSX", ".DS_Store", ".git", "Thumbs.db"]);

function isIgnoredZipEntry(name: string): boolean {
    if (!name || name.includes("..")) return true;
    if (IGNORED_ZIP_ENTRIES.has(name)) return true;
    if (name.startsWith(".")) return true;
    return false;
}

/**
 * 从上传的 zip 安装技能：解压到临时目录，校验为单个技能目录（含 SKILL.md），再复制到目标。
 * 支持两种 zip 结构：① 单个顶层目录且内含 SKILL.md；② 根目录直接含 SKILL.md（将视为技能根目录）。
 */
export async function installSkillFromUpload(
    zipBuffer: Buffer,
    options: InstallFromUploadOptions = { scope: "global", workspace: "default" },
): Promise<InstallFromPathResult> {
    if (zipBuffer.length > MAX_UPLOAD_ZIP_BYTES) {
        throw new Error("zip 包不能超过 10MB");
    }
    const tempDir = join(tmpdir(), `openbot-upload-${randomUUID()}`);
    try {
        await mkdir(tempDir, { recursive: true });
        const zip = new AdmZip(zipBuffer);
        zip.extractAllTo(tempDir, true);

        const allEntries = await readdir(tempDir);
        const entries = allEntries.filter((e) => !isIgnoredZipEntry(e));

        let skillPath: string;

        if (entries.length === 0) {
            throw new Error("zip 解压后未得到有效内容，请检查 zip 是否包含技能目录或 SKILL.md");
        }

        if (entries.length === 1) {
            const singleName = entries[0]!;
            const candidatePath = join(tempDir, singleName);
            const statEntry = await stat(candidatePath);
            if (statEntry.isDirectory()) {
                const skillMdInDir = join(candidatePath, "SKILL.md");
                if (existsSync(skillMdInDir)) {
                    skillPath = candidatePath;
                } else {
                    throw new Error("该目录下未找到 SKILL.md，请确保 zip 内技能目录根目录含有 SKILL.md 文件");
                }
            } else {
                if (existsSync(join(tempDir, "SKILL.md"))) {
                    throw new Error("zip 根目录含有 SKILL.md，但根目录下还有其它文件，请将整个技能放在一个子目录内再打包");
                }
                throw new Error("zip 内未找到包含 SKILL.md 的技能目录，请检查打包方式");
            }
        } else {
            const skillMdAtRoot = existsSync(join(tempDir, "SKILL.md"));
            const dirsWithSkillMd: string[] = [];
            for (const e of entries) {
                const p = join(tempDir, e);
                const st = await stat(p).catch(() => null);
                if (st?.isDirectory() && existsSync(join(p, "SKILL.md"))) dirsWithSkillMd.push(p);
            }
            if (dirsWithSkillMd.length === 1) {
                skillPath = dirsWithSkillMd[0]!;
            } else if (dirsWithSkillMd.length > 1) {
                throw new Error("zip 内包含多个技能目录，请只保留一个技能目录再打包");
            } else if (skillMdAtRoot) {
                skillPath = tempDir;
            } else {
                throw new Error("zip 内未找到包含 SKILL.md 的技能目录；若为多文件打包，请将 SKILL.md 放在 zip 根目录或单个子目录内");
            }
        }

        if (skillPath === tempDir) {
            const baseName = "skill";
            const wrappedDir = join(tmpdir(), `openbot-skill-wrap-${randomUUID()}`);
            try {
                await mkdir(wrappedDir, { recursive: true });
                const destPath = join(wrappedDir, baseName);
                await cp(tempDir, destPath, { recursive: true });
                return await installSkillFromPath(destPath, options);
            } finally {
                await rm(wrappedDir, { recursive: true, force: true }).catch(() => {});
            }
        }

        return await installSkillFromPath(skillPath, options);
    } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}
