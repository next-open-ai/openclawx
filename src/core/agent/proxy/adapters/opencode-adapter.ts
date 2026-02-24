/**
 * OpenCode AgentProxy 适配器：使用 [@opencode-ai/sdk](https://opencode.ai/docs/zh-cn/sdk/) 对接官方 Server。
 * 支持在消息中使用 //init、//undo、//redo、//share、//help 等 TUI 常见指令。
 *
 * 认证：SDK 文档未要求 Basic Auth。仅当用户在配置中填写了密码（对应 opencode serve 的 OPENCODE_SERVER_PASSWORD）
 * 时，才通过自定义 fetch 注入 HTTP Basic；未填密码时直接使用 SDK 默认 fetch，无需处理 Request/duplex。
 *
 * 服务端默认模型：在启动 opencode serve 之前，在 OpenCode 配置里设置 model 即可。
 * - 全局：编辑 ~/.config/opencode/opencode.json，添加 "model": "providerID/modelID"。
 * - 当前项目：在项目根目录创建 opencode.json，添加 "model": "providerID/modelID"。
 * - 环境变量：OPENCODE_CONFIG_CONTENT='{"model":"opencode/minimax-m2.5-free"}' opencode serve
 * 并确保该 provider 已通过 /connect 或环境变量配置好 API Key。详见 https://opencode.ai/docs/config
 *
 * OpenCode Zen 免费模型（截图中的 Select model → OpenCode Zen）：
 * - 在 TUI 中 /connect → 选择 OpenCode Zen → 到 opencode.ai/auth 登录并粘贴 API Key。
 * - 在配置中设置 model 为以下之一即可作为默认模型（格式 opencode/<model-id>）：
 *   - opencode/minimax-m2.5-free  — MiniMax M2.5 Free
 *   - opencode/glm-5-free          — GLM 5 Free
 *   - opencode/kimi-k2.5-free     — Kimi K2.5 Free
 *   - opencode/big-pickle          — Big Pickle
 * 本适配器请求不传 model 时由 OpenCode 服务端使用上述配置的默认模型。详见 https://opencode.ai/docs/zen
 */
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { DesktopAgentConfig } from "../../../config/desktop-config.js";
import { ensureLocalOpencodeRunning } from "./opencode-local-runner.js";
import type {
    IAgentProxyAdapter,
    RunAgentStreamCallbacks,
} from "../types.js";

const REQUEST_TIMEOUT_MS = 120_000; // 单次请求超时（prompt 等），服务端可能等模型生成较久

/** 仅在使用自定义 fetch（带密码）时用作 Basic 认证用户名 */
const DEFAULT_SERVER_USERNAME = "opencode";

/** //help 的说明文案 */
const OPENCODE_HELP_TEXT = `**OpenCode 指令**（在消息开头输入，如 \`//init\`）

- **//init** — 分析当前项目并创建 AGENTS.md，便于 OpenCode 理解项目结构
- **//undo** — 撤销上一步修改
- **//redo** — 重做已撤销的修改
- **//share** — 分享当前会话，获取分享链接
- **//help** — 显示本说明

直接输入普通内容将作为对话发送给 OpenCode。`;

function getSelfGatewayPort(): number | null {
    const p = process.env.PORT?.trim();
    if (!p) return null;
    const n = parseInt(p, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function isLoopback(address: string): boolean {
    const a = address.toLowerCase();
    return a === "127.0.0.1" || a === "localhost" || a === "::1" || a === "::ffff:127.0.0.1";
}

export interface ResolvedOpenCodeConfig {
    baseUrl: string;
    username: string;
    password?: string;
    model: { providerID: string; modelID: string };
}

function getOpenCodeConfig(config: DesktopAgentConfig): ResolvedOpenCodeConfig | null {
    const oc = config.opencode;
    if (oc?.port == null) return null;
    const port = Number(oc.port);
    if (Number.isNaN(port) || port <= 0) return null;
    const mode = oc.mode === "local" || oc.mode === "remote" ? oc.mode : "remote";
    const address =
        mode === "local"
            ? "127.0.0.1"
            : (oc.address != null && String(oc.address).trim()) || "";
    if (mode === "remote" && !address) return null;
    const normalizedAddress = address.replace(/^https?:\/\//, "");
    const selfPort = getSelfGatewayPort();
    if (selfPort != null && port === selfPort && isLoopback(normalizedAddress)) {
        throw new Error(
            "OpenCode 地址不能指向本机当前 Gateway 端口（" +
                normalizedAddress +
                ":" +
                port +
                "），否则会造成请求死锁。"
        );
    }
    const baseUrl = `http://${normalizedAddress}:${port}`.replace(/\/$/, "");
    const username = (oc.username != null && String(oc.username).trim())
        ? String(oc.username).trim()
        : DEFAULT_SERVER_USERNAME;
    const modelStr = (oc.model != null && String(oc.model).trim())
        ? String(oc.model).trim()
        : (config.model || "opencode/default");
    const providerID = (config.provider && String(config.provider).trim()) || (modelStr.includes("/") ? modelStr.split("/")[0]!.trim() : modelStr.includes("-") ? modelStr.split("-")[0]!.trim() : "opencode");
    const modelID = modelStr.includes("/") ? modelStr.slice(modelStr.indexOf("/") + 1).trim() : modelStr;
    return {
        baseUrl,
        username,
        password: oc.password != null ? String(oc.password).trim() : undefined,
        model: { providerID, modelID: modelID || "default" },
    };
}

function buildAuthHeaders(oc: ResolvedOpenCodeConfig): Record<string, string> {
    const user = oc.username || DEFAULT_SERVER_USERNAME;
    const pass = oc.password ?? "";
    return {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
    };
}

/**
 * 在 Node/undici 下带 body 的请求需要 duplex，SDK 默认 fetch 未设置。无密码时用此 fetch 仅补 duplex。
 */
function createDuplexFetch(timeoutMs: number): typeof fetch {
    return (input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
        if (input instanceof Request) {
            const method = input.method.toUpperCase();
            const hasBody = input.body != null || ["POST", "PUT", "PATCH"].includes(method);
            const req = new Request(input.url, {
                method: input.method,
                headers: input.headers,
                body: input.body,
                mode: input.mode,
                credentials: input.credentials,
                cache: input.cache,
                redirect: input.redirect,
                referrer: input.referrer,
                integrity: input.integrity,
                signal,
                ...(hasBody && { duplex: "half" as const }),
            });
            return fetch(req);
        }
        const method = (init?.method ?? "GET").toString().toUpperCase();
        const hasBody = init?.body != null || ["POST", "PUT", "PATCH"].includes(method);
        return fetch(input, { ...init, signal, ...(hasBody && { duplex: "half" as const }) });
    };
}

/**
 * 仅当用户配置了密码时使用：创建带 HTTP Basic 的 fetch，并满足 Node/undici 对带 body 请求的 duplex 要求。
 */
function createAuthFetch(
    authHeaders: Record<string, string>,
    timeoutMs: number
): typeof fetch {
    return (input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
        if (input instanceof Request) {
            const cloned = input.clone();
            const headers = new Headers(cloned.headers);
            for (const [k, v] of Object.entries(authHeaders)) headers.set(k, v);
            const method = cloned.method.toUpperCase();
            const hasBody = cloned.body != null || ["POST", "PUT", "PATCH"].includes(method);
            const req = new Request(cloned.url, {
                method: cloned.method,
                headers,
                body: cloned.body,
                mode: cloned.mode,
                credentials: cloned.credentials,
                cache: cloned.cache,
                redirect: cloned.redirect,
                referrer: cloned.referrer,
                integrity: cloned.integrity,
                signal,
                ...(hasBody && { duplex: "half" as const }),
            });
            return fetch(req);
        }
        const headers = new Headers(init?.headers);
        for (const [k, v] of Object.entries(authHeaders)) headers.set(k, v);
        const method = (init?.method ?? "GET").toString().toUpperCase();
        const hasBody = init?.body != null || ["POST", "PUT", "PATCH"].includes(method);
        return fetch(input, { ...init, headers, signal, ...(hasBody && { duplex: "half" as const }) });
    };
}

/** 按 channel 的 sessionId 复用 OpenCode session，便于 //undo、//redo 等生效 */
const opencodeSessionCache = new Map<string, string>();

function getCachedSessionId(channelSessionId: string): string | undefined {
    return opencodeSessionCache.get(channelSessionId);
}

function setCachedSessionId(channelSessionId: string, opencodeSessionId: string): void {
    opencodeSessionCache.set(channelSessionId, opencodeSessionId);
}

/** 解析消息：若以 // 开头则返回 { command, args }，否则返回 null */
function parseSlashCommand(message: string): { command: string; args: string } | null {
    const trimmed = message.trim();
    if (!trimmed.startsWith("//")) return null;
    const rest = trimmed.slice(2).trim();
    const space = rest.indexOf(" ");
    const command = space >= 0 ? rest.slice(0, space).toLowerCase() : rest.toLowerCase();
    const args = space >= 0 ? rest.slice(space + 1).trim() : "";
    return command ? { command, args } : null;
}

/** 从 session.prompt / session.command 返回的 parts 提取文本 */
function partsToText(parts: Array<{ type?: string; text?: string; content?: string }> | undefined): string {
    if (!Array.isArray(parts)) return "";
    return parts
        .map((p) => (typeof p?.text === "string" ? p.text : typeof p?.content === "string" ? p.content : ""))
        .filter(Boolean)
        .join("");
}

/** 日志用：可序列化对象，避免循环引用、过长字符串和不可序列化字段 */
function safeForLog(obj: unknown, maxStrLen = 2000): unknown {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== "object") {
        const s = String(obj);
        return s.length > maxStrLen ? s.slice(0, maxStrLen) + "…" : s;
    }
    if (Array.isArray(obj)) return obj.map((v) => safeForLog(v, maxStrLen));
    const seen = new WeakSet();
    function toPlain(o: any): any {
        if (o === null || o === undefined) return o;
        if (typeof o !== "object") return typeof o === "string" && o.length > maxStrLen ? o.slice(0, maxStrLen) + "…" : o;
        if (seen.has(o)) return "[Circular]";
        seen.add(o);
        if (typeof o.toJSON === "function") return toPlain(o.toJSON());
        if (Array.isArray(o)) return o.map(toPlain);
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(o)) {
            try {
                out[k] = toPlain(o[k]);
            } catch {
                out[k] = "[?]";
            }
        }
        return out;
    }
    return toPlain(obj);
}

/** 打印 SDK 接口的完整返回，便于排查 */
function logSdkResponse(api: string, res: unknown): void {
    console.log(`[OpenCode] SDK ${api} 返回:`, JSON.stringify(safeForLog(res), null, 2));
}

/** 从多种可能的 API 响应结构中取出 parts 或纯文本 */
function extractPartsOrText(res: unknown): string {
    const data = (res as any)?.data ?? res;
    if (!data) return "";
    const parts = data?.info?.parts ?? data?.parts;
    if (Array.isArray(parts)) return partsToText(parts);
    if (typeof data?.content === "string") return data.content;
    if (typeof data?.text === "string") return data.text;
    if (typeof data?.message === "string") return data.message;
    return "";
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;

/**
 * 服务端 POST /session/{id}/message 返回 204，助手回复异步生成。轮询 session.messages() 取最新 assistant 消息的文本。
 */
async function pollForAssistantMessage(
    session: { messages: (opts: { path: { id: string } }) => Promise<unknown> },
    sessionId: string,
): Promise<string> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let lastListRes: unknown;
    let pollCount = 0;
    while (Date.now() < deadline) {
        pollCount++;
        const listRes = await session.messages({ path: { id: sessionId } });
        lastListRes = listRes;
        if (pollCount === 1) logSdkResponse("session.messages(poll, first)", listRes);
        const list = (listRes as any)?.data ?? listRes;
        if (!Array.isArray(list) || list.length === 0) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            continue;
        }
        type Item = { info?: { role?: string; parts?: Array<{ type?: string; text?: string; content?: string }> }; parts?: Array<{ type?: string; text?: string; content?: string }> };
        // 找最后一条 user 的位置，只认「在它之后出现的 assistant」为本轮回复（避免并发多轮时拿错）
        let lastUserIndex = -1;
        for (let i = list.length - 1; i >= 0; i--) {
            if ((list[i] as Item)?.info?.role === "user") {
                lastUserIndex = i;
                break;
            }
        }
        for (let i = lastUserIndex + 1; i < list.length; i++) {
            const item = list[i] as Item;
            if (item?.info?.role !== "assistant") continue;
            const parts = item?.info?.parts ?? item?.parts;
            if (!Array.isArray(parts)) continue;
            const text = partsToText(parts);
            if (text) return text;
            // 已有 assistant 但 parts 为空，可能仍在生成，继续轮询
            break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    console.log("[OpenCode] session.messages(poll) 超时，最后一次返回:", JSON.stringify(safeForLog(lastListRes)));
    return "";
}

export const opencodeAdapter: IAgentProxyAdapter = {
    type: "opencode",

    async runStream(options, config, callbacks): Promise<void> {
        const oc = getOpenCodeConfig(config);
        if (!oc) {
            throw new Error("OpenCode adapter: missing opencode.port or (remote 模式下缺少 address) in agent config");
        }
        if (config.opencode?.mode === "local" && config.opencode.port != null) {
            await ensureLocalOpencodeRunning(
                Number(config.opencode.port),
                config.opencode.model?.trim() || undefined,
                config.opencode.workingDirectory?.trim() || undefined
            );
        }

        const hasPassword = Boolean(oc.password?.trim());
        const fetchImpl = hasPassword
            ? (createAuthFetch(buildAuthHeaders(oc), REQUEST_TIMEOUT_MS) as any)
            : createDuplexFetch(REQUEST_TIMEOUT_MS);
        const client = createOpencodeClient({
            baseUrl: oc.baseUrl,
            fetch: fetchImpl,
            throwOnError: true,
        });

        const channelSessionId = options.sessionId;
        let sessionId = getCachedSessionId(channelSessionId);

        const ensureSession = async (): Promise<string> => {
            if (sessionId) return sessionId;
            const createRes = await client.session.create({ body: {} });
            logSdkResponse("session.create", createRes);
            const id = (createRes as any).data?.id ?? (createRes as any).id;
            if (typeof id !== "string" || !id) throw new Error("OpenCode 创建 Session 失败：返回缺少 id");
            sessionId = id;
            setCachedSessionId(channelSessionId, sessionId);
            return sessionId;
        };

        const slash = parseSlashCommand(options.message);

        try {
            if (slash) {
                const { command, args } = slash;
                await ensureSession();

                if (command === "help") {
                    if (OPENCODE_HELP_TEXT) callbacks.onChunk(OPENCODE_HELP_TEXT);
                    callbacks.onDone();
                    return;
                }

                if (command === "init") {
                    const initRes = await (client.session as any).init({
                        path: { id: sessionId },
                        body: {}, // 使用 OpenCode 服务端默认模型
                    });
                    logSdkResponse("session.init", initRes);
                    const msg = "已初始化项目并生成 AGENTS.md。OpenCode 已分析当前项目结构。";
                    if (msg) callbacks.onChunk(msg);
                    callbacks.onDone();
                    return;
                }

                if (command === "undo" || command === "redo") {
                    const cmdRes = await (client.session as any).command({
                        path: { id: sessionId },
                        body: { command, arguments: args || "" }, // 不传 model，用服务端默认
                    });
                    logSdkResponse("session.command(undo/redo)", cmdRes);
                    const text = extractPartsOrText(cmdRes) || "已执行。";
                    callbacks.onChunk(text);
                    callbacks.onDone();
                    return;
                }

                if (command === "share") {
                    const shareRes = await (client.session as any).share({ path: { id: sessionId } });
                    logSdkResponse("session.share", shareRes);
                    const data = (shareRes as any).data ?? shareRes;
                    const url = data?.shareURL ?? data?.shareUrl ?? data?.url ?? "";
                    const msg = url ? `分享链接：${url}` : "分享完成（请查看 OpenCode 返回的链接）。";
                    if (msg) callbacks.onChunk(msg);
                    callbacks.onDone();
                    return;
                }

                // 其他未单独处理的 //xxx 当作普通指令发给 OpenCode command
                const cmdRes = await (client.session as any).command({
                    path: { id: sessionId },
                    body: { command, arguments: args || "" }, // 不传 model，用服务端默认
                });
                logSdkResponse("session.command(//xxx)", cmdRes);
                const text = extractPartsOrText(cmdRes) || "已执行。";
                callbacks.onChunk(text);
                callbacks.onDone();
                return;
            }

            // 普通对话：服务端可能返回 204/关闭连接或长时间不返回，需在失败/超时时 fallback 到轮询
            sessionId = await ensureSession();
            let text = "";
            try {
                const promptRes = await (client.session as any).prompt({
                    path: { id: sessionId },
                    body: { parts: [{ type: "text", text: options.message }] }, // 不传 model，用 OpenCode 服务端默认
                });
                logSdkResponse("session.prompt", promptRes);
                text = extractPartsOrText(promptRes);
            } catch (promptErr: unknown) {
                const msg = promptErr instanceof Error ? promptErr.message : String(promptErr);
                const cause = promptErr instanceof Error ? (promptErr as Error & { cause?: { code?: string } })?.cause : undefined;
                const isClosedOrTimeout =
                    msg.includes("fetch failed") ||
                    msg.includes("other side closed") ||
                    msg.includes("aborted due to timeout") ||
                    msg.includes("TimeoutError") ||
                    cause?.code === "UND_ERR_SOCKET";
                if (isClosedOrTimeout) {
                    console.warn("[OpenCode] session.prompt 请求被关闭或超时，改为轮询 messages 获取回复:", msg);
                    text = await pollForAssistantMessage(client.session as any, sessionId);
                } else {
                    throw promptErr;
                }
            }
            if (!text) {
                text = await pollForAssistantMessage(client.session as any, sessionId);
            }
            callbacks.onChunk(text || "（暂无回复或请求超时）");
            callbacks.onDone();
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[OpenCode] error: ${msg}`);
            throw e;
        }
    },

    async runCollect(options, config): Promise<string> {
        const oc = getOpenCodeConfig(config);
        if (!oc) {
            throw new Error("OpenCode adapter: missing opencode.port or (remote 模式下缺少 address) in agent config");
        }
        if (config.opencode?.mode === "local" && config.opencode.port != null) {
            await ensureLocalOpencodeRunning(
                Number(config.opencode.port),
                config.opencode.model?.trim() || undefined,
                config.opencode.workingDirectory?.trim() || undefined
            );
        }

        const hasPassword = oc.password != null && String(oc.password).trim() !== "";
        const client = createOpencodeClient({
            baseUrl: oc.baseUrl,
            ...(hasPassword
                ? { fetch: createAuthFetch(buildAuthHeaders(oc), REQUEST_TIMEOUT_MS) as any }
                : {}),
            throwOnError: true,
        });

        const channelSessionId = options.sessionId;
        let sessionId = getCachedSessionId(channelSessionId);

        const ensureSession = async (): Promise<string> => {
            if (sessionId) return sessionId;
            const createRes = await client.session.create({ body: {} });
            logSdkResponse("session.create", createRes);
            const id = (createRes as any).data?.id ?? (createRes as any).id;
            if (typeof id !== "string" || !id) throw new Error("OpenCode 创建 Session 失败：返回缺少 id");
            sessionId = id;
            setCachedSessionId(channelSessionId, sessionId);
            return sessionId;
        };

        const slash = parseSlashCommand(options.message);

        if (slash) {
            const { command, args } = slash;
            await ensureSession();

            if (command === "help") return OPENCODE_HELP_TEXT.trim();

            if (command === "init") {
                const initRes = await (client.session as any).init({
                    path: { id: sessionId },
                    body: {}, // 使用 OpenCode 服务端默认模型
                });
                logSdkResponse("session.init (runCollect)", initRes);
                return "已初始化项目并生成 AGENTS.md。";
            }

            if (command === "undo" || command === "redo") {
                const cmdRes = await (client.session as any).command({
                    path: { id: sessionId },
                    body: { command, arguments: args || "" }, // 不传 model，用服务端默认
                });
                logSdkResponse("session.command(undo/redo) runCollect", cmdRes);
                const data = (cmdRes as any).data ?? cmdRes;
                return partsToText(data?.parts).trim() || "(无文本回复)";
            }

            if (command === "share") {
                const shareRes = await (client.session as any).share({ path: { id: sessionId } });
                logSdkResponse("session.share (runCollect)", shareRes);
                const data = (shareRes as any).data ?? shareRes;
                const url = data?.shareURL ?? data?.shareUrl ?? data?.url ?? "";
                return url ? `分享链接：${url}` : "分享完成。";
            }

            const cmdRes = await (client.session as any).command({
                path: { id: sessionId },
                body: { command, arguments: args || "" }, // 不传 model，用服务端默认
            });
            logSdkResponse("session.command(//xxx) runCollect", cmdRes);
            const data = (cmdRes as any).data ?? cmdRes;
            return partsToText(data?.parts).trim() || "(无文本回复)";
        }

        sessionId = await ensureSession();
        let text = "";
        try {
            const promptRes = await (client.session as any).prompt({
                path: { id: sessionId },
                body: { parts: [{ type: "text", text: options.message }] }, // 不传 model，用 OpenCode 服务端默认
            });
            logSdkResponse("session.prompt (runCollect)", promptRes);
            text = extractPartsOrText(promptRes);
        } catch (promptErr: unknown) {
            const msg = promptErr instanceof Error ? promptErr.message : String(promptErr);
            const cause = promptErr instanceof Error ? (promptErr as Error & { cause?: { code?: string } })?.cause : undefined;
            const isClosedOrTimeout =
                msg.includes("fetch failed") ||
                msg.includes("other side closed") ||
                msg.includes("aborted due to timeout") ||
                msg.includes("TimeoutError") ||
                cause?.code === "UND_ERR_SOCKET";
            if (isClosedOrTimeout) {
                console.warn("[OpenCode] session.prompt (runCollect) 被关闭或超时，改为轮询:", msg);
                text = await pollForAssistantMessage(client.session as any, sessionId);
            } else {
                throw promptErr;
            }
        }
        if (!text) text = await pollForAssistantMessage(client.session as any, sessionId);
        return text.trim() || "(无文本回复或请求超时)";
    },
};
