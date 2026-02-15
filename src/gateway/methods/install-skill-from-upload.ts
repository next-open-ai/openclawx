/**
 * 在 Gateway 层处理 POST /server-api/skills/install-from-upload，
 * 接收 multipart zip 文件，委托核心 installer 解压并安装到全局或工作区。
 */
import { installSkillFromUpload } from "../../core/installer/index.js";

export interface InstallFromUploadBody {
    /** zip 文件 buffer */
    buffer: Buffer;
    scope?: "global" | "workspace";
    workspace?: string;
}

export interface InstallFromUploadResult {
    success: true;
    data: { installDir: string; name: string };
}

export async function handleInstallSkillFromUpload(
    body: InstallFromUploadBody,
): Promise<InstallFromUploadResult> {
    const { buffer, scope = "global", workspace = "default" } = body;
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error("请上传 zip 文件");
    }
    const result = await installSkillFromUpload(buffer, { scope, workspace });
    return { success: true, data: { installDir: result.installDir, name: result.name } };
}
