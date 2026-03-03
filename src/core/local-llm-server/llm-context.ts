/**
 * node-llama-cpp 模型实例管理。
 * 可只加载 LLM、只加载 Embedding、或两者都加载；有一个就启动一个，不因缺另一个而失败。
 */
import { LOCAL_LLM_CACHE_DIR } from "./model-resolve.js";

export interface LlmContextOptions {
    /** LLM 推理模型路径或 hf: URI，可选；不传则仅提供 embedding */
    llmModelPath?: string;
    /** Embedding 模型路径或 hf: URI，可选；不传则仅提供 chat */
    embeddingModelPath?: string;
    /** GPU layers，-1 表示全部卸载到 GPU（Metal），0 表示纯 CPU */
    gpuLayers?: number;
    /** 上下文窗口大小，默认 32768（32K） */
    contextSize?: number;
}

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    /** tool_calls（assistant 发起工具调用时） */
    tool_calls?: ToolCall[];
    /** tool_call_id（role=tool 时，对应哪个 tool_call） */
    tool_call_id?: string;
    /** tool 消息的函数名 */
    name?: string;
}

export interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}

export interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

export interface ChatCompletionChunk {
    content?: string;
    tool_calls?: ToolCall[];
    finish_reason?: "stop" | "tool_calls" | "length";
}

let llama: any = null;
let llmModel: any = null;
let embeddingModel: any = null;
let embeddingCtx: any = null;

/** 上下文窗口大小，initModels 时设置，用于 createContext；默认 32K 以容纳较长 system + tools */
let storedContextSize = 32768;

/** 串行锁：同一模型同一时间只处理一个推理请求 */
let llmQueue: Promise<unknown> = Promise.resolve();

async function getLlamaInstance(gpuLayers?: number): Promise<any> {
    if (llama) return llama;
    const { getLlama, LlamaLogLevel } = await import("node-llama-cpp");
    llama = await getLlama({
        logLevel: LlamaLogLevel.warn,
        ...(gpuLayers !== undefined ? { gpu: gpuLayers === 0 ? false : "auto" } : {}),
    });
    return llama;
}

export async function initModels(opts: LlmContextOptions): Promise<void> {
    storedContextSize = opts.contextSize ?? 32768;
    const { resolveModelFile } = await import("node-llama-cpp");
    const instance = await getLlamaInstance(opts.gpuLayers);
    const cacheDir = LOCAL_LLM_CACHE_DIR;

    if (opts.llmModelPath?.trim()) {
        console.log("[local-llm] 加载 LLM 模型:", opts.llmModelPath);
        const llmPath = await resolveModelFile(opts.llmModelPath, cacheDir);
        llmModel = await instance.loadModel({ modelPath: llmPath });
    } else {
        llmModel = null;
    }

    if (opts.embeddingModelPath?.trim()) {
        console.log("[local-llm] 加载 Embedding 模型:", opts.embeddingModelPath);
        const embPath = await resolveModelFile(opts.embeddingModelPath, cacheDir);
        embeddingModel = await instance.loadModel({ modelPath: embPath });
        embeddingCtx = await embeddingModel.createEmbeddingContext();
    } else {
        embeddingModel = null;
        embeddingCtx = null;
    }

    console.log("[local-llm] 模型加载完成", {
        llm: !!llmModel,
        embedding: !!embeddingCtx,
    });
}

/** 将 API 可能传来的 content（string | array 如 [{ type: "text", text: "..." }]）规范为 string，避免 node-llama-cpp LlamaText.fromJSON 收到对象抛 "Unknown value type: [object Object]" */
function contentToString(content: unknown): string {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return String(content);
    return content
        .filter((part): part is { type?: string; text?: string } => part != null && typeof part === "object")
        .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
        .join("");
}

/**
 * 将 ChatMessage[] 转换为 node-llama-cpp 的 LlamaChatMessage[]。
 * tool_calls 序列化为 assistant content；tool 结果作为 user content 回传。
 * 入参 content 可能是 OpenAI 多段格式（content: [{ type: "text", text: "..." }]），必须规范为 string。
 */
function toLocalMessages(messages: ChatMessage[]): { role: string; content: string }[] {
    return messages.map((m) => {
        const rawContent = (m as { content?: unknown }).content;
        const content = contentToString(rawContent);
        if (m.role === "tool") {
            return { role: "user", content: `[Tool result for ${m.name ?? m.tool_call_id ?? "tool"}]: ${content}` };
        }
        if (m.role === "assistant" && m.tool_calls?.length) {
            const calls = JSON.stringify(m.tool_calls);
            return { role: "assistant", content: content + `\n[tool_calls]: ${calls}` };
        }
        return { role: m.role, content };
    });
}

/**
 * 将 tools 定义转换为 grammar 约束描述，拼入 system prompt。
 * node-llama-cpp v3 通过 LlamaGrammar 支持 JSON schema 约束输出，
 * 这里用 prompt 方式描述工具，让模型以 JSON 格式输出 tool_calls。
 */
function buildToolSystemPrompt(tools: ToolDefinition[]): string {
    if (!tools.length) return "";
    const descs = tools.map((t) => {
        const fn = t.function;
        return `- ${fn.name}: ${fn.description ?? ""}\n  parameters: ${JSON.stringify(fn.parameters ?? {})}`;
    }).join("\n");
    return `\n\nYou have access to the following tools. When you need to call a tool, respond ONLY with a JSON object in this exact format (no other text):\n{"tool_calls":[{"id":"call_<random>","type":"function","function":{"name":"<tool_name>","arguments":"<json_string>"}}]}\n\nAvailable tools:\n${descs}`;
}

/** 尝试从模型输出中解析 tool_calls JSON */
function parseToolCalls(text: string): ToolCall[] | null {
    const trimmed = text.trim();
    // 匹配 {"tool_calls":[...]} 格式
    const match = trimmed.match(/\{[\s\S]*"tool_calls"[\s\S]*\}/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[0]) as { tool_calls?: ToolCall[] };
        if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
            return parsed.tool_calls;
        }
    } catch {
        // 不是合法 JSON，当普通文本处理
    }
    return null;
}

/**
 * 从累积文本中移除 <think>...</think> 块，只保留对外可见的正文（关闭本地模型“思考过程”的展示）。
 * 若存在未闭合的 <think>，则从 <think> 起至末尾均视为思考内容不输出。
 */
function getVisibleWithoutThinking(text: string): string {
    let out = "";
    let i = 0;
    const openTag = "<think>";
    const closeTag = "</think>";
    while (i < text.length) {
        const open = text.indexOf(openTag, i);
        if (open === -1) {
            out += text.slice(i);
            break;
        }
        out += text.slice(i, open);
        const close = text.indexOf(closeTag, open + openTag.length);
        if (close === -1) {
            // 思考块未闭合，剩余不输出
            break;
        }
        i = close + closeTag.length;
    }
    return out;
}

/**
 * 流式 chat completion。
 * onChunk 每次收到新 token 时调用；结束后返回完整 finish_reason。
 * 本地模型若输出 <think>...</think> 块，会从流中过滤，不展示思考过程。
 */
export async function chatCompletionStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: ChatCompletionChunk) => void,
    signal?: AbortSignal,
): Promise<void> {
    if (!llmModel) throw new Error("[local-llm] LLM 模型未初始化");

    const { LlamaChatSession } = await import("node-llama-cpp");

    // 串行排队
    const run = async () => {
        const ctx = await llmModel.createContext({ contextSize: storedContextSize });

        // 注入历史消息（除最后一条 user 消息）
        const localMsgs = toLocalMessages(messages);
        let lastUser = -1;
        for (let i = localMsgs.length - 1; i >= 0; i--) {
            if (localMsgs[i].role === "user") { lastUser = i; break; }
        }
        const history = lastUser > 0 ? localMsgs.slice(0, lastUser) : [];
        const userPrompt = lastUser >= 0 ? localMsgs[lastUser].content : "";

        // 找 system prompt，拼入 tool 描述（system 的 content 也可能是 array，需规范为 string）
        const systemMsg = messages.find((m) => m.role === "system");
        const toolSystemPrompt = buildToolSystemPrompt(tools);
        const systemContent = contentToString((systemMsg as { content?: unknown })?.content) + toolSystemPrompt;

        // 创建带 systemPrompt 的 session，重建历史
        const session = new LlamaChatSession({
            contextSequence: ctx.getSequence(),
            systemPrompt: systemContent || undefined,
        });

        for (const msg of history) {
            if (msg.role === "user") {
                await session.prompt(msg.content, { onTextChunk: () => {} });
            }
        }

        let fullText = "";
        let prevSentVisibleLength = 0;
        let lastSent = ""; // 连续相同 delta 只发一次，缓解回复缓慢时「每个字显示两遍」
        try {
            await session.prompt(userPrompt, {
                onTextChunk: (token: unknown) => {
                    if (signal?.aborted) return;
                    const s = typeof token === "string" ? token : (token != null ? String(token) : "");
                    if (!s) return;
                    // node-llama-cpp 在 detokenize(tokens, false, tokenTrail) 时可能返回带上下文的片段（含重复前缀），
                    // 与 DeepSeek 等仅返回增量不同。只向下游发送增量，避免出现「你好你好！！我是我是...」式重复。
                    if (s.startsWith(fullText)) {
                        fullText = s;
                    } else {
                        fullText += s;
                    }
                    // 过滤 <think>...</think> 块，不向客户端输出思考过程
                    const visibleText = getVisibleWithoutThinking(fullText);
                    const toSend = visibleText.slice(prevSentVisibleLength);
                    prevSentVisibleLength = visibleText.length;
                    if (toSend && toSend !== lastSent) {
                        lastSent = toSend;
                        onChunk({ content: toSend });
                    }
                },
                signal,
            });
        } catch (e) {
            // node-llama-cpp 在解析模型输出（如 segment/tool_call）时可能对 LlamaText.fromJSON 传入对象导致 "Unknown value type: [object Object]"
            const msg = e instanceof Error ? e.message : String(e);
            const stack = e instanceof Error ? e.stack : undefined;
            console.error("[local-llm] chatCompletionStream session.prompt error:", msg);
            if (stack) console.error("[local-llm] stack:", stack);
            throw e;
        }

        // 检查是否是 tool_calls 输出
        const toolCalls = parseToolCalls(fullText);
        if (toolCalls) {
            onChunk({ tool_calls: toolCalls, finish_reason: "tool_calls" });
        } else {
            onChunk({ finish_reason: "stop" });
        }

        await ctx.dispose();
    };

    llmQueue = llmQueue.then(run, run);
    await llmQueue;
}

/**
 * 非流式 chat completion（内部复用流式实现）。
 */
export async function chatCompletion(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
): Promise<{ content: string; tool_calls?: ToolCall[]; finish_reason: string }> {
    let content = "";
    let toolCalls: ToolCall[] | undefined;
    let finishReason = "stop";

    await chatCompletionStream(messages, tools, (chunk) => {
        if (chunk.content) content += chunk.content;
        if (chunk.tool_calls) toolCalls = chunk.tool_calls;
        if (chunk.finish_reason) finishReason = chunk.finish_reason;
    }, signal);

    return { content, tool_calls: toolCalls, finish_reason: finishReason };
}

/**
 * 文本 embedding，返回 L2 归一化向量。
 */
export async function getEmbedding(text: string): Promise<number[]> {
    if (!embeddingCtx) throw new Error("[local-llm] Embedding 模型未初始化");
    const result = await embeddingCtx.getEmbeddingFor(text);
    const vec = Array.from(result.vector) as number[];
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
}

/** 是否至少加载了一个模型（LLM 或 Embedding） */
export function isReady(): boolean {
    return llmModel !== null || embeddingCtx !== null;
}

/** 是否有 LLM，可提供 chat/completions */
export function isLlmReady(): boolean {
    return llmModel !== null;
}

/** 是否有 Embedding，可提供 embeddings */
export function isEmbeddingReady(): boolean {
    return embeddingCtx !== null;
}
