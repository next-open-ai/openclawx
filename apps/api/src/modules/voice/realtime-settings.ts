import { readRealtimeVoiceSettings as readLegacySettings } from './legacy-settings.js';
import { readSettingsFile, writeSettingsFile } from './settings-files.js';
import { resolveProviderServiceEndpoint } from '@openclawx/contracts';
import { getSecrets } from '../orchestration/secrets.js';

export const DEFAULT_REALTIME_VOICE_MODEL = '1.2.6.1';
export const DEFAULT_REALTIME_VOICE_ID = 'zh_female_vv_jupiter_bigtts';
export const DEFAULT_REALTIME_VOICE_INSTRUCTIONS = '你是 OpenClawX 的实时语音助手。使用简洁自然的中文交流，不要声称执行了尚未执行的业务操作。';
export type RealtimeConversationSettings = {
  enabled: boolean; workLinkEnabled: boolean; audioGateEnabled: boolean; apiKey: string;
  model: string; voice: string; instructions: string; enableProactiveSpeak: boolean;
  dialogId: string; speed: number; loudness: number; enableMusic: boolean;
  clonedVoices: Array<{ id: string; status: number | null; statusName: string; updatedAt: number }>;
};
const FILE = 'voice-realtime-settings.v2.json';
function normalize(raw: Partial<RealtimeConversationSettings>): RealtimeConversationSettings {
  return {
    enabled: raw.enabled !== false, workLinkEnabled: raw.workLinkEnabled === true,
    audioGateEnabled: false, apiKey: String(raw.apiKey || '').trim(),
    model: String(raw.model || DEFAULT_REALTIME_VOICE_MODEL).trim(), voice: String(raw.voice || DEFAULT_REALTIME_VOICE_ID).trim(),
    instructions: String(raw.instructions || DEFAULT_REALTIME_VOICE_INSTRUCTIONS).slice(0, 8_000),
    enableProactiveSpeak: Boolean(raw.enableProactiveSpeak), dialogId: String(raw.dialogId || '').trim().slice(0, 200),
    speed: Math.max(-50, Math.min(100, Number(raw.speed) || 0)), loudness: Math.max(-50, Math.min(100, Number(raw.loudness) || 0)),
    enableMusic: raw.enableMusic !== false,
    clonedVoices: Array.isArray(raw.clonedVoices) ? raw.clonedVoices.map(item => ({ id: String(item?.id || '').trim(), status: item?.status == null ? null : Number(item.status), statusName: String(item?.statusName || ''), updatedAt: Number(item?.updatedAt) || Date.now() })).filter(item => item.id).slice(0, 50) : [],
  };
}
export function readRealtimeConversationSettings() {
  const saved = readSettingsFile<RealtimeConversationSettings>(FILE);
  if (saved) return normalize(saved);
  return writeSettingsFile(FILE, normalize(readLegacySettings()));
}
export function saveRealtimeConversationSettings(input: Record<string, unknown>) {
  const current = readRealtimeConversationSettings();
  return writeSettingsFile(FILE, normalize({ ...current, ...input, apiKey: input.clearApiKey ? '' : String(input.apiKey || '').trim() || current.apiKey, clonedVoices: Array.isArray(input.clonedVoices) ? input.clonedVoices as RealtimeConversationSettings['clonedVoices'] : current.clonedVoices }));
}
type ProviderVoiceRuntime = { provider: 'volcengine' | 'qwen'; apiKey: string; model: string; voice: string; endpoint: string; providerName: string };
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function resolveProviderRealtimeVoice(): ProviderVoiceRuntime | null {
  const settings = record(getSecrets().model);
  const models = Array.isArray(settings.models) ? settings.models.map(record) : [];
  const bindings = Array.isArray(settings.capabilityBindings) ? settings.capabilityBindings.map(record) : [];
  const boundId = String(bindings.find(item => item.capability === 'realtime' && item.enabled !== false)?.modelId || '');
  const model = models.find(item => item.capability === 'realtime' && (!boundId || item.id === boundId));
  if (!model) return null;
  const providers = Array.isArray(settings.providerInstances) ? settings.providerInstances.map(record) : [];
  const provider = providers.find(item => item.id === model.providerInstanceId);
  if (!provider || !['volcengine', 'qwen'].includes(String(provider.type)) || !String(provider.apiKey || '').trim()) return null;
  const providerId = String(provider.type) as ProviderVoiceRuntime['provider'];
  const endpoints = record(provider.endpoints);
  const endpoint = resolveProviderServiceEndpoint({
    provider: providerId, baseUrl: String(provider.baseUrl || (providerId === 'qwen' ? 'https://dashscope.aliyuncs.com' : 'https://openspeech.bytedance.com')),
    workspaceId: String(provider.workspaceId || ''), service: provider.service === 'unified' ? 'unified' : 'realtime', endpoint: 'realtime',
    endpoints: Object.fromEntries(Object.entries(endpoints).filter(([, value]) => typeof value === 'string')),
  });
  return {
    provider: providerId, apiKey: String(provider.apiKey).trim(), model: String(model.modelId || (providerId === 'qwen' ? 'qwen-audio-3.1-realtime-plus' : DEFAULT_REALTIME_VOICE_MODEL)).trim(),
    voice: String(model.voice || (providerId === 'qwen' ? 'longanqian_v3.1' : DEFAULT_REALTIME_VOICE_ID)).trim(), endpoint,
    providerName: String(provider.name || (providerId === 'qwen' ? '通义千问' : '火山引擎')).trim(),
  };
}
export function resolveRealtimeKey(value = readRealtimeConversationSettings()) {
  const provider = resolveProviderRealtimeVoice();
  return (provider?.provider === 'volcengine' ? process.env.OPENCLAWX_VOLCENGINE_REALTIME_API_KEY?.trim() : '') || provider?.apiKey || process.env.OPENCLAWX_VOLCENGINE_REALTIME_API_KEY?.trim() || value.apiKey;
}
export function resolveRealtimeRuntime(value = readRealtimeConversationSettings()) {
  const provider = resolveProviderRealtimeVoice();
  return {
    ...value,
    provider: provider?.provider || 'volcengine' as const,
    model: provider?.model || value.model,
    voice: provider?.voice || value.voice,
    endpoint: (provider?.provider === 'volcengine' ? process.env.OPENCLAWX_VOLCENGINE_REALTIME_URL?.trim() : '') || provider?.endpoint || process.env.OPENCLAWX_VOLCENGINE_REALTIME_URL?.trim() || 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue',
    providerName: provider?.providerName || '旧版语音配置',
    source: provider ? 'provider' as const : 'legacy' as const,
  };
}
export function publicRealtimeConversationSettings(value = readRealtimeConversationSettings()) {
  const key = resolveRealtimeKey(value);
  const runtime = resolveRealtimeRuntime(value);
  return { ...value, model: runtime.model, voice: runtime.voice, apiKey: undefined, configured: Boolean(key), apiKeyMasked: key ? `••••••••${key.slice(-4)}` : '', apiKeySource: process.env.OPENCLAWX_VOLCENGINE_REALTIME_API_KEY?.trim() ? 'environment' : runtime.source, providerName: runtime.providerName, audioGateEnabled: false };
}
/** One-time desktop migration source. The authenticated admin immediately moves this secret into safeStorage. */
export function legacyRealtimeMigrationSource(value = readRealtimeConversationSettings()) {
  return {
    available: Boolean(value.apiKey), apiKey: value.apiKey, model: value.model, voice: value.voice,
    instructions: value.instructions, enableProactiveSpeak: value.enableProactiveSpeak,
    speed: value.speed, loudness: value.loudness, enableMusic: value.enableMusic,
  };
}
