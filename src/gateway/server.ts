/**
 * Gateway 单进程入口：内嵌 Nest，按 path 分流。
 * - /server-api → Nest（业务 REST）
 * - /ws → Agent 对话 WebSocket
 * - /ws/voice → 语音通道（占位）
 * - /sse → SSE（占位）
 * - /channel → 通道模块（占位）
 * - 其余 → 静态资源
 */
/* Avoid MaxListenersExceededWarning for AbortSignal (e.g. agent 多轮 tool 调用，Electron 下需尽早 patch) */
const g = globalThis as any;
const limit = 128;
function patchAddEventListener(proto: any) {
    if (!proto?.addEventListener) return;
    const add = proto.addEventListener;
    proto.addEventListener = function (this: any, type: string, listener: any, options?: any) {
        if (type === "abort") {
            try {
                if (typeof this.setMaxListeners === "function") this.setMaxListeners(limit);
            } catch (_) {}
        }
        return add.call(this, type, listener, options);
    };
}
patchAddEventListener(g.EventTarget?.prototype);
patchAddEventListener(g.AbortSignal?.prototype);

import express from "express";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { WebSocketServer } from "ws";
import { readFile, stat } from "fs/promises";
import { join, extname, dirname } from "path";
import { fileURLToPath } from "node:url";
import { existsSync } from "fs";

import { PATHS } from "./paths.js";
import { authHookServerApi, authHookChannel, authHookSse, authHookWs } from "./auth-hooks.js";
import { handleChannel } from "./channel-handler.js";
import { handleSse } from "./sse-handler.js";
import { handleVoiceUpgrade } from "./voice-handler.js";
import { handleConnection } from "./connection-handler.js";
import { handleRunScheduledTask } from "./methods/run-scheduled-task.js";
import multer from "multer";
import { handleInstallSkillFromPath } from "./methods/install-skill-from-path.js";
import { handleInstallSkillFromUpload } from "./methods/install-skill-from-upload.js";
import { setBackendBaseUrl } from "./backend-url.js";
import { ensureDesktopConfigInitialized, getChannelsConfigSync } from "../core/config/desktop-config.js";
import { createNestAppEmbedded } from "../server/bootstrap.js";
import { registerChannel, startAllChannels, stopAllChannels } from "./channel/registry.js";
import { createFeishuChannel } from "./channel/adapters/feishu.js";
import { createDingTalkChannel } from "./channel/adapters/dingtalk.js";
import { createTelegramChannel } from "./channel/adapters/telegram.js";
import { setChannelSessionPersistence } from "./channel/session-persistence.js";
import {
    setSessionCurrentAgentResolver,
    setSessionCurrentAgentUpdater,
    setAgentListProvider,
    setCreateAgentProvider,
} from "../core/session-current-agent.js";
import { AgentsService } from "../server/agents/agents.service.js";
import { AgentConfigService } from "../server/agent-config/agent-config.service.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..", "..");
/** 内嵌到 Electron 时由主进程设置 OPENBOT_STATIC_DIR，指向打包后的 renderer/dist */
const STATIC_DIR =
    process.env.OPENBOT_STATIC_DIR || join(PACKAGE_ROOT, "apps", "desktop", "renderer", "dist");

const MIME_TYPES: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
};

export async function startGatewayServer(port: number = 38080): Promise<{
    httpServer: Server;
    wss: WebSocketServer;
    port: number;
    close: () => Promise<void>;
}> {
    await ensureDesktopConfigInitialized();
    console.log(`Starting gateway server on port ${port}...`);

    setBackendBaseUrl(`http://localhost:${port}`);

    const { app: nestApp, express: nestExpress } = await createNestAppEmbedded();

    try {
        const agentsService = nestApp.get(AgentsService);
        setChannelSessionPersistence(agentsService);
        setSessionCurrentAgentResolver((sessionId) => agentsService.getSession(sessionId)?.agentId);
        setSessionCurrentAgentUpdater((sessionId, agentId) => agentsService.updateSessionAgentId(sessionId, agentId));
        const agentConfigService = nestApp.get(AgentConfigService);
        setAgentListProvider(() =>
            agentConfigService.listAgents().then((agents) => agents.map((a) => ({ id: a.id, name: a.name }))),
        );
        setCreateAgentProvider(async (params) => {
            try {
                const agent = await agentConfigService.createAgent(params);
                return { id: agent.id, name: agent.name };
            } catch (e: any) {
                const msg = e?.message ?? e?.response?.message ?? String(e);
                return { error: msg };
            }
        });
    } catch (e) {
        console.warn("[Gateway] Channel session persistence / session-agent bridge unavailable:", e);
    }

    const gatewayExpress = express();

    gatewayExpress.get(PATHS.HEALTH, (_req, res) => {
        res.status(200).json({ status: "ok", timestamp: Date.now() });
    });

    gatewayExpress.post(PATHS.RUN_SCHEDULED_TASK, async (req, res) => {
        await handleRunScheduledTask(req, res);
    });

    const uploadZip = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 10 * 1024 * 1024 },
    });

    gatewayExpress.post(`${PATHS.SERVER_API}/skills/install-from-path`, async (req, res) => {
        const body = await new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
            req.on("error", reject);
        });
        try {
            const parsed = JSON.parse(body || "{}") as { path?: string; scope?: string; workspace?: string };
            const result = await handleInstallSkillFromPath({
                path: parsed.path ?? "",
                scope: parsed.scope === "workspace" ? "workspace" : "global",
                workspace: parsed.workspace,
            });
            res.status(200).json(result);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            const code = message.includes("required") || message.includes("不存在") || message.includes("SKILL.md") || message.includes("目录名") ? 400 : 500;
            res.status(code).json({ success: false, message });
        }
    });

    gatewayExpress.post(
        `${PATHS.SERVER_API}/skills/install-from-upload`,
        authHookServerApi,
        uploadZip.single("file"),
        async (req, res) => {
            try {
                const file = (req as any).file;
                const buffer = file?.buffer;
                if (!buffer || !Buffer.isBuffer(buffer)) {
                    return res.status(400).json({ success: false, message: "请上传 zip 文件" });
                }
                const scope = (req as any).body?.scope === "workspace" ? "workspace" : "global";
                const workspace = (req as any).body?.workspace ?? "default";
                const result = await handleInstallSkillFromUpload({ buffer, scope, workspace });
                res.status(200).json(result);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                const code = message.includes("请上传") || message.includes("SKILL.md") || message.includes("目录") || message.includes("10MB") ? 400 : 500;
                res.status(code).json({ success: false, message });
            }
        },
    );

    gatewayExpress.use(PATHS.SERVER_API, authHookServerApi, nestExpress);

    gatewayExpress.use(PATHS.CHANNEL, authHookChannel, (req, res) => handleChannel(req, res));

    gatewayExpress.use(PATHS.SSE, authHookSse, (req, res) => handleSse(req, res));

    gatewayExpress.use(async (req, res) => {
        const staticDir = STATIC_DIR;
        const urlPath = req.url?.split("?")[0] || "/";
        let filePath = join(staticDir, urlPath === "/" ? "index.html" : urlPath);
        try {
            const stats = await stat(filePath);
            if (stats.isDirectory()) {
                filePath = join(filePath, "index.html");
                await stat(filePath);
            }
        } catch {
            if (req.headers.accept?.includes("text/html") && req.method === "GET") {
                filePath = join(staticDir, "index.html");
            } else {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Not Found");
                return;
            }
        }
        try {
            const content = await readFile(filePath);
            const ext = extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || "application/octet-stream";
            res.writeHead(200, { "Content-Type": contentType });
            res.end(content);
        } catch (error) {
            console.error("Static file error:", error);
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Internal Server Error");
        }
    });

    const httpServer = createServer(gatewayExpress);

    const wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (ws, req) => handleConnection(ws, req));

    httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
        const path = req.url?.split("?")[0] || "";
        if (handleVoiceUpgrade(req, socket, head)) {
            return;
        }
        const isAgentWs = path === PATHS.WS || path === "/";
        if (isAgentWs && authHookWs(req, path)) {
            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit("connection", ws, req);
            });
        } else {
            socket.destroy();
        }
    });

    const actualPort = await new Promise<number>((resolve) => {
        httpServer.listen(port, () => {
            const addr = httpServer.address();
            const p = typeof addr === "object" && addr && "port" in addr ? addr.port : port;
            console.log(`✅ Gateway server listening on ws://localhost:${p}`);
            console.log(`   Health: http://localhost:${p}${PATHS.HEALTH}`);
            console.log(`   API:    http://localhost:${p}${PATHS.SERVER_API}`);
            console.log(`   WS:     ws://localhost:${p}${PATHS.WS}`);
            resolve(p);
        });
    });

    // 通道：根据配置注册并启动（飞书 WebSocket、钉钉 Stream 等）
    const channelsConfig = getChannelsConfigSync();
    const feishuCfg = channelsConfig.feishu;
    if (feishuCfg?.enabled && feishuCfg.appId?.trim() && feishuCfg.appSecret?.trim()) {
        try {
            const feishuChannel = createFeishuChannel({
                appId: feishuCfg.appId.trim(),
                appSecret: feishuCfg.appSecret.trim(),
                defaultAgentId: feishuCfg.defaultAgentId?.trim() || "default",
            });
            registerChannel(feishuChannel);
        } catch (e) {
            console.warn("Feishu channel register failed:", e);
        }
    } else if (feishuCfg?.enabled) {
        console.warn("[Channel] Feishu is enabled but appId or appSecret is missing; skip. Check Settings → Channels.");
    }

    const dingtalkCfg = channelsConfig.dingtalk;
    if (dingtalkCfg?.enabled && dingtalkCfg.clientId?.trim() && dingtalkCfg.clientSecret?.trim()) {
        try {
            const dingtalkChannel = createDingTalkChannel({
                clientId: dingtalkCfg.clientId.trim(),
                clientSecret: dingtalkCfg.clientSecret.trim(),
                defaultAgentId: dingtalkCfg.defaultAgentId?.trim() || "default",
            });
            registerChannel(dingtalkChannel);
        } catch (e) {
            console.warn("DingTalk channel register failed:", e);
        }
    } else if (dingtalkCfg?.enabled) {
        console.warn("[Channel] DingTalk is enabled but clientId or clientSecret is missing; skip. Check Settings → Channels.");
    }

    const telegramCfg = channelsConfig.telegram;
    if (telegramCfg?.enabled && telegramCfg.botToken?.trim()) {
        try {
            const telegramChannel = createTelegramChannel({
                botToken: telegramCfg.botToken.trim(),
                defaultAgentId: telegramCfg.defaultAgentId?.trim() || "default",
            });
            registerChannel(telegramChannel);
        } catch (e) {
            console.warn("Telegram channel register failed:", e);
        }
    } else if (telegramCfg?.enabled) {
        console.warn("[Channel] Telegram is enabled but botToken is missing; skip. Check Settings → Channels.");
    }

    await startAllChannels();

    const close = async () => {
        console.log("Closing gateway server...");
        await stopAllChannels();
        await nestApp.close();
        wss.clients.forEach((c) => c.close());
        await new Promise<void>((r) => wss.close(() => r()));
        await new Promise<void>((r) => httpServer.close(() => r()));
        console.log("Gateway server closed");
    };

    return { httpServer, wss, port: actualPort, close };
}
