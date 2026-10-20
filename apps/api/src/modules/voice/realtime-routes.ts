import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import WebSocket from 'ws';
import { VoiceSessionCreateSchema, RealtimeVoiceInterruptSchema, RealtimeVoicePlaybackSchema, RealtimeVoiceDiagnosticSchema, VoicePlaybackStopSchema } from '@openclawx/contracts';
import { VoiceResponseGate } from './response-gate.js';
import { explicitPlaybackStop } from './playback-control.js';
import { getOrchestrator } from '../orchestration/routes.js';
import {activeDataRunOwner} from '../auth/service.js';
import { completionNotice, VoiceWorkBridge } from './work-bridge.js';
import {createVoiceWorkResultRanker} from '../work-results/voice-ranking.js';
import {
  DEFAULT_REALTIME_VOICE_ID,
  DEFAULT_REALTIME_VOICE_INSTRUCTIONS,
  DEFAULT_REALTIME_VOICE_MODEL,
  readRealtimeConversationSettings,
  resolveRealtimeKey,
  resolveRealtimeRuntime,
} from './realtime-settings.js';
import { publicVoiceInputSettings } from './asr-settings.js';
import { readVoicePreferences } from './voice-preferences.js';
import { realtimeProviderAdapter, RealtimeUsageMeter, type RealtimeFunctionResult, type RealtimeProtocolConfig } from './realtime-provider-adapters.js';

type VoiceEvent = { type: string; ts: number; event?: Record<string, unknown>; message?: string; [key: string]: unknown };
type Owner = { orgId: string; userId: string };

const MAX_SESSIONS = 20;
const SESSION_TTL_MS = 30 * 60 * 1000;
const VOICE_CLONE_TRAIN_URL = 'https://openspeech.bytedance.com/api/v3/tts/voice_clone';
const VOICE_CLONE_STATUS_URL = 'https://openspeech.bytedance.com/api/v3/tts/voice_clone/status';

export class VoiceCapacityError extends Error { readonly code = 'VOICE_CAPACITY'; }

export class RealtimeVoiceSession {
  readonly id = randomUUID().replaceAll('-', '');
  readonly createdAt = Date.now();
  readonly listeners = new Set<(event: VoiceEvent) => void>();
  readonly backlog: VoiceEvent[] = [];
  private socket: WebSocket | null = null;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private ready = false;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private firstAudio = false;
  private stage = 'connecting';
  private closed = false;
  private workBridge: VoiceWorkBridge | null = null;
  private workTasks = new Set<string>();
  private workTimer: ReturnType<typeof setInterval> | undefined;
  private pollingWork = false;
  private workStates = new Map<string, string>();
  private adapter;
  private usageMeter;
  private responses = new VoiceResponseGate();
  private playbackBusy = false;
  private workCallsInFlight = 0;
  private lastDiagnosticAt = -Infinity;
  private lastUserTranscript = '';
  private playbackStops = new Set<string>();
  takeDiagnosticSlot() {
    const now = Date.now(); if (now - this.lastDiagnosticAt < 1000) return false;
    this.lastDiagnosticAt = now; return true;
  }
  private pendingNotices: Array<NonNullable<ReturnType<typeof completionNotice>>> = [];
  private interruptEventIds = new Set<string>();

  constructor(readonly owner: Owner, private config: Record<string, unknown>, apiKey: string, private lifecycleLog: (event: Record<string, unknown>) => void = () => undefined, startupTimeoutMs = 25_000) {
    this.adapter = realtimeProviderAdapter(String(config.provider || 'volcengine'));
    this.usageMeter = new RealtimeUsageMeter(this.adapter.id, String(config.model || DEFAULT_REALTIME_VOICE_MODEL), this.createdAt);
    if (this.config.workLinkEnabled) {
      this.workBridge = new VoiceWorkBridge(getOrchestrator(), owner, () => Boolean(this.config.workLinkEnabled) && readRealtimeConversationSettings().workLinkEnabled, this.config.conversationId as string | undefined,activeDataRunOwner,createVoiceWorkResultRanker(getOrchestrator(),owner,()=>this.workBridge?.currentConversationId,event=>this.lifecycleLog({voiceSessionId:this.id,...event})));
      // Completion notices are user-facing realtime events. A short bounded
      // poll keeps them prompt without coupling task lifetime to the voice UI.
      this.workTimer = setInterval(() => { void this.pollWork(); }, 600);
      this.workTimer.unref();
    }
    this.readyPromise = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.readyPromise.catch(() => undefined);
    this.readyTimer = setTimeout(() => this.startupFailed(new Error(`${this.adapter.label}初始化超时（${this.stage}），请检查网络或模型配置。`)), startupTimeoutMs);
    this.readyTimer.unref();
    this.connect(apiKey);
  }

  async waitReady() { await this.readyPromise; if (this.closed) throw new Error('实时语音会话已关闭。'); }
  private logStage(stage: string) {
    this.stage = stage;
    this.lifecycleLog({ voiceSessionId: this.id, stage, elapsedMs: Date.now() - this.createdAt });
  }
  private startupFailed(error: Error) {
    if (this.ready || this.closed) return;
    this.logStage('startup_failed'); clearTimeout(this.readyTimer);
    this.rejectReady(error); this.emit({ type: 'local.error', message: error.message }); this.close(false);
  }

  private emit(event: Omit<VoiceEvent, 'ts'>) {
    const value = { ts: Date.now(), ...event } as VoiceEvent;
    if (!this.listeners.size) {
      this.backlog.push(value);
      if (this.backlog.length > 256) this.backlog.shift();
    }
    for (const listener of this.listeners) listener(value);
  }

  private connect(apiKey: string) {
    const upstreamUrl = this.adapter.connectionUrl(this.protocolConfig());
    const socket = new WebSocket(upstreamUrl, {
      headers: this.adapter.headers(apiKey, this.id),
      handshakeTimeout: 15_000,
    });
    this.socket = socket;
    socket.once('open', () => {
      if (this.closed) return;
      this.logStage('ws_open');
      const create = this.adapter.initialEvent(this.protocolConfig());
      this.emit({ type: 'local.session_create', event: create });
      socket.send(JSON.stringify(create));
      this.stage = 'awaiting_config';
    });
    socket.on('message', (raw) => {
      if (this.closed) return;
      try {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!this.ready && this.adapter.readyEvent(event) && !this.closed) {
          this.ready = true; clearTimeout(this.readyTimer); this.logStage('config_ready'); this.resolveReady();
          this.emit({ type: 'local.connected', session_id: this.id });
        }
        if (!this.ready && event.type === 'error') {
          const detail = event.error as Record<string, unknown> | undefined;
          const code = String(detail?.code || event.code || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
          this.startupFailed(new Error(`${this.adapter.label}初始化配置失败${code ? `（${code}）` : ''}，请检查模型、音色及凭据。`)); return;
        }
        if (['input_audio_buffer.speech_started', 'conversation.item.input_audio_transcription.started', 'response.done'].includes(String(event.type))) {
          const response = event.response as Record<string, unknown> | undefined;
          this.lifecycleLog({ voiceSessionId: this.id, eventType: event.type, responseEpoch: this.responses.epoch,
            responseStatus: ['completed', 'cancelled', 'failed', 'incomplete'].includes(String(response?.status)) ? response?.status : undefined });
        }
        const usage = this.usageMeter.record(event); if (usage) this.emit({ type: 'local.usage', usage });
        // A cancel may race server VAD/response.done. A correlated cancel error
        // is nonfatal; unrelated provider errors retain their original behavior.
        const detail = event.error as Record<string, unknown> | undefined;
        if (event.type === 'error' && this.interruptEventIds.delete(String(detail?.event_id || event.client_event_id || ''))) {
          this.emit({ type: 'local.interrupt_warning', message: '回答已在本地停止，上游中断未确认；可继续讲话。' }); return;
        }
        const speechStart = event.type === 'input_audio_buffer.speech_started' || event.type === 'conversation.item.input_audio_transcription.started';
        if (speechStart) this.lastUserTranscript = '';
        if (speechStart && !this.responses.userSpeaking && (this.responses.active || this.playbackBusy)) {
          this.responses.interrupt(); this.playbackBusy = false;
          this.emit({ type: 'local.provider_interrupted', responseEpoch: this.responses.epoch });
        }
        if (event.type === 'conversation.item.input_audio_transcription.completed') this.lastUserTranscript = String(event.transcript || event.text || event.delta || '').slice(0, 1000);
        if (!this.responses.accept(event)) return;
        if (this.config.clientPlayback && (event.type === 'response.audio.delta' || event.type === 'response.output_audio.delta')) this.playbackBusy = true;
        this.emit({ type: 'upstream.event', event, responseEpoch: this.responses.epoch });
        if (this.adapter.functionCalls(event).length) void this.handleWorkCalls(event);
        if (event.type === 'session.closed' || event.type === 'error') this.close(false);
      } catch {
        const message = `${this.adapter.label}返回了无法解析的事件。`;
        if (!this.ready) this.startupFailed(new Error(message));
        else this.emit({ type: 'local.error', message });
      }
    });
    socket.once('unexpected-response', (_request, response) => {
      const status = `HTTP ${response.statusCode} ${response.statusMessage || ''}`.trim();
      const error = new Error(`${this.adapter.label}握手失败：${status}`);
      this.startupFailed(error);
    });
    socket.once('error', (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (!this.ready) this.startupFailed(new Error(`${this.adapter.label}连接失败：${error.message}`));
      else this.emit({ type: 'local.error', message: `${this.adapter.label}连接失败：${error.message}` });
    });
    socket.once('close', () => {
      clearTimeout(this.readyTimer); this.rejectReady(new Error(`${this.adapter.label}会话在就绪前关闭。`)); this.logStage('closed');
      clearInterval(this.workTimer);
      this.closed = true; this.emit({ type: 'local.closed' });
    });
  }

  private protocolConfig(): RealtimeProtocolConfig {
    return {
      provider: this.adapter.id, endpoint: String(this.config.endpoint || ''),
      model: String(this.config.model || DEFAULT_REALTIME_VOICE_MODEL), voice: String(this.config.voice || DEFAULT_REALTIME_VOICE_ID),
      instructions: String(this.config.instructions || DEFAULT_REALTIME_VOICE_INSTRUCTIONS), workLinkEnabled: Boolean(this.config.workLinkEnabled),
      dialogId: String(this.config.dialogId || ''), speed: Number(this.config.speed) || 0, loudness: Number(this.config.loudness) || 0,
      enableMusic: Boolean(this.config.enableMusic), enableProactiveSpeak: Boolean(this.config.enableProactiveSpeak),
    };
  }

  private async handleWorkCalls(event: Record<string, unknown>) {
    this.workCallsInFlight++;
    const epoch = this.responses.epoch;
    const results: RealtimeFunctionResult[] = [];
    for (const call of this.adapter.functionCalls(event)) {
      if (epoch !== this.responses.epoch || this.responses.blocked) break;
      const { callId, name } = call;
      let result: unknown;
      try {
        if (name === 'stop_voice_playback') {
          VoicePlaybackStopSchema.parse(call.arguments);
          if (this.playbackStops.has(callId)) continue;
          if (!explicitPlaybackStop(this.lastUserTranscript)) {
            results.push({ callId, result: { ok: false, message: '当前用户未明确要求停止播报；未取消任何工作。' } });
            continue;
          }
          if (this.playbackStops.size >= 200) throw new Error('本次通话播报控制已达上限。');
          this.playbackStops.add(callId); this.lastUserTranscript = '';
          this.emit({ type: 'local.playback_stopped', responseEpoch: epoch });
          await this.interrupt(epoch);
          this.emit({ type: 'local.work_result', name, result: { ok: true, status: 'playback_stopped', spokenSummary: '当前播报已停止，后台工作不受影响。' } });
          break;
        }
        if (!this.workBridge) throw new Error('工作能力关联已关闭。');
        result = await this.workBridge.call(callId, name, call.arguments);
        const value = result as Record<string, unknown>;
        if (name==='start_work' && value.ok && value.status==='accepted' && value.taskId) this.workTasks.add(String(value.taskId));
        this.emit({ type: 'local.work_result', name, result });
      } catch (cause) {
        result = { ok: false, status: 'failed', spokenSummary: cause instanceof Error ? cause.message.slice(0, 240) : '工作调用失败。' };
        this.emit({ type: 'local.work_result', name, result });
      }
      if (callId) results.push({ callId, result });
    }
    if (results.length && !this.closed && epoch === this.responses.epoch && !this.responses.blocked) {
      for (const response of this.adapter.functionResultEvents(results)) await this.send(response, epoch).catch(() => undefined);
    }
    this.workCallsInFlight--;
  }

  private async pollWork() {
    if (this.pollingWork || !this.workBridge || this.closed) return;
    this.pollingWork = true;
    try {
      for (const taskId of this.workTasks) {
        try {
          const result = await this.workBridge.status(taskId);
          if (this.workStates.get(taskId) !== result.status) {
            this.workStates.set(taskId, result.status);
            this.emit({ type: 'local.work_result', result });
            const notice = completionNotice(result);
            if (notice) {
              this.pendingNotices.push(notice);
            }
          }
          if (['completed', 'failed', 'cancelled'].includes(result.status)) this.workTasks.delete(taskId);
        } catch { this.workTasks.delete(taskId); }
      }
      if (!this.workCallsInFlight && !this.responses.userSpeaking && !this.responses.active && !this.responses.blocked && !this.playbackBusy) {
        const notice = this.pendingNotices.shift();
        if (notice) {
          this.responses.active = true;
          let delivery: 'provider' | 'fallback' = 'provider';
          const epoch = this.responses.epoch;
          try { for (const event of this.adapter.notificationEvents(notice.text)) await this.send(event, epoch); }
          catch { delivery = 'fallback'; this.responses.active = false; }
          this.emit({ type: 'local.work_notice', notice: { ...notice, delivery } });
        }
      }
    } finally { this.pollingWork = false; }
  }

  private async send(value: Record<string, unknown>, responseEpoch?: number) {
    await this.readyPromise;
    if (responseEpoch !== undefined && (responseEpoch !== this.responses.epoch || this.responses.blocked)) return;
    if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('实时语音会话已关闭。');
    this.socket.send(JSON.stringify(value));
  }

  async sendAudio(audio: string) {
    await this.send(this.adapter.audioEvent(audio)); this.usageMeter.addInputBase64(audio);
    if (!this.firstAudio) { this.firstAudio = true; this.logStage('first_audio'); }
  }
  async interrupt(expected?: number) {
    const wasActive = this.responses.active;
    if (this.responses.interrupt(expected)) {
      this.playbackBusy = false;
      this.emit({ type: 'local.interrupted', responseEpoch: this.responses.epoch });
      if (wasActive) {
        const event = this.adapter.interruptEvent();
        this.interruptEventIds.add(String(event.event_id));
        if (this.interruptEventIds.size > 32) this.interruptEventIds.delete(this.interruptEventIds.values().next().value!);
        await this.send(event);
      }
    }
    return this.responses.epoch;
  }
  setPlaybackBusy(busy: boolean, epoch: number) { if (epoch === this.responses.epoch) this.playbackBusy = busy; }
  commitAudio() { const event = this.adapter.commitEvent(); return event ? this.send(event) : Promise.resolve(); }
  setAudioMuted(muted: boolean) { const event = this.adapter.muteEvent(muted); return event ? this.send(event) : Promise.resolve(); }
  async sendText(text: string) { for (const event of this.adapter.textEvents(text)) await this.send(event); }
  update(input: Record<string, unknown>) {
    this.config = { ...this.config, ...input };
    return this.send(this.adapter.updateEvent(this.protocolConfig()));
  }

  subscribe(listener: (event: VoiceEvent) => void) {
    this.listeners.add(listener);
    for (const event of this.backlog.splice(0)) listener(event);
    return () => this.listeners.delete(listener);
  }

  close(notifyUpstream = true) {
    if (this.closed) return;
    clearTimeout(this.readyTimer); this.rejectReady(new Error(`${this.adapter.label}会话在就绪前关闭。`));
    this.emit({ type: 'local.usage', usage: this.usageMeter.snapshot() });
    this.closed = true;
    clearInterval(this.workTimer);
    const closeEvent = this.adapter.closeEvent();
    if (notifyUpstream && closeEvent && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(closeEvent));
    const timer = setTimeout(() => this.socket?.close(), notifyUpstream ? 800 : 0);
    timer.unref();
  }
}

const sessions = new Map<string, RealtimeVoiceSession>();

function apiKey() {
  const value = resolveRealtimeKey();
  if (!value) throw new Error('尚未配置实时语音 Provider 的 API Key。请前往“设置 > Provider 与模型”完成配置。');
  return value;
}

function principal(request: FastifyRequest) {
  if (!request.auth) throw new Error('Authentication required.');
  return request.auth;
}

function ownedSession(request: FastifyRequest, sessionId: string) {
  const session = sessions.get(sessionId); const auth = principal(request);
  if (!session || session.owner.orgId !== auth.orgId || (session.owner.userId !== auth.userId && auth.role !== 'admin')) return null;
  return session;
}

function reapSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) { session.close(); sessions.delete(id); }
  }
}

/** Shared capacity/configuration; callers must authorize the conversation first. */
export async function createBoundRealtimeVoice(owner: Owner, conversationId: string): Promise<RealtimeVoiceSession> {
  const settings = resolveRealtimeRuntime();
  if (!settings.enabled) throw new Error('实时语音已在设置中关闭。');
  await new VoiceWorkBridge(getOrchestrator(), owner, () => settings.workLinkEnabled, conversationId).validateConversation();
  reapSessions();
  if (sessions.size >= MAX_SESSIONS) throw new VoiceCapacityError('实时语音会话已达到容量上限。');
  const session = new RealtimeVoiceSession(owner, {
    provider: settings.provider,
    model: settings.model, voice: settings.voice, instructions: settings.instructions,
    enableProactiveSpeak: settings.enableProactiveSpeak, dialogId: '', speed: settings.speed,
    loudness: settings.loudness, enableMusic: settings.enableMusic, workLinkEnabled: settings.workLinkEnabled, conversationId,
    endpoint: settings.endpoint,
  }, apiKey());
  sessions.set(session.id, session);
  try { await session.waitReady(); } catch (error) { session.close(false); sessions.delete(session.id); throw error; }
  return session;
}

export function releaseBoundRealtimeVoice(id: string): void {
  sessions.get(id)?.close();
  sessions.delete(id);
}

function body(request: FastifyRequest) {
  return (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
}

function failure(reply: FastifyReply, cause: unknown, status = 400) {
  return reply.code(status).send({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
}

async function postVolcengine(url: string, key: string, payload: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Api-Key': key, 'X-Api-Request-Id': randomUUID().replaceAll('-', '') },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000),
  });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || Number(result.code || 0) !== 0) throw new Error(String(result.message || result.error || `声音复刻请求失败：HTTP ${response.status}`));
  return result;
}

function cloneStatusName(status: unknown) {
  return ({ 0: '未找到', 1: '训练中', 2: '可用', 3: '失败', 4: '已激活' } as Record<number, string>)[Number(status)] || '未知';
}

export async function registerRealtimeVoiceRoutes(app: FastifyInstance) {
  app.get('/voice/realtime/capabilities', async (_request, reply) => {
    const settings = resolveRealtimeRuntime();
    const configured = Boolean(resolveRealtimeKey());
    const enabled = configured && settings.enabled;
    const asr = publicVoiceInputSettings();
    // SeedDuplex expects a continuous real-time audio clock. The previous
    // client VAD sent bursty 100 ms frames and could double-commit a turn
    // already closed by server VAD, producing upstream errors and long waits.
    // Keep the persisted setting compatible with older installations, but do
    // not advertise the retired gate in the stable transport.
    const audioGateEnabled = false;
    return reply.send({ voiceMode: readVoicePreferences().defaultMode, realtime: { enabled, configured, audioGateEnabled, providers: enabled ? [settings.provider] : [] }, asr: { enabled: asr.enabled && asr.configured, configured: asr.configured } });
  });

  app.post('/voice/realtime/session', async (request, reply) => {
    try {
      reapSessions();
      if (sessions.size >= MAX_SESSIONS) return failure(reply, new Error('实时语音会话已达到容量上限。'), 429);
      const auth = principal(request); const settings = resolveRealtimeRuntime();
      const input = VoiceSessionCreateSchema.parse(body(request));
      if (input.conversationId) await new VoiceWorkBridge(getOrchestrator(), { orgId: auth.orgId, userId: auth.userId }, () => settings.workLinkEnabled, input.conversationId).validateConversation();
      if (!settings.enabled) return failure(reply, new Error('实时语音已在设置中关闭。'));
      // Conversation validation awaits I/O; recheck shared capacity afterwards.
      reapSessions();
      if (sessions.size >= MAX_SESSIONS) return failure(reply, new Error('实时语音会话已达到容量上限。'), 429);
      const session = new RealtimeVoiceSession(
        { orgId: auth.orgId, userId: auth.userId },
        { provider: settings.provider, model: settings.model, voice: settings.voice, instructions: settings.instructions, enableProactiveSpeak: settings.enableProactiveSpeak, dialogId: settings.dialogId, speed: settings.speed, loudness: settings.loudness, enableMusic: settings.enableMusic, workLinkEnabled: settings.workLinkEnabled, conversationId: input.conversationId, clientPlayback: input.clientPlayback, endpoint: settings.endpoint },
        apiKey(), event => app.log.info(event, 'voice.lifecycle'),
      );
      sessions.set(session.id, session);
      try { await session.waitReady(); } catch (error) { session.close(false); sessions.delete(session.id); throw error; }
      return reply.send({ ok: true, session_id: session.id, provider: settings.provider, providerName: settings.providerName, model: settings.model });
    } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/clone/train', async (request, reply) => {
    try {
      if (principal(request).role !== 'admin') return failure(reply, new Error('仅管理员可以训练复刻音色。'), 403);
      if (resolveRealtimeRuntime().provider !== 'volcengine') return failure(reply, new Error('当前音色复刻面板仅支持火山实时语音；阿里音色请先在百炼创建，再将音色 ID 填入模型配置。'));
      const input = body(request); const voiceId = String(input.voiceId || '').trim();
      if (!voiceId || /\s/.test(voiceId)) throw new Error('请填写有效的预付费音色槽位 ID。');
      const audio = input.audio && typeof input.audio === 'object' ? input.audio as Record<string, unknown> : {};
      const data = String(audio.data || '').replace(/\s/g, ''); const format = String(audio.format || '').toLowerCase();
      if (!['wav', 'mp3', 'ogg', 'm4a', 'aac', 'pcm'].includes(format) || !data) throw new Error('请选择 WAV、MP3、OGG、M4A、AAC 或 PCM 训练音频。');
      if (Buffer.byteLength(data, 'base64') > 10 * 1024 * 1024) throw new Error('训练音频不能超过 10 MB。');
      const extra: Record<string, unknown> = { enable_audio_denoise: Boolean(input.enableAudioDenoise), disable_volume_normalization: Boolean(input.keepOriginalVolume) };
      if (String(input.demoText || '').trim()) extra.demo_text = String(input.demoText).trim().slice(0, 300);
      const payload: Record<string, unknown> = { speaker_id: voiceId, audio: { data, format }, language: 0, extra_params: extra };
      if (String(input.text || '').trim()) payload.text = String(input.text).trim();
      const result = await postVolcengine(VOICE_CLONE_TRAIN_URL, apiKey(), payload);
      const response = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {};
      return reply.send({ ok: true, voice: { id: voiceId, status: response.status ?? null, statusName: cloneStatusName(response.status), updatedAt: Date.now() } });
    } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/clone/status', async (request, reply) => {
    try {
      if (principal(request).role !== 'admin') return failure(reply, new Error('仅管理员可以查询复刻音色。'), 403);
      if (resolveRealtimeRuntime().provider !== 'volcengine') return failure(reply, new Error('当前音色状态查询仅支持火山实时语音。'));
      const voiceId = String(body(request).voiceId || '').trim(); if (!voiceId || /\s/.test(voiceId)) throw new Error('请填写有效的音色 ID。');
      const result = await postVolcengine(VOICE_CLONE_STATUS_URL, apiKey(), { speaker_id: voiceId });
      const response = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {};
      return reply.send({ ok: true, voice: { id: voiceId, status: response.status ?? null, statusName: cloneStatusName(response.status), updatedAt: Date.now() } });
    } catch (cause) { return failure(reply, cause); }
  });

  // Audio batches are high-frequency transport traffic. Per-request access logs
  // drown out actionable diagnostics; session/error logs remain enabled.
  app.post('/voice/realtime/audio', { logLevel: 'silent' }, async (request, reply) => {
    const input = body(request); const session = ownedSession(request, String(input.session_id || ''));
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    const audio = String(input.audio || '');
    if (!audio || audio.length > 256_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) return failure(reply, new Error('Invalid realtime audio chunk.'));
    try { await session.sendAudio(audio); return reply.send({ ok: true }); } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/audio_commit', async (request, reply) => {
    const input = body(request); const session = ownedSession(request, String(input.session_id || ''));
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    try { await session.commitAudio(); return reply.send({ ok: true }); } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/interrupt', async (request, reply) => {
    try {
      const input = RealtimeVoiceInterruptSchema.parse(body(request));
      const session = ownedSession(request, input.session_id);
      if (!session) return failure(reply, new Error('Voice session not found.'), 404);
      const responseEpoch = await session.interrupt(input.responseEpoch);
      request.log.info({ voiceSessionId: session.id, responseEpoch, expectedEpoch: input.responseEpoch, diagnostic: input.diagnostic }, 'voice.interrupt');
      return reply.send({ ok: true, responseEpoch });
    } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/diagnostics', { logLevel: 'warn' }, async (request, reply) => {
    const parsed = RealtimeVoiceDiagnosticSchema.safeParse(body(request));
    if (!parsed.success) return failure(reply, new Error('Invalid voice diagnostic.'));
    const session = ownedSession(request, parsed.data.session_id);
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    if (session.takeDiagnosticSlot()) app.log.info({ voiceSessionId: session.id, diagnostic: parsed.data.diagnostic }, 'voice.interrupt_candidate');
    return reply.send({ ok: true });
  });

  app.post('/voice/realtime/playback', { logLevel: 'silent' }, async (request, reply) => {
    const parsed = RealtimeVoicePlaybackSchema.safeParse(body(request));
    if (!parsed.success) return failure(reply, new Error('Invalid playback state.'));
    const input = parsed.data; const session = ownedSession(request, input.session_id);
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    session.setPlaybackBusy(input.busy, input.responseEpoch);
    return reply.send({ ok: true });
  });

  app.post('/voice/realtime/audio_mute', async (request, reply) => {
    const input = body(request); const session = ownedSession(request, String(input.session_id || ''));
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    if (typeof input.muted !== 'boolean') return failure(reply, new Error('muted must be boolean.'));
    try { await session.setAudioMuted(input.muted); return reply.send({ ok: true }); } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/text', async (request, reply) => {
    const input = body(request); const session = ownedSession(request, String(input.session_id || ''));
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    const text = String(input.text || '').trim(); if (!text) return failure(reply, new Error('text is required.'));
    try { await session.sendText(text); return reply.send({ ok: true }); } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/session_update', async (request, reply) => {
    const input = body(request); const session = ownedSession(request, String(input.session_id || ''));
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    try { await session.update({ voice: input.voice, instructions: input.instructions }); return reply.send({ ok: true }); } catch (cause) { return failure(reply, cause); }
  });

  app.post('/voice/realtime/close', async (request, reply) => {
    const input = body(request); const id = String(input.session_id || ''); const session = ownedSession(request, id);
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    session.close(); sessions.delete(id); return reply.send({ ok: true });
  });

  app.get('/voice/realtime/events', async (request, reply) => {
    const id = String((request.query as { session_id?: string }).session_id || ''); const session = ownedSession(request, id);
    if (!session) return failure(reply, new Error('Voice session not found.'), 404);
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const write = (event: VoiceEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = session.subscribe(write);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    // The SSE transport is only an event subscription. Browsers may close and
    // recreate it while the microphone upload is still active, so its lifetime
    // must not own the upstream voice session. Sessions are closed explicitly
    // through /close or by the TTL reaper.
    reply.raw.once('close', () => {
      clearInterval(heartbeat); unsubscribe();
    });
  });
}
