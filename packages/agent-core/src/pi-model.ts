import type { Model, Api } from '@mariozechner/pi-ai';
import { registerBuiltInApiProviders } from '@mariozechner/pi-ai/dist/providers/register-builtins.js';
import type { ModelConfig } from '@openclawx/contracts';

let builtinsRegistered = false;

export function ensurePiProviders() {
  if (builtinsRegistered) return;
  registerBuiltInApiProviders();
  builtinsRegistered = true;
}

function defaultBaseUrl(provider: ModelConfig['provider']) {
  switch (provider) {
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'google':
      return 'https://generativelanguage.googleapis.com';
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'deepseek':
      return 'https://api.deepseek.com';
    case 'glm':
      return 'https://open.bigmodel.cn/api/paas/v4';
    case 'qwen':
      return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    case 'ollama':
      return 'http://127.0.0.1:11434/v1';
    default:
      return 'https://api.openai.com/v1';
  }
}

function resolveApi(provider: ModelConfig['provider']): Api {
  if (provider === 'anthropic') return 'anthropic-messages';
  if (provider === 'google') return 'google-generative-ai';
  // OpenAI Responses API is optional; chat-completions covers openai-compatible forks.
  return 'openai-completions';
}

export function looksLikeDeepseek(config: ModelConfig) {
  if (config.provider === 'deepseek') return true;
  if (config.provider !== 'openai-compatible') return false;
  return /deepseek/i.test(config.baseUrl || '') || /deepseek/i.test(config.chatModel || '');
}

export function supportsBuiltinEnableSearch(provider: ModelConfig['provider']) {
  return provider === 'qwen' || provider === 'openai-compatible';
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Map OpenClawX ModelConfig → pi-ai Model.
 * OpenAI-compatible providers (DeepSeek / Qwen / Ollama / custom) use openai-completions.
 */
export function toPiModel(config: ModelConfig): Model<Api> {
  ensurePiProviders();
  const baseUrl = (config.baseUrl?.trim() || defaultBaseUrl(config.provider)).replace(/\/$/, '');
  const api = resolveApi(config.provider);
  return {
    id: config.chatModel,
    name: config.chatModel,
    api,
    provider: config.provider,
    baseUrl,
    reasoning: false,
    input: config.supportsVision ? ['text', 'image'] : ['text'],
    cost: ZERO_COST,
    contextWindow: 128_000,
    // Tool calls that embed HTML/CSS need headroom; 8k often truncates mid-JSON
    // ("Unterminated string") and aborts the whole run before write executes.
    maxTokens: 32_768,
  };
}

/** Patch chat-completions JSON body for Ollama / Bailian / DeepSeek quirks. */
export function createChatCompletionsPayloadPatch(config: ModelConfig) {
  const disableThinking = config.provider === 'ollama' && Boolean(config.disableThinking);
  const enableSearch = supportsBuiltinEnableSearch(config.provider) && Boolean(config.enableSearch);
  const disableDeepseekThinking = looksLikeDeepseek(config);
  return (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const body = payload as Record<string, unknown>;
    // pi-ai 0.51.x currently accumulates streamed tool-call arguments in a
    // single active block. When an OpenAI-compatible endpoint interleaves
    // multiple parallel tool calls, their JSON fragments can be concatenated
    // and the tool invocation fails with "Unexpected non-whitespace character
    // after JSON". OpenClawX executes tools serially anyway, so explicitly
    // request a single tool call per model turn.
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      body.parallel_tool_calls = false;
    }
    if (disableThinking) body.think = false;
    if (enableSearch) body.enable_search = true;
    if (disableDeepseekThinking) body.thinking = { type: 'disabled' };
  };
}
