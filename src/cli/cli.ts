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
    writeGatewayPid,
    removeGatewayPidFile,
    serviceInstall,
    serviceUninstall,
    serviceStop,
} from "./service.js";

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

(async () => {
    await ensureDesktopConfigInitialized();
    await program.parseAsync(process.argv);
})().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
