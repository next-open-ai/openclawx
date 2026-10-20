import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AsrAudioSchema, AsrSessionSchema, type AsrEvent } from '@openclawx/contracts';
import { VolcengineAsrStream } from '@openclawx/agent-core';
import { readVoiceInputSettings, resolveAsrKey } from './asr-settings.js';

type Owner = { userId: string; orgId: string };
type Stream = Pick<VolcengineAsrStream, 'audio' | 'finish' | 'close'>;
type Factory = (input: ConstructorParameters<typeof VolcengineAsrStream>[0], emit: (event: AsrEvent) => void) => Stream;
type Session = { owner: Owner; createdAt: number; stream: Stream; events: AsrEvent[]; listeners: Set<(event: AsrEvent) => void> };

export async function registerAsrRoutes(app: FastifyInstance, factory: Factory = (input, emit) => new VolcengineAsrStream(input, emit)) {
  const sessions = new Map<string, Session>();
  function owned(request: FastifyRequest, id: string) {
    const row = sessions.get(id); const auth = request.auth;
    return row && auth && row.owner.userId === auth.userId && row.owner.orgId === auth.orgId ? row : null;
  }
  const reaper = setInterval(() => {
    for (const [id, row] of sessions) if (Date.now() - row.createdAt > 180_000) { row.stream.close(); sessions.delete(id); }
  }, 15_000);
  reaper.unref();
  app.addHook('onClose', async () => { clearInterval(reaper); for (const row of sessions.values()) row.stream.close(); sessions.clear(); });

  app.post('/voice/asr/session', async (request, reply) => {
    if (!request.auth) return reply.code(401).send({ ok: false, message: '请先登录。' });
    const config = readVoiceInputSettings(); const key = resolveAsrKey(config);
    if (!config.enabled || !key) return reply.code(400).send({ ok: false, message: !config.enabled ? '语音输入已关闭。' : '尚未配置 ASR 密钥，请在设置 > 语音中配置。' });
    if (sessions.size >= 20 || [...sessions.values()].filter((row) => row.owner.userId === request.auth!.userId && row.owner.orgId === request.auth!.orgId).length >= 2) return reply.code(429).send({ ok: false, message: '语音输入会话达到上限，请先关闭已有录音。' });
    const id = randomUUID();
    const row: Session = { owner: { userId: request.auth.userId, orgId: request.auth.orgId }, createdAt: Date.now(), stream: null as unknown as Stream, events: [], listeners: new Set() };
    try {
      row.stream = factory({ apiKey: key, resourceId: config.resourceId, enablePunc: config.enablePunc, enableItn: config.enableItn, url: process.env.OPENCLAWX_VOLCENGINE_ASR_URL?.trim() || undefined }, (event) => {
        // Replay lifecycle + latest full transcript only. Do not retain audio.
        if (event.type === 'transcript') row.events = row.events.filter((item) => item.type !== 'transcript');
        row.events.push(event); if (row.events.length > 16) row.events.shift();
        for (const listener of row.listeners) listener(event);
      });
      sessions.set(id, row); return { ok: true, session_id: id };
    } catch { return reply.code(502).send({ ok: false, message: 'ASR 连接创建失败，请检查服务配置。' }); }
  });

  for (const operation of ['audio', 'finish', 'close'] as const) {
    app.post(`/voice/asr/${operation}`, async (request, reply) => {
      const parsed = (operation === 'audio' ? AsrAudioSchema : AsrSessionSchema).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ ok: false, message: '无效的语音输入请求。' });
      const row = owned(request, parsed.data.session_id);
      if (!row) return reply.code(404).send({ ok: false, message: '语音输入会话不存在。' });
      try {
        if (operation === 'audio') {
          const audio = Buffer.from(AsrAudioSchema.parse(request.body).audio, 'base64');
          if (!audio.length || audio.length > 32_000 || audio.length % 2) throw new Error('ASR 音频格式错误。');
          row.stream.audio(audio);
        }
        else if (operation === 'finish') row.stream.finish();
        else { row.stream.close(); sessions.delete(parsed.data.session_id); }
        return { ok: true };
      } catch (cause) { return reply.code(400).send({ ok: false, message: cause instanceof Error ? cause.message : 'ASR 操作失败。' }); }
    });
  }

  app.get('/voice/asr/events', async (request, reply) => {
    const input = AsrSessionSchema.safeParse(request.query);
    if (!input.success) return reply.code(400).send({ ok: false, message: '无效的会话 ID。' });
    const row = owned(request, input.data.session_id);
    if (!row) return reply.code(404).send({ ok: false, message: '语音输入会话不存在。' });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const write = (event: AsrEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    row.listeners.add(write); for (const event of row.events) write(event);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    reply.raw.once('close', () => { clearInterval(heartbeat); row.listeners.delete(write); });
  });
}
