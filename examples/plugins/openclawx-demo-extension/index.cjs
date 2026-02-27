/**
 * OpenClawX Demo Extension
 *
 * 默认导出一个函数 (pi) => void，通过 pi.registerTool 注册 demo_echo 工具。
 * 安装方式：openbot extension install ./examples/plugins/openclawx-demo-extension
 * 或发布到 npm 后：openbot extension install openclawx-demo-extension
 */
function demoExtension(pi) {
    pi.registerTool({
        name: "demo_echo",
        label: "Demo Echo",
        description: "回显传入的文本，用于验证扩展已加载。",
        parameters: {
            type: "object",
            properties: {
                text: { type: "string", description: "要回显的文本" },
            },
            required: ["text"],
        },
        execute: async (_toolCallId, params) => {
            const text = (params && params.text) || "";
            return {
                content: [{ type: "text", text: `[demo_echo] ${text}` }],
                details: { echoed: text },
            };
        },
    });
}

module.exports = demoExtension;
