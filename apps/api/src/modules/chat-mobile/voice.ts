import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { MobileVoiceAudioSchema, MobileVoiceCapabilitiesSchema, MobileVoiceCreateSchema, MobileVoiceSessionSchema } from '@openclawx/contracts';

export type MobileVoiceLink = { sessionId: string; orgId: string; ownerUserId: string; expiresAt: number };
type Event = { type: string; event?: Record<string, unknown>; [key: string]: unknown };
export type MobileVoiceConnection = {
  id: string; sendAudio(audio: string): Promise<void>; commitAudio(): Promise<void>; setAudioMuted(muted: boolean): Promise<void>; subscribe(listener: (event: Event) => void): () => void;
};
type Dependencies = {
  resolve(token: string): Promise<MobileVoiceLink | null>;
  authorized(link: MobileVoiceLink): Promise<boolean>;
  capabilities(): { enabled: boolean; workEnabled: boolean };
  create(link: MobileVoiceLink): Promise<MobileVoiceConnection>;
  release(id: string): void;
};

const visibleEvents = new Set([
  'session.created', 'session.closed', 'error', 'response.done',
  'conversation.item.input_audio_transcription.started',
  'conversation.item.input_audio_transcription.delta', 'conversation.item.input_audio_transcription.completed',
  'response.output_text.delta', 'response.output_text.done',
  'response.output_audio.started', 'response.output_audio.delta', 'response.output_audio.done',
]);

/** Deliberately do not forward session.create prompts, tool arguments or provider diagnostics. */
export function mobileVoiceEvent(value: Event): Event | null {
  if (value.type === 'local.connected' || value.type === 'local.closed') return { type: value.type };
  if (value.type === 'local.error') return { type: 'local.error', message: '语音服务连接失败，请检查电脑端语音配置。' };
  if (value.type === 'local.work_result') {
    const r = value.result as Record<string, unknown> | undefined;
    return r ? { type: value.type, result: { ok: r.ok, status: r.status, title: r.title, spokenSummary: r.spokenSummary, artifactCount: r.artifactCount } } : null;
  }
  if (value.type !== 'upstream.event' || !visibleEvents.has(String(value.event?.type))) return null;
  const e = value.event!;
  if (e.type === 'error') return { type: 'local.error', message: '语音服务返回错误，请检查电脑端语音配置。' };
  return { type: 'upstream.event', event: { type: e.type, text: e.text, delta: e.delta, transcript: e.transcript, audio: e.audio } };
}

export function mobilePublicOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('OPENCLAWX_MOBILE_PUBLIC_ORIGIN 必须是可信 HTTPS origin，不含路径、账号或查询参数。');
  }
  return url.origin;
}

export async function registerMobileVoice(app: FastifyInstance, deps: Dependencies): Promise<void> {
  const active = new Map<string, { token: string; link: MobileVoiceLink; voice: MobileVoiceConnection; until: number; lastSeen: number; uploading?: boolean; end?: () => void }>();
  const pending = new Set<string>();
  let shuttingDown = false;
  const drop = (id: string) => {
    const row = active.get(id);
    if (!row) return;
    active.delete(id); row.end?.(); deps.release(id);
  };
  const error = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ code, message });
  const linkFor = async (request: FastifyRequest, reply: FastifyReply) => {
    const { token } = request.params as { token: string };
    const link = await deps.resolve(token);
    if (!link || link.expiresAt <= Date.now()) { error(reply, 410, 'LINK_EXPIRED', '链接已过期，请在电脑上重新扫码。'); return null; }
    if (!await deps.authorized(link)) { error(reply, 404, 'CONVERSATION_NOT_FOUND', '对话不存在或无访问权限。'); return null; }
    return link;
  };
  const rowFor = async (request: FastifyRequest, reply: FastifyReply) => {
    const { token, id } = request.params as { token: string; id: string };
    const link = await linkFor(request, reply);
    const row = active.get(id);
    if (!link) { if (row?.token === token) drop(id); return null; }
    if (!row || row.token !== token) { error(reply, 404, 'VOICE_NOT_FOUND', '语音通话已结束。'); return null; }
    if (row.until <= Date.now() || row.link.sessionId !== link.sessionId || row.link.orgId !== link.orgId || row.link.ownerUserId !== link.ownerUserId) {
      drop(id); error(reply, 404, 'VOICE_NOT_FOUND', '对话已切换，请重新发起通话。'); return null;
    }
    row.lastSeen = Date.now(); return row;
  };
  const reaper = setInterval(() => {
    void (async () => {
      for (const [id, row] of active) {
        if (row.until <= Date.now() || Date.now() - row.lastSeen > 30_000) { drop(id); continue; }
        const link = await deps.resolve(row.token);
        if (!link || link.expiresAt <= Date.now() || link.sessionId !== row.link.sessionId || link.orgId !== row.link.orgId || link.ownerUserId !== row.link.ownerUserId || !await deps.authorized(link)) drop(id);
      }
    })().catch(() => { /* A transient storage check must not terminate healthy calls. */ });
  }, 5_000);
  reaper.unref();
  app.addHook('onClose', async () => { shuttingDown = true; clearInterval(reaper); for (const id of active.keys()) drop(id); });
  app.get('/chat-mobile/:token/voice/capabilities', async (request, reply) => {
    if (!await linkFor(request, reply)) return;
    return reply.header('cache-control', 'no-store').send(MobileVoiceCapabilitiesSchema.parse(deps.capabilities()));
  });
  app.post('/chat-mobile/:token/voice/session', async (request, reply) => {
    const link = await linkFor(request, reply); if (!link) return;
    if (!MobileVoiceCreateSchema.safeParse(request.body ?? {}).success) return error(reply, 400, 'INVALID_INPUT', '手机端只能使用电脑端保存的语音配置。');
    if (!deps.capabilities().enabled) return error(reply, 503, 'VOICE_DISABLED', '请先在电脑的设置中开启并配置实时语音。');
    const { token } = request.params as { token: string };
    if (pending.has(token) || [...active.values()].some(row => row.token === token) || active.size + pending.size >= 20) return error(reply, 429, 'VOICE_BUSY', '通话正在进行，请先结束旧通话。');
    pending.add(token);
    let created: MobileVoiceConnection | undefined;
    try {
      const voice = await deps.create(link); created = voice;
      const fresh = await deps.resolve(token);
      if (shuttingDown || !fresh || fresh.sessionId !== link.sessionId || fresh.ownerUserId !== link.ownerUserId || fresh.orgId !== link.orgId || fresh.expiresAt <= Date.now() || !await deps.authorized(fresh)) {
        deps.release(voice.id); created = undefined; return error(reply, 410, 'LINK_EXPIRED', '链接已变更，请重新扫码。');
      }
      const until = Math.min(link.expiresAt, Date.now() + 30 * 60_000);
      const payload = MobileVoiceSessionSchema.parse({ session_id: voice.id, expiresAt: until });
      active.set(voice.id, { token, link, voice, until, lastSeen: Date.now() });
      created = undefined;
      return reply.header('cache-control', 'no-store').send(payload);
    } catch (cause) {
      if (created) deps.release(created.id);
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'VOICE_CAPACITY') return error(reply, 429, 'VOICE_BUSY', '实时语音会话已达到容量上限。');
      return error(reply, 503, 'VOICE_UNAVAILABLE', '无法创建通话，请检查电脑端语音配置。');
    }
    finally { pending.delete(token); }
  });
  app.post('/chat-mobile/:token/voice/:id/audio', { bodyLimit: 16_000 }, async (request, reply) => {
    const row = await rowFor(request, reply); if (!row) return;
    const parsed = MobileVoiceAudioSchema.safeParse(request.body);
    if (!parsed.success) return error(reply, 400, 'INVALID_AUDIO', '无效的音频数据。');
    const bytes = Buffer.from(parsed.data.audio, 'base64');
    if (bytes.length < 2 || bytes.length % 2 || bytes.length > 9600) return error(reply, 400, 'INVALID_AUDIO', '需要 PCM16 音频。');
    if (row.uploading) return error(reply, 429, 'AUDIO_BUSY', '请顺序上传音频。');
    row.uploading = true;
    try { await row.voice.sendAudio(parsed.data.audio); return { ok: true }; }
    catch { drop(row.voice.id); return error(reply, 503, 'VOICE_CLOSED', '语音连接已中断，请重新拨打。'); }
    finally { row.uploading = false; }
  });
  app.post('/chat-mobile/:token/voice/:id/commit', async (request, reply) => {
    const row = await rowFor(request, reply); if (!row) return;
    if (row.uploading) return error(reply, 429, 'AUDIO_BUSY', '请等待音频上传完成。');
    row.uploading = true;
    try { await row.voice.commitAudio(); return { ok: true }; }
    catch { drop(row.voice.id); return error(reply, 503, 'VOICE_CLOSED', '语音连接已中断，请重新拨打。'); }
    finally { row.uploading = false; }
  });
  app.post('/chat-mobile/:token/voice/:id/mute', async (request, reply) => {
    const row = await rowFor(request, reply); if (!row) return;
    const muted = (request.body as { muted?: unknown } | null)?.muted;
    if (typeof muted !== 'boolean') return error(reply, 400, 'INVALID_INPUT', 'muted 必须是布尔值。');
    if (row.uploading) return error(reply, 429, 'AUDIO_BUSY', '请等待音频上传完成。');
    row.uploading = true;
    try { await row.voice.setAudioMuted(muted); return { ok: true }; }
    catch { drop(row.voice.id); return error(reply, 503, 'VOICE_CLOSED', '语音连接已中断，请重新拨打。'); }
    finally { row.uploading = false; }
  });
  app.post('/chat-mobile/:token/voice/:id/close', async (request, reply) => {
    const link = await linkFor(request, reply); if (!link) return;
    const { token, id } = request.params as { token: string; id: string };
    const row = active.get(id);
    if (row && row.token !== token) return error(reply, 404, 'VOICE_NOT_FOUND', '通话不存在。');
    if (row) drop(id);
    return { ok: true };
  });
  app.get('/chat-mobile/:token/voice/:id/events', async (request, reply) => {
    const row = await rowFor(request, reply); if (!row) return;
    if (row.end) return error(reply, 409, 'VOICE_SUBSCRIBED', '通话已在另一页面打开。');
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'referrer-policy': 'no-referrer', 'x-accel-buffering': 'no', connection: 'keep-alive' });
    reply.raw.write(': connected\n\n');
    const heartbeat = setInterval(() => { row.lastSeen = Date.now(); reply.raw.write(': heartbeat\n\n'); }, 10_000);
    const unsub = row.voice.subscribe(value => {
      const safe = mobileVoiceEvent(value);
      if (safe && !reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(safe)}\n\n`);
      if (value.type === 'local.closed') queueMicrotask(() => drop(row.voice.id));
    });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsub();
      if (row.end === end) row.end = undefined;
    };
    const end = () => { cleanup(); reply.raw.end(); };
    row.end = end;
    // EventSource connections are routinely replaced by mobile browsers and
    // Wi-Fi. Keep the upstream voice session alive so the browser can reconnect.
    reply.raw.once('close', cleanup);
  });
}
