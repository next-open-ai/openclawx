/**
 * 通用「按当前已保存配置启动本地模型服务」逻辑。
 * 供网关启动与 API 复用：读取默认智能体配置，尝试启动；失败只设 env 与日志，不抛错、不影响主进程。
 * LLM/Embedding 任一存在即可启动，只提示不报错。
 */
import { loadDesktopAgentConfig } from "../config/desktop-config.js";
import { startLocalLlmServer } from "./index.js";
import { resolveModelPathInCache, LOCAL_LLM_CACHE_DIR } from "./model-resolve.js";

/**
 * 按已保存的配置（默认智能体的 local 模型与上下文长度）尝试启动本地模型服务。
 * 仅当已下载的模型文件存在时才启动；不抛错；失败时设置 process.env.LOCAL_LLM_START_FAILED 并打日志。
 */
export async function tryStartLocalModelFromSavedConfig(): Promise<void> {
    try {
        const agent = await loadDesktopAgentConfig("default");
        if (!agent || agent.provider !== "local" || !agent.model?.trim()) {
            // 默认智能体未使用 local 时仅跳过启动，不设置 LOCAL_LLM_START_FAILED，避免 Ollama/openai-custom 等连接失败时被误报为「未配置本地模型」
            delete process.env.LOCAL_LLM_START_FAILED;
            console.log("[local-llm] 提示：未配置默认本地模型，跳过启动。");
            return;
        }
        const llmResolved = resolveModelPathInCache(agent.model.trim(), LOCAL_LLM_CACHE_DIR);
        if (!llmResolved) {
            process.env.LOCAL_LLM_START_FAILED =
                "缺省模型文件未下载，请先在「模型管理」中下载后点击「启动本地模型服务」";
            console.log("[local-llm] 提示：缺省模型文件未下载，跳过启动。");
            return;
        }
        const contextSize =
            process.env.LOCAL_LLM_CONTEXT_MAX != null && String(process.env.LOCAL_LLM_CONTEXT_MAX).trim() !== ""
                ? parseInt(process.env.LOCAL_LLM_CONTEXT_MAX, 10) || 32768
                : (agent.contextSize ?? 32768);
        const opts = { llmModelPath: llmResolved, contextSize };
        startLocalLlmServer(opts)
            .then((handle) => {
                process.env.LOCAL_LLM_BASE_URL = handle.baseUrl;
                delete process.env.LOCAL_LLM_START_FAILED;
                console.log("[local-llm] 已就绪:", handle.baseUrl);
            })
            .catch((e) => {
                const msg = e instanceof Error ? e.message : String(e);
                process.env.LOCAL_LLM_START_FAILED = msg;
                console.log("[local-llm] 提示：启动未成功（如模型未下载请先在「模型管理」中下载）。", msg);
            });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.env.LOCAL_LLM_START_FAILED = msg;
        console.log("[local-llm] 提示：启动时发生异常，已跳过。", msg);
    }
}
