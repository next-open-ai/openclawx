import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsrResourceSchema, VoiceModeSchema } from '@openclawx/contracts';

export const DEFAULT_REALTIME_VOICE_MODEL = '1.2.6.1';
export const DEFAULT_REALTIME_VOICE_ID = 'zh_female_vv_jupiter_bigtts';
export const DEFAULT_REALTIME_VOICE_INSTRUCTIONS = '你是 OpenClawX 的实时语音助手。使用简洁自然的中文交流，不要声称执行了尚未执行的业务操作。';

export type RealtimeVoiceSettings = {
  enabled: boolean;
  workLinkEnabled: boolean;
  audioGateEnabled: boolean;
  apiKey: string;
  voiceMode: 'realtime' | 'input';
  asrEnabled: boolean;
  asrReuseKey: boolean;
  asrApiKey: string;
  asrResourceId: string;
  asrEnablePunc: boolean;
  asrEnableItn: boolean;
  model: string;
  voice: string;
  instructions: string;
  enableProactiveSpeak: boolean;
  dialogId: string;
  speed: number;
  loudness: number;
  enableMusic: boolean;
  clonedVoices: Array<{ id: string; status: number | null; statusName: string; updatedAt: number }>;
};

function settingsPath() {
  const root = process.env.OPENCLAWX_DATA_DIR || path.join(os.homedir(), '.openclawx');
  return path.join(root, 'voice-realtime-settings.json');
}

function defaults(): RealtimeVoiceSettings {
  return {
    enabled: true,
    workLinkEnabled: false,
    audioGateEnabled: false,
    apiKey: '',
    voiceMode: 'realtime', asrEnabled: true, asrReuseKey: true, asrApiKey: '',
    asrResourceId: 'volc.seedasr.sauc.duration', asrEnablePunc: true, asrEnableItn: true,
    model: DEFAULT_REALTIME_VOICE_MODEL,
    voice: DEFAULT_REALTIME_VOICE_ID,
    instructions: DEFAULT_REALTIME_VOICE_INSTRUCTIONS,
    enableProactiveSpeak: false,
    dialogId: '', speed: 0, loudness: 0, enableMusic: true, clonedVoices: [],
  };
}

export function readRealtimeVoiceSettings(): RealtimeVoiceSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Partial<RealtimeVoiceSettings>;
    return {
      enabled: raw.enabled !== false,
      workLinkEnabled: raw.workLinkEnabled === true,
      audioGateEnabled: raw.audioGateEnabled !== false,
      apiKey: String(raw.apiKey || '').trim(),
      voiceMode: VoiceModeSchema.catch('realtime').parse(raw.voiceMode),
      asrEnabled: raw.asrEnabled !== false, asrReuseKey: raw.asrReuseKey !== false,
      asrApiKey: String(raw.asrApiKey || '').trim(),
      asrResourceId: AsrResourceSchema.catch('volc.seedasr.sauc.duration').parse(raw.asrResourceId),
      asrEnablePunc: raw.asrEnablePunc !== false, asrEnableItn: raw.asrEnableItn !== false,
      model: String(raw.model || DEFAULT_REALTIME_VOICE_MODEL).trim(),
      voice: String(raw.voice || DEFAULT_REALTIME_VOICE_ID).trim(),
      instructions: String(raw.instructions || DEFAULT_REALTIME_VOICE_INSTRUCTIONS).slice(0, 8_000),
      enableProactiveSpeak: Boolean(raw.enableProactiveSpeak),
      dialogId: String(raw.dialogId || '').trim().slice(0, 200),
      speed: Math.max(-50, Math.min(100, Number(raw.speed) || 0)),
      loudness: Math.max(-50, Math.min(100, Number(raw.loudness) || 0)),
      enableMusic: raw.enableMusic !== false,
      clonedVoices: Array.isArray(raw.clonedVoices) ? raw.clonedVoices.map((item) => ({
        id: String(item?.id || '').trim(), status: item?.status == null ? null : Number(item.status),
        statusName: String(item?.statusName || ''), updatedAt: Number(item?.updatedAt) || Date.now(),
      })).filter((item) => item.id).slice(0, 50) : [],
    };
  } catch {
    return defaults();
  }
}

export function publicRealtimeVoiceSettings(value = readRealtimeVoiceSettings()) {
  const apiKey = process.env.OPENCLAWX_VOLCENGINE_REALTIME_API_KEY?.trim() || value.apiKey;
  const asrKey = resolveAsrKey(value);
  return {
    enabled: value.enabled,
    workLinkEnabled: value.workLinkEnabled,
    // Keep the persisted field for downgrade compatibility, but the stable
    // transport intentionally does not expose the experimental gate.
    audioGateEnabled: false,
    voiceMode: value.voiceMode, asrEnabled: value.asrEnabled, asrReuseKey: value.asrReuseKey,
    asrResourceId: value.asrResourceId, asrEnablePunc: value.asrEnablePunc, asrEnableItn: value.asrEnableItn,
    asrConfigured: Boolean(asrKey), asrApiKeyMasked: asrKey ? `••••••••${asrKey.slice(-4)}` : '',
    asrKeySource: value.asrReuseKey ? 'realtime' : process.env.OPENCLAWX_VOLCENGINE_ASR_API_KEY?.trim() ? 'environment' : 'settings',
    configured: Boolean(apiKey),
    apiKeyMasked: apiKey ? `••••••••${apiKey.slice(-4)}` : '',
    model: value.model,
    voice: value.voice,
    instructions: value.instructions,
    enableProactiveSpeak: value.enableProactiveSpeak,
    dialogId: value.dialogId,
    speed: value.speed,
    loudness: value.loudness,
    enableMusic: value.enableMusic,
    clonedVoices: value.clonedVoices,
    apiKeySource: process.env.OPENCLAWX_VOLCENGINE_REALTIME_API_KEY?.trim() ? 'environment' : 'settings',
  };
}

export function saveRealtimeVoiceSettings(input: Record<string, unknown>) {
  const current = readRealtimeVoiceSettings();
  const next: RealtimeVoiceSettings = {
    enabled: input.enabled !== false,
    workLinkEnabled: input.workLinkEnabled === undefined ? current.workLinkEnabled : input.workLinkEnabled === true,
    audioGateEnabled: input.audioGateEnabled === undefined ? current.audioGateEnabled : input.audioGateEnabled === true,
    apiKey: input.clearApiKey ? '' : String(input.apiKey || '').trim() || current.apiKey,
    voiceMode: VoiceModeSchema.parse(input.voiceMode ?? current.voiceMode),
    asrEnabled: input.asrEnabled === undefined ? current.asrEnabled : input.asrEnabled === true,
    asrReuseKey: input.asrReuseKey === undefined ? current.asrReuseKey : input.asrReuseKey === true,
    asrApiKey: input.clearAsrApiKey ? '' : String(input.asrApiKey || '').trim() || current.asrApiKey,
    asrResourceId: AsrResourceSchema.parse(input.asrResourceId ?? current.asrResourceId),
    asrEnablePunc: input.asrEnablePunc === undefined ? current.asrEnablePunc : input.asrEnablePunc === true,
    asrEnableItn: input.asrEnableItn === undefined ? current.asrEnableItn : input.asrEnableItn === true,
    model: String(input.model || current.model || DEFAULT_REALTIME_VOICE_MODEL).trim().slice(0, 100),
    voice: String(input.voice || current.voice || DEFAULT_REALTIME_VOICE_ID).trim().slice(0, 200),
    instructions: String(input.instructions || current.instructions || DEFAULT_REALTIME_VOICE_INSTRUCTIONS).slice(0, 8_000),
    enableProactiveSpeak: Boolean(input.enableProactiveSpeak),
    dialogId: String(input.dialogId ?? current.dialogId).trim().slice(0, 200),
    speed: Math.max(-50, Math.min(100, Number(input.speed) || 0)),
    loudness: Math.max(-50, Math.min(100, Number(input.loudness) || 0)),
    enableMusic: input.enableMusic !== false,
    clonedVoices: Array.isArray(input.clonedVoices) ? input.clonedVoices.map((item) => {
      const voice = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return { id: String(voice.id || '').trim(), status: voice.status == null ? null : Number(voice.status), statusName: String(voice.statusName || ''), updatedAt: Number(voice.updatedAt) || Date.now() };
    }).filter((item) => item.id).slice(0, 50) : current.clonedVoices,
  };
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function resolveAsrKey(value = readRealtimeVoiceSettings()) {
  return value.asrReuseKey
    ? process.env.OPENCLAWX_VOLCENGINE_REALTIME_API_KEY?.trim() || value.apiKey
    : process.env.OPENCLAWX_VOLCENGINE_ASR_API_KEY?.trim() || value.asrApiKey;
}
