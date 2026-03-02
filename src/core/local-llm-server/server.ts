/**
 * OpenAI 兼容 HTTP 服务（严格对齐 [OpenAI Chat Completions / Embeddings API](https://platform.openai.com/docs/api-reference)）。
 * 实现：GET /v1/models；POST /v1/chat/completions（流式/非流式，tool_calls）；POST /v1/embeddings。
 * - 错误统一为 { error: { message, type } }，流式错误以 SSE 事件发送后结束。
 * - 流式 delta 仅含规范字段：role、content（必为 string）、tool_calls（规范结构），避免客户端解析到未知类型。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
    chatCompletionStream,
    chatCompletion,
    getEmbedding,
    isLlmReady,
    isEmbeddingReady,
    type ChatMessage,
    type ToolDefinition,
    type ToolCall,
} from "./llm-context.js";

const LLM_MODEL_ID = process.env.LOCAL_LLM_MODEL_ID ?? "local-llm";
const EMB_MODEL_ID = process.env.LOCAL_EMB_MODEL_ID ?? "local-embedding";

function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch {
                reject(new Error("Invalid JSON body"));
            }
        });
        req.on("error", reject);
    });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(json);
}

/** OpenAI 规范错误体：{ error: { message, type } } */
function sendError(
    res: ServerResponse,
    status: number,
    message: string,
    type: string = status >= 500 ? "server_error" : "invalid_request_error",
): void {
    sendJson(res, status, { error: { message: String(message), type } });
}

/** 构造 OpenAI 格式的 chat completion 响应对象 */
function buildCompletionResponse(
    content: string,
    tool_calls: ToolCall[] | undefined,
    finish_reason: string,
    model: string,
): unknown {
    const message: Record<string, unknown> = { role: "assistant", content: tool_calls ? null : content };
    if (tool_calls?.length) message.tool_calls = tool_calls;
    return {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason, logprobs: null }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}

/** 构造 SSE delta chunk，仅含 OpenAI 流式规范字段，不包含 logprobs 避免下游解析异常 */
function buildStreamChunk(
    id: string,
    model: string,
    delta: Record<string, unknown>,
    finish_reason: string | null,
): string {
    const choice: Record<string, unknown> = { index: 0, delta, finish_reason };
    const chunk = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [choice],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: any;
    try {
        body = await readBody(req);
    } catch {
        return sendError(res, 400, "Invalid JSON body");
    }

    if (!isLlmReady()) return sendError(res, 503, "LLM 模型未加载，请先启动本地模型服务并选择 LLM 模型", "server_error");

    if (!Array.isArray(body.messages)) {
        return sendError(res, 400, "Missing or invalid 'messages' (must be an array)", "invalid_request_error");
    }
    if (body.messages.length === 0) {
        return sendError(res, 400, "'messages' must contain at least one message", "invalid_request_error");
    }

    const messages: ChatMessage[] = body.messages;
    const tools: ToolDefinition[] = Array.isArray(body.tools) ? body.tools : [];
    const stream: boolean = body.stream === true;
    const model: string = typeof body.model === "string" && body.model.trim() ? body.model.trim() : LLM_MODEL_ID;

    const abortCtrl = new AbortController();
    req.on("close", () => abortCtrl.abort());

    if (stream) {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });

        const id = `chatcmpl-${randomUUID()}`;
        // 首包：role + content 占位，与 DeepSeek 等一致，避免仅 role 时下游对 delta 的严格校验
        res.write(buildStreamChunk(id, model, { role: "assistant", content: "" }, null));

        let pendingToolCalls: ToolCall[] | undefined;
        let finishReason = "stop";

        try {
            await chatCompletionStream(messages, tools, (chunk) => {
                if (abortCtrl.signal.aborted) return;
                if (chunk.content != null && chunk.content !== "") {
                    const text = typeof chunk.content === "string" ? chunk.content : String(chunk.content);
                    res.write(buildStreamChunk(id, model, { content: text }, null));
                }
                if (chunk.tool_calls?.length) {
                    pendingToolCalls = chunk.tool_calls;
                }
                if (chunk.finish_reason) {
                    finishReason = chunk.finish_reason;
                }
            }, abortCtrl.signal);
        } catch (e) {
            if (!abortCtrl.signal.aborted) {
                const errMsg = e instanceof Error ? e.message : String(e);
                const stack = e instanceof Error ? e.stack : undefined;
                console.error("[local-llm] stream error:", errMsg);
                if (stack) console.error("[local-llm] stream stack:", stack);
                res.write(`data: ${JSON.stringify({ error: { message: errMsg, type: "server_error" } })}\n\n`);
            }
            res.end();
            return;
        }

        // 若有 tool_calls，按 OpenAI 流式规范发一条 delta（含 index/id/type/function），与 DeepSeek 等一致
        if (pendingToolCalls?.length) {
            const deltaToolCalls = pendingToolCalls.map((tc, i) => ({
                index: i,
                id: typeof tc.id === "string" ? tc.id : `call_${i}`,
                type: "function" as const,
                function: {
                    name: typeof tc.function?.name === "string" ? tc.function.name : "",
                    arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : "",
                },
            }));
            res.write(buildStreamChunk(id, model, { tool_calls: deltaToolCalls }, null));
            finishReason = "tool_calls";
        }
        res.write(buildStreamChunk(id, model, {}, finishReason));
        res.write("data: [DONE]\n\n");
        res.end();
    } else {
        try {
            const result = await chatCompletion(messages, tools, abortCtrl.signal);
            sendJson(res, 200, buildCompletionResponse(
                result.content,
                result.tool_calls,
                result.finish_reason,
                model,
            ));
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            sendError(res, 500, msg, "server_error");
        }
    }
}

async function handleEmbeddings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: any;
    try {
        body = await readBody(req);
    } catch {
        return sendError(res, 400, "Invalid JSON body", "invalid_request_error");
    }

    if (!isEmbeddingReady()) return sendError(res, 503, "Embedding 模型未加载，请先启动本地模型服务并选择 Embedding 模型", "server_error");

    const input = body.input;
    if (input === undefined || input === null) {
        return sendError(res, 400, "Missing 'input' (string or array of strings)", "invalid_request_error");
    }
    const inputs = Array.isArray(input) ? input : [input];
    if (inputs.length === 0 || inputs.some((x: unknown) => typeof x !== "string")) {
        return sendError(res, 400, "'input' must be a non-empty string or array of strings", "invalid_request_error");
    }

    try {
        const data = await Promise.all(
            inputs.map(async (text, i) => ({
                object: "embedding",
                index: i,
                embedding: await getEmbedding(text),
            })),
        );
        sendJson(res, 200, {
            object: "list",
            data,
            model: body.model ?? EMB_MODEL_ID,
            usage: { prompt_tokens: 0, total_tokens: 0 },
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        sendError(res, 500, msg, "server_error");
    }
}

function handleModels(_req: IncomingMessage, res: ServerResponse): void {
    const data: { id: string; object: string; created: number; owned_by: string }[] = [];
    if (isLlmReady()) data.push({ id: LLM_MODEL_ID, object: "model", created: 0, owned_by: "local" });
    if (isEmbeddingReady()) data.push({ id: EMB_MODEL_ID, object: "model", created: 0, owned_by: "local" });
    sendJson(res, 200, { object: "list", data });
}

export function createOpenAICompatServer(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const server = createServer(async (req, res) => {
            const url = req.url ?? "";
            const method = req.method ?? "";

            // CORS
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
            if (method === "OPTIONS") {
                res.writeHead(204);
                res.end();
                return;
            }

            try {
                if (method === "GET" && url === "/v1/models") {
                    handleModels(req, res);
                } else if (method === "POST" && url === "/v1/chat/completions") {
                    await handleChatCompletions(req, res);
                } else if (method === "POST" && url === "/v1/embeddings") {
                    await handleEmbeddings(req, res);
                } else {
                    sendError(res, 404, `Not found: ${method} ${url}`, "invalid_request_error");
                }
            } catch (e) {
                if (!res.headersSent) sendError(res, 500, String(e));
            }
        });

        server.listen(port, "127.0.0.1", () => {
            console.log(`[local-llm] OpenAI 兼容服务已启动: http://127.0.0.1:${port}/v1`);
            resolve();
        });
        server.on("error", reject);
    });
}
