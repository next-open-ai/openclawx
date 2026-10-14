import { getStoredSessionToken } from './auth';
import { AsrEventSchema, RealtimeVoiceUsageSchema, type AsrPublicSettings, type AsrEvent, type RealtimeVoiceUsage, type VoiceInterruptDiagnostic } from '@workmate/contracts';
export { RealtimeVoiceUsageSchema };
export type { RealtimeVoiceUsage };

export type RealtimeVoiceEvent = {
  type: string;
  event?: Record<string, unknown>;
  message?: string;
  [key: string]: unknown;
};

export type RealtimeVoiceSettings = AsrPublicSettings & {
  enabled: boolean;
  workLinkEnabled: boolean;
  audioGateEnabled: boolean;
  configured: boolean;
  apiKeyMasked: string;
  apiKeySource: 'settings' | 'environment' | 'provider' | 'legacy';
  providerName?: string;
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

/** 100 ms of mono PCM16 at 16 kHz. Batching avoids one HTTP request per 20 ms frame. */
export const REALTIME_AUDIO_BATCH_BYTES = 3_200;
/** Poll slightly faster than a batch fills without adding perceptible speech latency. */
export const REALTIME_AUDIO_PUMP_INTERVAL_MS = 40;

function apiBase() {
  return window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
}

function authHeaders(json = false) {
  const token = getStoredSessionToken();
  return {
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(token ? { 'x-workmate-session': token } : {}),
  };
}

async function checkedJson(response: Response) {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || body.ok === false) throw new Error(String(body.error || body.message || `实时语音请求失败：HTTP ${response.status}`));
  return body;
}

async function command(operation: string, payload: Record<string, unknown>) {
  const response = await fetch(`${apiBase()}/api/voice/realtime/${operation}`, {
    method: 'POST', headers: authHeaders(true), body: JSON.stringify(payload),
    ...(['interrupt', 'playback', 'diagnostics'].includes(operation) ? { signal: AbortSignal.timeout(3_000) } : {}),
  });
  return checkedJson(response);
}

export async function realtimeVoiceCapabilities() {
  const response = await fetch(`${apiBase()}/api/voice/realtime/capabilities`, { headers: authHeaders() });
  return checkedJson(response) as Promise<{ voiceMode?: 'realtime' | 'input'; realtime?: { enabled?: boolean; audioGateEnabled?: boolean; providers?: string[] }; asr?: { enabled: boolean; configured: boolean } }>;
}

export async function getRealtimeVoiceSettings() {
  const [realtime, asr, preferences] = await Promise.all([
    fetch(`${apiBase()}/api/settings/voice/conversation`, { headers: authHeaders() }).then(checkedJson),
    fetch(`${apiBase()}/api/settings/voice/input`, { headers: authHeaders() }).then(checkedJson),
    fetch(`${apiBase()}/api/settings/voice/preferences`, { headers: authHeaders() }).then(checkedJson),
  ]) as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
  return {
    ...realtime,
    voiceMode: preferences.defaultMode,
    asrEnabled: asr.enabled, asrReuseKey: asr.reuseRealtimeKey,
    asrResourceId: asr.resourceId, asrEnablePunc: asr.enablePunc, asrEnableItn: asr.enableItn,
    asrConfigured: asr.configured, asrApiKeyMasked: asr.apiKeyMasked, asrKeySource: asr.keySource,
  } as RealtimeVoiceSettings;
}

export async function getLegacyRealtimeMigrationSource() {
  const response = await fetch(`${apiBase()}/api/settings/voice/conversation/migration-source`, { headers: authHeaders() });
  return checkedJson(response) as Promise<{ available: boolean; apiKey: string; model: string; voice: string; instructions: string; enableProactiveSpeak: boolean; speed: number; loudness: number; enableMusic: boolean }>;
}

export async function saveRealtimeVoiceSettings(input: {
  enabled: boolean;
  workLinkEnabled: boolean;
  audioGateEnabled: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
  voiceMode: 'realtime' | 'input'; asrEnabled: boolean; asrReuseKey: boolean;
  asrApiKey?: string; clearAsrApiKey?: boolean; asrResourceId: AsrPublicSettings['asrResourceId'];
  asrEnablePunc: boolean; asrEnableItn: boolean;
  model: string;
  voice: string;
  instructions: string;
  enableProactiveSpeak: boolean;
  dialogId: string;
  speed: number;
  loudness: number;
  enableMusic: boolean;
  clonedVoices: RealtimeVoiceSettings['clonedVoices'];
}) {
  const capabilityRequest = input.voiceMode === 'input'
    ? fetch(`${apiBase()}/api/settings/voice/input`, { method: 'PUT', headers: authHeaders(true), body: JSON.stringify({ enabled: input.asrEnabled, reuseRealtimeKey: input.asrReuseKey, apiKey: input.asrApiKey, clearApiKey: input.clearAsrApiKey, resourceId: input.asrResourceId, enablePunc: input.asrEnablePunc, enableItn: input.asrEnableItn }) }).then(checkedJson)
    : fetch(`${apiBase()}/api/settings/voice/conversation`, { method: 'PUT', headers: authHeaders(true), body: JSON.stringify({ enabled: input.enabled, workLinkEnabled: input.workLinkEnabled, audioGateEnabled: input.audioGateEnabled, apiKey: input.apiKey, clearApiKey: input.clearApiKey, model: input.model, voice: input.voice, instructions: input.instructions, enableProactiveSpeak: input.enableProactiveSpeak, dialogId: input.dialogId, speed: input.speed, loudness: input.loudness, enableMusic: input.enableMusic, clonedVoices: input.clonedVoices }) }).then(checkedJson);
  await Promise.all([capabilityRequest, fetch(`${apiBase()}/api/settings/voice/preferences`, { method: 'PUT', headers: authHeaders(true), body: JSON.stringify({ defaultMode: input.voiceMode }) }).then(checkedJson)]);
  return getRealtimeVoiceSettings();
}

export async function trainRealtimeVoiceClone(input: {
  voiceId: string; audio: { format: string; data: string }; text?: string; demoText?: string;
  enableAudioDenoise?: boolean; keepOriginalVolume?: boolean;
}) {
  const body = await command('clone/train', input);
  return body.voice as RealtimeVoiceSettings['clonedVoices'][number];
}

export async function queryRealtimeVoiceClone(voiceId: string) {
  const body = await command('clone/status', { voiceId });
  return body.voice as RealtimeVoiceSettings['clonedVoices'][number];
}

export async function createRealtimeVoiceSession(input: { conversationId?: string }) {
  const body = await command('session', { ...input, clientPlayback: true });
  return { sessionId: String(body.session_id || ''), provider: String(body.provider || ''), providerName: String(body.providerName || ''), model: String(body.model || '') };
}

export async function sendRealtimeVoiceAudio(sessionId: string, bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  await command('audio', { session_id: sessionId, audio: btoa(binary) });
}

export async function commitRealtimeVoiceAudio(sessionId: string) {
  await command('audio_commit', { session_id: sessionId });
}

export async function interruptRealtimeVoice(sessionId: string, responseEpoch: number, diagnostic?: VoiceInterruptDiagnostic) {
  return command('interrupt', { session_id: sessionId, responseEpoch, diagnostic });
}
export async function reportVoiceDiagnostic(sessionId: string, diagnostic: VoiceInterruptDiagnostic) {
  return command('diagnostics', { session_id: sessionId, diagnostic });
}
export async function reportRealtimePlayback(sessionId: string, responseEpoch: number, busy: boolean) {
  return command('playback', { session_id: sessionId, responseEpoch, busy });
}

export async function setRealtimeVoiceAudioMuted(sessionId: string, muted: boolean) {
  await command('audio_mute', { session_id: sessionId, muted });
}

export async function closeRealtimeVoiceSession(sessionId: string) {
  await command('close', { session_id: sessionId });
}

export async function consumeRealtimeVoiceEvents(sessionId: string, signal: AbortSignal, onEvent: (event: RealtimeVoiceEvent) => void) {
  return consumeEvents('realtime', sessionId, signal, onEvent);
}

async function consumeEvents(mode: 'realtime' | 'asr', sessionId: string, signal: AbortSignal, onEvent: (event: RealtimeVoiceEvent) => void) {
  const response = await fetch(`${apiBase()}/api/voice/${mode}/events?${new URLSearchParams({ session_id: sessionId })}`, {
    headers: authHeaders(), signal,
  });
  if (!response.ok || !response.body) await checkedJson(response);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (data) {
        let event: RealtimeVoiceEvent | undefined;
        try { event = JSON.parse(data) as RealtimeVoiceEvent; } catch { /* ignore malformed upstream diagnostics */ }
        if (event) onEvent(event);
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

export async function asrCommand(operation: 'session' | 'audio' | 'finish' | 'close', payload: Record<string, unknown> = {}) {
  const response = await fetch(`${apiBase()}/api/voice/asr/${operation}`, { method: 'POST', headers: authHeaders(true), body: JSON.stringify(payload) });
  return checkedJson(response);
}
export async function consumeAsrEvents(sessionId: string, signal: AbortSignal, onEvent: (event: AsrEvent) => void) {
  return consumeEvents('asr', sessionId, signal, (event) => { const parsed = AsrEventSchema.safeParse(event); if (parsed.success) onEvent(parsed.data); });
}
