/**
 * 在 Gateway 层处理 POST /server-api/skills/install-from-path，
 * 委托核心 installer 将本地技能目录复制到全局或工作区，不依赖 Nest。
 */
import { installSkillFromPath } from "../../core/installer/index.js";

export interface InstallFromPathBody {
    path: string;
    scope?: "global" | "workspace";
    workspace?: string;
}

export interface InstallFromPathResult {
    success: true;
    data: { installDir: string; name: string };
}

export async function handleInstallSkillFromPath(body: InstallFromPathBody): Promise<InstallFromPathResult> {
    const localPath = (body?.path ?? "").trim();
    if (!localPath) {
        throw new Error("path is required");
    }
    const scope = body?.scope ?? "global";
    const workspaceName = body?.workspace ?? "default";
    const result = await installSkillFromPath(localPath, { scope, workspace: workspaceName });
    return { success: true, data: { installDir: result.installDir, name: result.name } };
}
