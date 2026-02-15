import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveInstallTarget, installSkillByUrl } from "../installer/index.js";

const InstallSkillSchema = Type.Object({
    url: Type.String({
        description: "Skill 安装地址，如 GitHub 简写 owner/repo、完整 URL 或 owner/repo@skillName",
    }),
});

type InstallSkillParams = { url: string };

/**
 * 创建 install_skill 工具：通过核心 installer 安装技能，不依赖 Nest。
 * @param targetAgentId 安装目标（具体 agentId / "global"|"all" / 未传则当前/default）
 */
export function createInstallSkillTool(targetAgentId: string | undefined): ToolDefinition {
    return {
        name: "install_skill",
        label: "Install Skill",
        description:
            "将指定地址的技能安装到当前智能体工作区目录。在 OpenBot 中为用户安装技能时，" +
            "应使用本工具而非 npx skills add，以保证安装到当前智能体对应的技能目录。",
        parameters: InstallSkillSchema,
        execute: async (
            _toolCallId: string,
            params: InstallSkillParams,
            _signal: AbortSignal | undefined,
            _onUpdate: any,
            _ctx: any,
        ) => {
            const url = (params.url ?? "").trim();
            if (!url) {
                return {
                    content: [{ type: "text" as const, text: "请提供技能安装地址（如 owner/repo 或 owner/repo@skillName）。" }],
                    details: undefined,
                };
            }
            try {
                const target = await resolveInstallTarget(targetAgentId);
                const result = await installSkillByUrl(url, {
                    scope: target.scope,
                    workspace: target.workspace,
                });
                const out = result.stdout?.trim() ?? "";
                const err = result.stderr?.trim() ?? "";
                const installDir = result.installDir;
                const dirLine = installDir ? `\n安装目录：${installDir}` : "";
                const baseText = out || (err ? `安装完成。\n${err}` : "技能已安装完成。");
                const text = dirLine ? `${baseText}${dirLine}` : baseText;
                return {
                    content: [{ type: "text" as const, text }],
                    details: { stdout: result.stdout, stderr: result.stderr, installDir: result.installDir },
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `安装失败: ${msg}` }],
                    details: undefined,
                };
            }
        },
    };
}
