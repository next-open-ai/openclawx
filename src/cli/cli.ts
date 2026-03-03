#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { getOpenbotAgentDir } from "../core/agent/agent-dir.js";
import { run } from "../core/agent/run.js";
import {
    loadDesktopAgentConfig,
    getBoundAgentIdForCli,
    setProviderApiKey,
    setDefaultModel,
    getDesktopConfigList,
    syncDesktopConfigToModelsJson,
    ensureDesktopConfigInitialized,
} from "../core/config/desktop-config.js";
import {
    downloadModel,
    DEFAULT_LLM_MODEL_URI,
} from "../core/local-llm-server/download-model.js";
import {
    startLocalLlmServer,
    stopLocalLlmServer,
} from "../core/local-llm-server/index.js";
import {
    LOCAL_LLM_CACHE_DIR,
    isModelFileInCache,
    toModelPathForStart,
} from "../core/local-llm-server/model-resolve.js";
import {
    writeGatewayPid,
    removeGatewayPidFile,
    serviceInstall,
    serviceUninstall,
    serviceStop,
} from "./service.js";
import { installExtension, listExtensions, uninstallExtension } from "./extension-cmd.js";

const require = createRequire(import.meta.url);
const PKG = require("../../package.json") as { version: string };

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");

async function runAction(
    positionalPrompt: string | undefined,
    opts: {
        skillPath?: string[];
        prompt?: string;
        dryRun?: boolean;
        model?: string;
        provider?: string;
        agentDir?: string;
        agent?: string;
        apiKey?: string;
        timing?: boolean;
        maxToolTurns?: number;
    },
): Promise<void> {
    const skillPaths = opts.skillPath || [];
    const agentId = (opts.agent && String(opts.agent).trim()) || (await getBoundAgentIdForCli());
    const prompt = (opts.prompt ?? positionalPrompt ?? "").trim();

    if (!prompt) {
        console.error("Error: 请提供提示词（位置参数或 --prompt）");
        process.exit(1);
    }

    console.error(`[openbot] Using agent: ${agentId}${!opts.agent ? " (default from config)" : ""}`);

    const needDesktop =
        opts.apiKey === undefined || opts.provider === undefined || opts.model === undefined;
    const desktopConfig = needDesktop ? await loadDesktopAgentConfig(agentId) : null;
    const provider = opts.provider ?? desktopConfig?.provider ?? "deepseek";
    const model = opts.model ?? desktopConfig?.model ?? "deepseek-chat";
    const apiKey =
        opts.apiKey ?? process.env.OPENAI_API_KEY ?? desktopConfig?.apiKey ?? "";
    if (desktopConfig && (desktopConfig.provider || desktopConfig.model)) {
        console.error(`[openbot] Using model: ${provider}/${model} (from desktop config)`);
    }
    if (opts.timing) process.env.OPENBOT_TIMING = "1";

    const workspaceName = desktopConfig?.workspace ?? agentId;
    try {
        const result = await run({
            workspace: workspaceName,
            skillPaths,
            userPrompt: prompt,
            dryRun: opts.dryRun ?? false,
            model,
            provider,
            agentDir: opts.agentDir ?? getOpenbotAgentDir(),
            apiKey: apiKey || undefined,
        });

        if (result.dryRun) {
            console.log("=== System prompt (skills) ===");
            console.log(result.systemPrompt);
            console.log("\n=== User prompt ===");
            console.log(result.userPrompt);
            console.log("\n(dry-run: 未调用 LLM，设置 OPENAI_API_KEY 可实际调用)");
            return;
        }
        // Content is already streamed by run()
        if (
            !result.dryRun &&
            (result.assistantContent === undefined || result.assistantContent === "")
        ) {
            console.warn(
                "（模型返回为空；若此前有工具调用提示，说明当前为单轮模式，模型会基于技能描述直接以文本回答。）",
            );
        }
    } catch (err: unknown) {
        console.error(err);
        process.exit(1);
    }
}

const program = new Command();

program
    .name("openbot")
    .description("CLI to run prompts with skill paths (Agent Skills style)")
    .version(PKG.version, "-v, --version", "显示版本号")
    .option(
        "-s, --skill-path <paths...>",
        "Additional skill paths to load",
    )
    .option("-a, --agent <id>", "指定智能体 ID，不传则使用桌面配置中的缺省智能体")
    .option("-p, --prompt <text>", "用户提示词（与位置参数二选一）")
    .option("--dry-run", "只输出组装的 system/user 内容，不调用 LLM")
    .option("--model <id>", "模型 ID", "deepseek-chat")
    .option(
        "--provider <name>",
        "Provider（pi ModelRegistry）；可选 deepseek、dashscope、openai",
        "deepseek",
    )
    .option(
        "--agent-dir <path>",
        "Agent 配置目录（默认 ~/.openbot/agent）",
        getOpenbotAgentDir(),
    )
    .option("--api-key <key>", "API Key（不传则使用环境变量 OPENAI_API_KEY）")
    .option("--timing", "打印每轮 LLM 与 tool 耗时到 stderr")
    .option(
        "--max-tool-turns <n>",
        "最大工具调用轮数（默认 30）；可设环境变量 OPENBOT_MAX_TOOL_TURNS",
        (v: string) => parseInt(v, 10) || 0,
        0,
    )
    .argument("[prompt]", "用户提示词（与 --prompt 二选一）")
    .action(async (positionalPrompt: string | undefined) => {
        await runAction(positionalPrompt, program.opts());
    });

program.addHelpText(
    "after",
    `
Environment:
  DEEPSEEK_API_KEY          默认 provider 为 deepseek 时使用；不设时回退 OPENAI_API_KEY
  OPENAI_API_KEY            通用 API Key（可被 --api-key 覆盖）
  DASHSCOPE_API_KEY         provider=dashscope 时使用；不设时回退 OPENAI_API_KEY
  OPENAI_BASE_URL           可选，在 pi 未找到模型时使用的 endpoint
  OPENBOT_AGENT_DIR         缺省 agent 目录（默认 ~/.openbot/agent）
  OPENBOT_TIMING=1          等同 --timing
  OPENBOT_ALLOW_RUN_CODE    缺省 1（启用 run_python）；设为 0 关闭
  OPENBOT_MAX_TOOL_TURNS    最大工具轮数（默认 30）

Examples:
  openbot "总结一下当前有哪些技能"
  openbot -a my-agent "总结一下当前有哪些技能"  使用指定智能体
  openbot -s ./skills "总结一下当前有哪些技能"
  openbot -s ./my-skills --prompt "用 weather 技能查北京天气" --dry-run
`,
);

// Gateway server command
program
    .command("gateway")
    .description("Start WebSocket gateway server")
    .option("-p, --port <port>", "Port to listen on", "38080")
    .action(async (options) => {
        const port = parseInt(options.port, 10);
        if (isNaN(port) || port <= 0 || port > 65535) {
            console.error("Error: Invalid port number");
            process.exit(1);
        }

        writeGatewayPid();
        const { startGatewayServer } = await import("../gateway/index.js");
        const { close } = await startGatewayServer(port);

        const shutdown = async () => {
            console.log("\nShutting down...");
            removeGatewayPidFile();
            await close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    });

// Service: 开机自启 install / uninstall，以及 stop
const serviceCmd = program
    .command("service")
    .description("Gateway 开机/登录自启与停止（Linux cron、macOS LaunchAgent、Windows 计划任务）");

serviceCmd
    .command("install")
    .description("添加开机/登录自启：下次重启或登录后自动启动 gateway")
    .action(() => {
        const nodePath = process.execPath;
        const cliPath = join(__dirname, "cli.js");
        serviceInstall({ nodePath, cliPath });
    });

serviceCmd
    .command("uninstall")
    .description("移除开机/登录自启")
    .action(() => {
        serviceUninstall();
    });

serviceCmd
    .command("stop")
    .description("停止当前运行的 gateway 进程")
    .action(() => {
        serviceStop();
    });

// Login command（写入桌面 config；可选 model，不传则取该 provider 第一个模型，补齐后可直接运行）
program
    .command("login")
    .description("Save API key for a provider to desktop config (~/.openbot/desktop); optional model, default first model")
    .argument("<provider>", "Provider name (e.g., deepseek, dashscope, openai)")
    .argument("<apiKey>", "API Key")
    .argument("[model]", "Model ID (optional; default: first model for provider)")
    .action(async (provider, apiKey, model?: string) => {
        await setProviderApiKey(provider, apiKey, model);
        console.log(`[openbot] API key saved for provider: ${provider}`);
    });

// Config command
const configCmd = program.command("config").description("Manage configurations");

configCmd
    .command("set-model")
    .description("Set default provider and model in desktop config (~/.openbot/desktop)")
    .argument("<provider>", "Provider name")
    .argument("<modelId>", "Model ID")
    .action(async (provider, modelId) => {
        await setDefaultModel(provider, modelId);
        console.log(`[openbot] Default model set: ${provider}/${modelId}`);
    });

configCmd
    .command("list")
    .description("List desktop config (centralized config source)")
    .action(async () => {
        const list = await getDesktopConfigList();
        if (list.providers.length === 0) {
            console.log("No providers in desktop config. Run: openbot login <provider> <apiKey>");
            return;
        }
        console.log(`Default: ${list.defaultProvider} / ${list.defaultModel}\n`);
        console.table(
            list.providers.map((r) => ({
                Provider: r.provider,
                "Default Model": r.defaultModel,
                "API Key": r.hasKey ? "✅" : "❌",
            }))
        );
    });

configCmd
    .command("sync")
    .description("Sync desktop config to ~/.openbot/agent/models.json for pi-agent")
    .action(async () => {
        await syncDesktopConfigToModelsJson();
        console.log("[openbot] Synced desktop providers to agent models.json");
    });

// Extension: 在 ~/.openbot/plugins 下通过 npm 包安装/列出/卸载扩展，Server 运行时从该目录加载
const extensionCmd = program
    .command("extension")
    .description("Install, list, or uninstall extensions (npm packages in ~/.openbot/plugins)");

extensionCmd
    .command("install <pkg>")
    .description("Install an extension package (e.g. openbot extension install my-extension)")
    .action((pkg: string) => {
        installExtension(pkg);
    });

extensionCmd
    .command("list")
    .description("List installed extensions")
    .action(() => {
        const list = listExtensions();
        if (list.length === 0) {
            console.log("No extensions installed. Run: openbot extension install <package>");
            return;
        }
        console.log("Installed extensions:\n");
        console.table(list.map((r) => ({ Package: r.name, Spec: r.spec })));
    });

extensionCmd
    .command("uninstall <pkg>")
    .description("Uninstall an extension package")
    .action((pkg: string) => {
        uninstallExtension(pkg);
    });

// 本地模型：下载与启动服务
const localCmd = program
    .command("local")
    .description("下载本地 GGUF 模型与启动本地 LLM 服务");

localCmd
    .command("download")
    .description("下载推荐模型到 ~/.openbot/.cached_models/，不指定模型时下载 Qwen 3.5 4B")
    .argument("[modelUri]", "模型 URI（如 hf:unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q5_K_M.gguf），不传则下载 Qwen 3.5 4B")
    .option("--mirror", "使用国内镜像 hf-mirror.com 下载")
    .action(async (modelUri: string | undefined, opts: { mirror?: boolean }) => {
        const uri = (modelUri || "").trim() || DEFAULT_LLM_MODEL_URI;
        console.log(`[openbot] 下载模型: ${uri}`);
        if (opts.mirror) console.log("[openbot] 使用国内镜像 hf-mirror.com");
        try {
            const path = await downloadModel(uri, {
                useMirror: opts.mirror,
                onProgress: (p) => {
                    const percent = p.totalSize ? Math.round((p.downloadedSize / p.totalSize) * 100) : (p.percent ?? 0);
                    const mb = (p.downloadedSize / 1024 / 1024).toFixed(1);
                    const totalMb = p.totalSize ? (p.totalSize / 1024 / 1024).toFixed(1) : "?";
                    process.stderr.write(`\r[openbot] 下载中 ${percent}% (${mb} / ${totalMb} MB)`);
                },
            });
            console.log(`\n[openbot] 已保存: ${path}`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("\n[openbot] 下载失败:", msg);
            process.exit(1);
        }
    });

localCmd
    .command("start")
    .description("启动本地 LLM 服务（至少指定 --llm 或 --embedding 之一）")
    .option("--llm <uriOrFile>", "LLM 模型：hf: URI 或已下载文件名，不传则使用桌面缺省模型")
    .option("--embedding <uriOrFile>", "Embedding 模型：hf: URI 或已下载文件名（可选）")
    .option("--context-size <n>", "上下文长度（token 数），默认 32768 或环境变量 LOCAL_LLM_CONTEXT_MAX", (v: string) => parseInt(v, 10) || 32768)
    .option("--port <port>", "服务端口", "11435")
    .action(async (opts: { llm?: string; embedding?: string; contextSize?: number; port?: string }) => {
        let llmPath: string | undefined;
        let embPath: string | undefined;
        if (opts.llm?.trim()) {
            const llmArg = opts.llm.trim();
            if (!llmArg.startsWith("hf:") && !isModelFileInCache(llmArg, LOCAL_LLM_CACHE_DIR)) {
                console.error("[openbot] 模型未下载或路径不存在，请先执行: openbot local download [modelUri]");
                process.exit(1);
            }
            llmPath = toModelPathForStart(llmArg, LOCAL_LLM_CACHE_DIR);
        } else {
            const agentConfig = await loadDesktopAgentConfig("default");
            const defaultModel = agentConfig?.model?.trim();
            if (defaultModel) {
                llmPath = toModelPathForStart(defaultModel, LOCAL_LLM_CACHE_DIR);
                if (!isModelFileInCache(defaultModel, LOCAL_LLM_CACHE_DIR)) {
                    console.error("[openbot] 缺省模型未下载，请先执行: openbot local download");
                    process.exit(1);
                }
            }
        }
        if (opts.embedding?.trim()) {
            const embArg = opts.embedding.trim();
            if (!embArg.startsWith("hf:") && !isModelFileInCache(embArg, LOCAL_LLM_CACHE_DIR)) {
                console.error("[openbot] Embedding 模型未下载或路径不存在，请先执行: openbot local download <embedding-uri>");
                process.exit(1);
            }
            embPath = toModelPathForStart(embArg, LOCAL_LLM_CACHE_DIR);
        }
        if (!llmPath && !embPath) {
            console.error("[openbot] 请至少指定 --llm 或 --embedding，或先配置桌面缺省模型");
            process.exit(1);
        }
        const contextSize =
            opts.contextSize ??
            (process.env.LOCAL_LLM_CONTEXT_MAX ? parseInt(process.env.LOCAL_LLM_CONTEXT_MAX, 10) : undefined) ??
            32768;
        const port = parseInt(opts.port || "11435", 10);
        try {
            const handle = await startLocalLlmServer({
                port,
                llmModelPath: llmPath,
                embeddingModelPath: embPath,
                contextSize,
            });
            console.log(`[openbot] 本地模型服务已启动: ${handle.baseUrl}`);
            console.log("[openbot] 按 Ctrl+C 停止服务");
            await new Promise<void>((resolve) => {
                process.on("SIGINT", () => {
                    stopLocalLlmServer();
                    resolve();
                });
                process.on("SIGTERM", () => {
                    stopLocalLlmServer();
                    resolve();
                });
            });
            process.exit(0);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[openbot] 启动失败:", msg);
            process.exit(1);
        }
    });

(async () => {
    await ensureDesktopConfigInitialized();
    await program.parseAsync(process.argv);
})().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
