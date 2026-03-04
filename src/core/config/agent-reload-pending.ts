/**
 * Agent 配置更新后「待重载」标志：存于 ~/.openbot/desktop/.agent-reload-pending.json。
 * Nest 保存配置时会先写入本标志，再立即使该 agent 下所有运行中 Session 失效并消费标志；
 * Gateway 在 getOrCreateSession 前若发现该 agent 有待重载，则先使旧 Session 失效再建新 Session 并消费标志。
 * 二者配合实现配置更新后运行实例安全、及时生效。
 */
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const FILENAME = ".agent-reload-pending.json";

function getDesktopDir(): string {
    const home = process.env.HOME || process.env.USERPROFILE || homedir();
    return join(home, ".openbot", "desktop");
}

function getFilePath(): string {
    return join(getDesktopDir(), FILENAME);
}

interface PendingFile {
    agentIds?: string[];
}

async function readPending(): Promise<string[]> {
    const path = getFilePath();
    if (!existsSync(path)) return [];
    try {
        const raw = await readFile(path, "utf-8");
        const data = JSON.parse(raw) as PendingFile;
        return Array.isArray(data.agentIds) ? data.agentIds : [];
    } catch {
        return [];
    }
}

async function writePending(agentIds: string[]): Promise<void> {
    const dir = getDesktopDir();
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(join(dir, FILENAME), JSON.stringify({ agentIds }, null, 0), "utf-8");
}

/** 保存配置后调用：将 agentId 加入待重载列表 */
export async function addPendingAgentReload(agentId: string): Promise<void> {
    if (!agentId || !agentId.trim()) return;
    const id = agentId.trim();
    const list = await readPending();
    if (list.includes(id)) return;
    await writePending([...list, id]);
}

/** 获取当前待重载的 agentId 列表（仅读） */
export async function getPendingAgentReloadIds(): Promise<string[]> {
    return readPending();
}

/**
 * 若该 agent 在待重载列表中则移除并返回 true，否则返回 false。
 * 在使旧 Session 失效前调用，便于调用方先 invalidate 再 getOrCreateSession。
 */
export async function consumePendingAgentReload(agentId: string): Promise<boolean> {
    if (!agentId || !agentId.trim()) return false;
    const id = agentId.trim();
    const list = await readPending();
    const idx = list.indexOf(id);
    if (idx < 0) return false;
    const next = list.slice(0, idx).concat(list.slice(idx + 1));
    await writePending(next);
    return true;
}
