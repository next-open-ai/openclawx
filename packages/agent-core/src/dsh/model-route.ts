import type { ModelConfig } from '@openclawx/contracts';

/** Wire route id used in JSON-RPC `initialize.provider` and cordis `providers` key. */
export const OPENCLAWX_DSH_PROVIDER_ROUTE = 'openclawx';

export const OPENCLAWX_DSH_API_KEY_ENV = 'OPENCLAWX_DSH_API_KEY';

export type DshPiAiApi = 'openai-completions' | 'anthropic-messages';

export type OpenClawXDshModelRoute = {
  /** JSON-RPC initialize.provider */
  provider: string;
  /** JSON-RPC initialize.model */
  model: string;
  api: DshPiAiApi;
  baseUrl: string;
  apiKey: string;
  displayName: string;
  contextWindow: number;
  maxTokens: number;
  env: NodeJS.ProcessEnv;
};

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

/**
 * Map a OpenClawX ModelConfig onto a single pi-ai hand-declared route.
 * Credentials travel only via env (`OPENCLAWX_DSH_API_KEY`); never inline in cordis.
 */
export function mapOpenClawXModelToDshRoute(model: ModelConfig): OpenClawXDshModelRoute {
  const chatModel = String(model.chatModel || '').trim();
  if (!chatModel) throw new Error('OpenClawX model is missing chatModel.');

  const providerId = String(model.provider || '').trim();
  const apiKeyRaw = String(model.apiKey || '').trim();
  const baseUrlRaw = String(model.baseUrl || '').trim();
  const displayName = String(model.providerLabel || providerId || 'OpenClawX').slice(0, 80);

  let api: DshPiAiApi = 'openai-completions';
  let baseUrl = baseUrlRaw ? trimSlash(baseUrlRaw) : '';
  let apiKey = apiKeyRaw;

  switch (providerId) {
    case 'anthropic':
      api = 'anthropic-messages';
      if (!baseUrl) baseUrl = 'https://api.anthropic.com';
      break;
    case 'openai':
      if (!baseUrl) baseUrl = 'https://api.openai.com/v1';
      break;
    case 'deepseek':
      if (!baseUrl) baseUrl = 'https://api.deepseek.com';
      break;
    case 'glm':
      if (!baseUrl) baseUrl = 'https://open.bigmodel.cn/api/paas/v4';
      break;
    case 'ollama':
      if (!baseUrl) baseUrl = 'http://127.0.0.1:11434/v1';
      if (!apiKey) apiKey = 'ollama';
      break;
    case 'google':
      // Hand-declared pi-ai routes only support openai-completions / anthropic-messages.
      // Require an OpenAI-compatible Gemini gateway URL from OpenClawX settings.
      if (!baseUrl) {
        throw new Error(
          'Google/Gemini for dsh requires an OpenAI-compatible baseUrl in OpenClawX model settings '
          + '(native Gemini API is not in dsh llm-pi-ai hand-declared protocols).',
        );
      }
      break;
    case 'qwen':
    case 'openai-compatible':
      if (!baseUrl) {
        throw new Error(
          `Provider "${providerId}" requires baseUrl in OpenClawX model settings for dsh.`,
        );
      }
      break;
    default:
      if (!baseUrl) {
        throw new Error(
          `Unsupported dsh provider "${providerId}" without baseUrl. `
          + 'Set an OpenAI-compatible endpoint on the model, or use openai / anthropic / deepseek / ollama / qwen.',
        );
      }
      break;
  }

  if (!apiKey && providerId !== 'ollama') {
    throw new Error(`OpenClawX model "${chatModel}" is missing apiKey (required for dsh).`);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [OPENCLAWX_DSH_API_KEY_ENV]: apiKey || 'ollama',
  };

  return {
    provider: OPENCLAWX_DSH_PROVIDER_ROUTE,
    model: chatModel,
    api,
    baseUrl,
    apiKey: apiKey || 'ollama',
    displayName,
    contextWindow: 262_144,
    maxTokens: 32_768,
    env,
  };
}
