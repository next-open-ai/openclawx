import { AsrResourceSchema } from '@openclawx/contracts';
import { readRealtimeVoiceSettings as readLegacySettings } from './legacy-settings.js';
import { readRealtimeConversationSettings, resolveRealtimeKey } from './realtime-settings.js';
import { readSettingsFile, writeSettingsFile } from './settings-files.js';

export type VoiceInputSettings = { enabled: boolean; reuseRealtimeKey: boolean; apiKey: string; resourceId: string; enablePunc: boolean; enableItn: boolean };
const FILE = 'voice-input-settings.json';
function normalize(raw: Partial<VoiceInputSettings>): VoiceInputSettings {
  return { enabled: raw.enabled !== false, reuseRealtimeKey: raw.reuseRealtimeKey !== false, apiKey: String(raw.apiKey || '').trim(), resourceId: AsrResourceSchema.catch('volc.seedasr.sauc.duration').parse(raw.resourceId), enablePunc: raw.enablePunc !== false, enableItn: raw.enableItn !== false };
}
export function readVoiceInputSettings() {
  const saved = readSettingsFile<VoiceInputSettings>(FILE); if (saved) return normalize(saved);
  const legacy = readLegacySettings();
  return writeSettingsFile(FILE, normalize({ enabled: legacy.asrEnabled, reuseRealtimeKey: legacy.asrReuseKey, apiKey: legacy.asrApiKey, resourceId: legacy.asrResourceId, enablePunc: legacy.asrEnablePunc, enableItn: legacy.asrEnableItn }));
}
export function saveVoiceInputSettings(input: Record<string, unknown>) {
  const current = readVoiceInputSettings();
  return writeSettingsFile(FILE, normalize({ enabled: input.enabled === undefined ? current.enabled : input.enabled === true, reuseRealtimeKey: input.reuseRealtimeKey === undefined ? current.reuseRealtimeKey : input.reuseRealtimeKey === true, apiKey: input.clearApiKey ? '' : String(input.apiKey || '').trim() || current.apiKey, resourceId: String(input.resourceId || current.resourceId), enablePunc: input.enablePunc === undefined ? current.enablePunc : input.enablePunc === true, enableItn: input.enableItn === undefined ? current.enableItn : input.enableItn === true }));
}
export function resolveAsrKey(value = readVoiceInputSettings()) { return value.reuseRealtimeKey ? resolveRealtimeKey(readRealtimeConversationSettings()) : process.env.OPENCLAWX_VOLCENGINE_ASR_API_KEY?.trim() || value.apiKey; }
export function publicVoiceInputSettings(value = readVoiceInputSettings()) {
  const key = resolveAsrKey(value);
  return { enabled: value.enabled, reuseRealtimeKey: value.reuseRealtimeKey, resourceId: value.resourceId, enablePunc: value.enablePunc, enableItn: value.enableItn, configured: Boolean(key), apiKeyMasked: key ? `••••••••${key.slice(-4)}` : '', keySource: value.reuseRealtimeKey ? 'realtime' : process.env.OPENCLAWX_VOLCENGINE_ASR_API_KEY?.trim() ? 'environment' : 'settings' };
}
