/**
 * local-llm-server 入口。
 *
 * 两种运行模式：
 * 1. 子进程模式（--child）：直接加载模型并启动 HTTP 服务，由主进程 fork 调用。
 * 2. 主进程模式（默认导出）：fork 子进程，管理其生命周期，提供 baseUrl 给调用方。
 *
 * 主进程通过 startLocalLlmServer() 启动，返回 { baseUrl, stop }。
 * 子进程就绪后通过 IPC 发送 { type: "ready" } 通知主进程。
 */

import { fileURLToPath } from "node:url";

// ─── 子进程模式 ───────────────────────────────────────────────────────────────

async function runChildProcess(): Promise<void> {
    const port = parseInt(process.env.LOCAL_LLM_PORT ?? "11435", 10);
    const llmModelPath = process.env.LOCAL_LLM_MODEL ?? "hf:Qwen/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf";
    const embModelPath = process.env.LOCAL_EMB_MODEL ?? "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
    const contextSize = process.env.LOCAL_LLM_CONTEXT_SIZE != null ? parseInt(process.env.LOCAL_LLM_CONTEXT_SIZE, 10) : undefined;

    const { initModels } = await import("./llm-context.js");
    const { createOpenAICompatServer } = await import("./server.js");

    try {
        await initModels({ llmModelPath, embeddingModelPath: embModelPath, contextSize: contextSize ?? 32768 });
        await createOpenAICompatServer(port);
        // 通知主进程已就绪
        if (process.send) {
            process.send({ type: "ready", port });
        }
    } catch (e) {
        console.error("[local-llm] 子进程启动失败:", e);
        if (process.send) {
            process.send({ type: "error", message: String(e) });
        }
        process.exit(1);
    }
}

// ─── 主进程模式 ───────────────────────────────────────────────────────────────

export interface LocalLlmServerOptions {
    port?: number;
    llmModelPath?: string;
    embeddingModelPath?: string;
    /** 上下文窗口 token 数，默认 32768（32K），需能容纳 system + tools + 对话 */
    contextSize?: number;
    /** 等待子进程就绪的超时毫秒数，默认 300000（5 分钟，冷启/大模型加载可能较慢） */
    readyTimeoutMs?: number;
}

export interface LocalLlmServerHandle {
    baseUrl: string;
    stop: () => void;
}

let serverHandle: LocalLlmServerHandle | null = null;

/**
 * 停止本地 LLM 子进程服务（若正在运行）。用于切换模型前先停止再启动。
 */
export function stopLocalLlmServer(): void {
    if (serverHandle) {
        serverHandle.stop();
        serverHandle = null;
    }
}

/**
 * 启动本地 LLM 子进程服务。
 * 已启动时直接返回已有 handle（单例）。需先 stop 再传新参数重启。
 */
export async function startLocalLlmServer(
    opts: LocalLlmServerOptions = {},
): Promise<LocalLlmServerHandle> {
    if (serverHandle) return serverHandle;

    const { fork } = await import("node:child_process");
    const port = opts.port ?? 11435;
    const readyTimeoutMs = opts.readyTimeoutMs ?? 300_000;

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        LOCAL_LLM_PORT: String(port),
        LOCAL_LLM_CHILD: "1",
    };
    if (opts.llmModelPath) env.LOCAL_LLM_MODEL = opts.llmModelPath;
    if (opts.embeddingModelPath) env.LOCAL_EMB_MODEL = opts.embeddingModelPath;
    if (opts.contextSize != null) env.LOCAL_LLM_CONTEXT_SIZE = String(opts.contextSize);

    const childPath = fileURLToPath(import.meta.url);

    const child = fork(childPath, ["--child"], {
        env,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        execArgv: [],
    });

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`[local-llm] 子进程启动超时（${readyTimeoutMs}ms）`));
        }, readyTimeoutMs);

        child.on("message", (msg: any) => {
            if (msg?.type === "ready") {
                clearTimeout(timer);
                resolve();
            } else if (msg?.type === "error") {
                clearTimeout(timer);
                reject(new Error(`[local-llm] 子进程错误: ${msg.message}`));
            }
        });

        child.on("exit", (code) => {
            clearTimeout(timer);
            if (code !== 0) reject(new Error(`[local-llm] 子进程意外退出，code=${code}`));
        });

        child.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
    });

    // 主进程退出时清理子进程
    const cleanup = () => { try { child.kill(); } catch { /* ignore */ } };
    process.on("exit", cleanup);
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    serverHandle = {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        stop: () => {
            serverHandle = null;
            try { child.kill(); } catch { /* ignore */ }
        },
    };

    console.log(`[local-llm] 本地服务就绪: ${serverHandle.baseUrl}`);
    return serverHandle;
}

// ─── 入口判断 ─────────────────────────────────────────────────────────────────

// 子进程模式：被 fork 时带 --child 参数或设置了 LOCAL_LLM_CHILD 环境变量
if (process.argv.includes("--child") || process.env.LOCAL_LLM_CHILD === "1") {
    runChildProcess().catch((e) => {
        console.error("[local-llm] 致命错误:", e);
        process.exit(1);
    });
}
