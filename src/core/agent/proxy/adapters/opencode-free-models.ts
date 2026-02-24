/**
 * OpenCode 官方免费/推荐模型列表（OpenCode Zen 等），供配置界面下拉选择与本地/远程模式默认模型使用。
 *
 * 维护说明：
 * - 唯一维护点：本文件。前端通过 GET /config/opencode-free-models 拉取，配置界面下拉与默认模型均来源于此。
 * - 新增/下架模型：在 OPENCODE_FREE_MODELS 中增删或修改项；id 格式为 opencode/<model-id>，与 OpenCode Zen 文档一致。
 * - 详见 https://opencode.ai/docs/zen
 */
export interface OpenCodeFreeModelOption {
    /** 配置用 ID，如 opencode/minimax-m2.5-free */
    id: string;
    /** 界面展示名称 */
    label: string;
    /** 是否免费（Zen 免费额度内） */
    free?: boolean;
}

/** OpenCode Zen 等提供的免费/推荐模型，按展示顺序 */
export const OPENCODE_FREE_MODELS: OpenCodeFreeModelOption[] = [
    { id: "opencode/minimax-m2.5-free", label: "MiniMax M2.5 Free", free: true },
    { id: "opencode/glm-5-free", label: "GLM 5 Free", free: true },
    { id: "opencode/kimi-k2.5-free", label: "Kimi K2.5 Free", free: true },
    { id: "opencode/big-pickle", label: "Big Pickle", free: true },
    { id: "opencode/gpt-5-nano", label: "GPT 5 Nano", free: true },
    { id: "opencode/minimax-m2.5", label: "MiniMax M2.5" },
    { id: "opencode/glm-5", label: "GLM 5" },
    { id: "opencode/gemini-3-flash", label: "Gemini 3 Flash" },
    { id: "opencode/claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

/** 仅免费项，用于界面“免费模型”分组 */
export const OPENCODE_FREE_ONLY = OPENCODE_FREE_MODELS.filter((m) => m.free);
