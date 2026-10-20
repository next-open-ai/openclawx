/**
 * Context compaction & session memory — powered by pi-coding-agent.
 *
 * Uses official `generateSummary` / `shouldCompact` / `estimateTokens`
 * (same path as pi's auto-compaction) instead of Vercel AI SDK.
 */
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import { completeSimple } from '@mariozechner/pi-ai';
import {
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  generateSummary,
  serializeConversation,
  shouldCompact,
} from '@mariozechner/pi-coding-agent';
import type { ModelConfig } from '@openclawx/contracts';
import { createChatCompletionsPayloadPatch, toPiModel } from './pi-model.js';
import { extractContextAnchors, formatAnchorsBlock } from './context-sanitize.js';

/** Soft budget for durable session memory (summary + uncovered turns). */
export const SESSION_MEMORY_BUDGET_CHARS = 24_000;
/** Keep this many newest canonical messages verbatim after a session roll. */
export const SESSION_MEMORY_KEEP_RECENT = 8;
/** Cap stored session summary text. */
export const SESSION_MEMORY_SUMMARY_MAX_CHARS = 3_500;
/**
 * Secondary compaction trigger after hygiene (chars).
 * Token estimate is chars/4 and under-counts CJK; this catches ballooned Chinese/HTML-free contexts.
 */
export const COMPACTION_CHAR_THRESHOLD = 96_000;
/** Soft share of context window before we force mid-run summarization (after hygiene). */
export const COMPACTION_WINDOW_RATIO = 0.78;

/** Shared prefix for durable session memory injection into chat history. */
export const SESSION_SUMMARY_PREFIX = '[OpenClawX context summary]';

const OPENCLAWX_SUMMARY_FOCUS = [
  'OpenClawX digital-employee session continuity brief.',
  'MUST preserve: user goal, hard constraints, acceptance criteria, written file paths, blockers/errors, unfinished next step.',
  'MUST omit: thinking/reasoning, raw CSS/HTML/JS bodies, full stdout/stderr dumps, duplicated tool JSON.',
  'Write in the same language as the user. Prefer bullet lists over prose.',
].join(' ');

const FALLBACK_SYSTEM =
  'You are a context summarization assistant. Read the conversation and produce a structured continuity brief. Do NOT continue the conversation. ONLY output the summary.';

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function estimateMessageTokens(messages: AgentMessage[]) {
  let tokens = 0;
  for (const message of messages) tokens += estimateTokens(message);
  return tokens;
}

/** Convert plain turns into pi AgentMessages for generateSummary. */
export function plainTurnsToAgentMessages(
  turns: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: ModelConfig,
): AgentMessage[] {
  const api: Api =
    model.provider === 'anthropic'
      ? 'anthropic-messages'
      : model.provider === 'google'
        ? 'google-generative-ai'
        : 'openai-completions';
  return turns.map((turn) => {
    if (turn.role === 'user') {
      return { role: 'user' as const, content: turn.content, timestamp: Date.now() };
    }
    return {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: turn.content }],
      api,
      provider: model.provider,
      model: model.chatModel,
      usage: emptyUsage(),
      stopReason: 'stop' as const,
      timestamp: Date.now(),
    };
  });
}

function resolveApiKey(model: ModelConfig) {
  return model.apiKey?.trim() || (model.provider === 'ollama' ? 'ollama' : '');
}

function summaryAsAgentMessages(summary: string, model: ModelConfig): AgentMessage[] {
  return plainTurnsToAgentMessages(sessionSummaryMessagePair(summary), model);
}

/**
 * Fallback summarizer when generateSummary fails (e.g. provider rejects reasoning).
 * Still uses pi-ai completeSimple + pi serializeConversation.
 */
async function summarizeFallback(input: {
  messages: AgentMessage[];
  model: ModelConfig;
  previousSummary?: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const piModel = toPiModel(input.model);
  const apiKey = resolveApiKey(input.model);
  if (!apiKey) return null;
  const onPayload = createChatCompletionsPayloadPatch(input.model);
  const conversationText = serializeConversation(convertToLlm(input.messages));
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (input.previousSummary?.trim()) {
    promptText += `<previous-summary>\n${input.previousSummary.trim()}\n</previous-summary>\n\n`;
  }
  promptText +=
    'Produce a structured continuity brief with sections: Goal, Constraints, Progress (Done/In Progress/Blocked), Key Decisions, Next Steps, Critical Context. '
    + OPENCLAWX_SUMMARY_FOCUS;
  try {
    const response = await completeSimple(
      piModel,
      {
        systemPrompt: FALLBACK_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: promptText }], timestamp: Date.now() }],
      },
      {
        maxTokens: Math.floor(0.8 * DEFAULT_COMPACTION_SETTINGS.reserveTokens),
        apiKey,
        signal: input.signal,
        reasoning: undefined,
        onPayload: (payload) => onPayload?.(payload),
      },
    );
    if (response.stopReason === 'error') return null;
    const text = response.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
    return text ? text.slice(0, SESSION_MEMORY_SUMMARY_MAX_CHARS) : null;
  } catch {
    return null;
  }
}

/** Durable session-memory summarizer — pi generateSummary (with safe fallback). */
export async function summarizeSessionMemory(input: {
  model: ModelConfig;
  previousSummary?: string;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
  signal?: AbortSignal;
}): Promise<string | null> {
  if (!input.turns.length) return null;

  // Phase 3: when AgentScope engine is selected, prefer Sidecar summarizer.
  if ((process.env.OPENCLAWX_AGENT_ENGINE || 'pi').trim().toLowerCase() === 'agentscope') {
    try {
      const { ensureSharedAgentscopeRuntime } = await import('./agentscope/process.js');
      const handle = await ensureSharedAgentscopeRuntime();
      const result = await handle.client.summarizeMemory({
        model: {
          provider: input.model.provider,
          chatModel: input.model.chatModel,
          baseUrl: input.model.baseUrl,
          apiKey: input.model.apiKey,
          disableThinking: input.model.disableThinking,
        },
        previousSummary: input.previousSummary,
        turns: input.turns,
      });
      const trimmed = result.summary?.trim().slice(0, SESSION_MEMORY_SUMMARY_MAX_CHARS);
      if (trimmed) return trimmed;
    } catch {
      /* fall through to pi path */
    }
  }

  const messages = plainTurnsToAgentMessages(input.turns, input.model);
  const piModel = toPiModel(input.model);
  const apiKey = resolveApiKey(input.model);
  if (!apiKey) return null;
  try {
    const summary = await generateSummary(
      messages,
      piModel,
      DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      apiKey,
      input.signal,
      OPENCLAWX_SUMMARY_FOCUS,
      input.previousSummary,
    );
    const trimmed = summary?.trim().slice(0, SESSION_MEMORY_SUMMARY_MAX_CHARS);
    return trimmed || null;
  } catch {
    return summarizeFallback({
      messages,
      model: input.model,
      previousSummary: input.previousSummary,
      signal: input.signal,
    });
  }
}

/** @deprecated Prefer summarizeSessionMemory. */
export async function summarizePlainTurns(input: {
  previousSummary?: string;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
  model: ModelConfig;
  signal?: AbortSignal;
}): Promise<string | null> {
  return summarizeSessionMemory(input);
}

/** Build the user/assistant pair used to inject a durable summary into chat history. */
export function sessionSummaryMessagePair(summary: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  const text = summary.trim();
  if (!text) return [];
  return [
    {
      role: 'user',
      content: `${SESSION_SUMMARY_PREFIX}\n${text}\n\nContinue from this summary and the recent messages below. Do not re-read the entire history.`,
    },
    {
      role: 'assistant',
      content: 'Understood. I will use the summary as prior context and continue with the recent turns.',
    },
  ];
}

function findPreviousInjectedSummary(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text').map((part) => part.text).join('\n')
        : '';
    if (text.startsWith(SESSION_SUMMARY_PREFIX)) {
      return text.slice(SESSION_SUMMARY_PREFIX.length).replace(/^\n/, '').split('\n\nContinue from this summary')[0]?.trim();
    }
  }
  return undefined;
}

function estimateMessageChars(messages: AgentMessage[]) {
  let chars = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      chars += content.length;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const item = block as { text?: string; thinking?: string; arguments?: unknown };
      if (typeof item.text === 'string') chars += item.text.length;
      if (typeof item.thinking === 'string') chars += item.thinking.length;
      if (item.arguments) chars += JSON.stringify(item.arguments).length;
    }
  }
  return chars;
}

function mergeSummaryWithAnchors(summary: string, messagesForAnchors: AgentMessage[]) {
  const anchors = extractContextAnchors(messagesForAnchors);
  const anchorBlock = formatAnchorsBlock(anchors);
  const body = summary.trim();
  const merged = `${anchorBlock}\n\n${body}`.trim();
  return merged.slice(0, SESSION_MEMORY_SUMMARY_MAX_CHARS + 1_200);
}

function needsCompaction(tokens: number, chars: number, contextWindow: number, settings: typeof DEFAULT_COMPACTION_SETTINGS) {
  if (chars >= COMPACTION_CHAR_THRESHOLD) return true;
  if (!shouldCompact(tokens, contextWindow, settings)) return false;
  const boostCeiling = Math.floor(contextWindow * COMPACTION_WINDOW_RATIO);
  return tokens >= boostCeiling;
}

/**
 * Mid-run context transform for pi Agent: when context is near the window,
 * summarize older messages with pi generateSummary, prepend deterministic
 * anchors (goal / paths / errors), and keep recent turns verbatim.
 *
 * Callers should pass already-hygienized messages (thinking stripped, writes path-only).
 */
export async function compactAgentContext(input: {
  messages: AgentMessage[];
  model: ModelConfig;
  piModel?: Model<Api>;
  signal?: AbortSignal;
}): Promise<AgentMessage[]> {
  const messages = input.messages;
  if (messages.length < 6) return messages;

  const piModel = input.piModel ?? toPiModel(input.model);
  const contextWindow = piModel.contextWindow || 128_000;
  const settings = DEFAULT_COMPACTION_SETTINGS;
  const tokens = estimateMessageTokens(messages);
  const chars = estimateMessageChars(messages);
  if (!needsCompaction(tokens, chars, contextWindow, settings)) return messages;

  let keptTokens = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    keptTokens += estimateTokens(messages[i]!);
    if (keptTokens >= settings.keepRecentTokens) {
      let boundary = i;
      while (boundary > 0 && messages[boundary]?.role !== 'user') boundary -= 1;
      cut = boundary > 0 ? boundary : i;
      break;
    }
  }
  if (cut <= 1 || cut >= messages.length - 1) return messages;

  const older = messages.slice(0, cut);
  const recent = messages.slice(cut);
  const apiKey = resolveApiKey(input.model);
  if (!apiKey) {
    // No key for LLM summary — still inject deterministic anchors so paths/goal survive.
    const anchorsOnly = formatAnchorsBlock(extractContextAnchors(older));
    return [...summaryAsAgentMessages(anchorsOnly, input.model), ...recent];
  }

  const previousSummary = findPreviousInjectedSummary(older);
  try {
    const summary = await generateSummary(
      older,
      piModel,
      settings.reserveTokens,
      apiKey,
      input.signal,
      OPENCLAWX_SUMMARY_FOCUS,
      previousSummary,
    );
    if (!summary?.trim()) {
      const anchorsOnly = formatAnchorsBlock(extractContextAnchors([...older, ...recent]));
      return [...summaryAsAgentMessages(anchorsOnly, input.model), ...recent];
    }
    const merged = mergeSummaryWithAnchors(summary, [...older, ...recent]);
    return [...summaryAsAgentMessages(merged, input.model), ...recent];
  } catch {
    const fallback = await summarizeFallback({
      messages: older,
      model: input.model,
      previousSummary,
      signal: input.signal,
    });
    if (!fallback) {
      const anchorsOnly = formatAnchorsBlock(extractContextAnchors([...older, ...recent]));
      return [...summaryAsAgentMessages(anchorsOnly, input.model), ...recent];
    }
    const merged = mergeSummaryWithAnchors(fallback, [...older, ...recent]);
    return [...summaryAsAgentMessages(merged, input.model), ...recent];
  }
}
export { convertToLlm, DEFAULT_COMPACTION_SETTINGS, shouldCompact };
