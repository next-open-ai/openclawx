import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import type { AsrEvent } from '@openclawx/contracts';

// SAUC uses binary v1 frames, not the Seeduplex JSON wire protocol.
export function encodeAsrFrame(type: number, payload: Buffer, sequence: number, last = false) {
  const compressed = gzipSync(payload);
  const frame = Buffer.alloc(12 + compressed.length);
  frame[0] = 0x11; frame[1] = (type << 4) | (last ? 3 : 1);
  frame[2] = (type === 1 ? 0x10 : 0) | 1;
  frame.writeInt32BE(last ? -sequence : sequence, 4);
  frame.writeUInt32BE(compressed.length, 8); compressed.copy(frame, 12);
  return frame;
}

export function decodeAsrFrame(frame: Buffer): { data: Record<string, unknown>; last: boolean } {
  if (frame.length < 8 || frame[0] >> 4 !== 1) throw new Error('无效的 ASR 协议帧。');
  const headerBytes = (frame[0] & 15) * 4;
  if (headerBytes < 4 || headerBytes > frame.length - 4) throw new Error('无效的 ASR 协议头。');
  const type = frame[1] >> 4; const flags = frame[1] & 15;
  let offset = headerBytes; let sequence = 0; let code = 0;
  if (type === 15) { code = frame.readUInt32BE(offset); offset += 4; }
  else if (type === 9 && (flags & 1)) { sequence = frame.readInt32BE(offset); offset += 4; }
  else if (type !== 9) throw new Error('不支持的 ASR 响应类型。');
  if (offset + 4 > frame.length) throw new Error('ASR 响应不完整。');
  const length = frame.readUInt32BE(offset); offset += 4;
  if (length > 1_000_000 || offset + length !== frame.length) throw new Error('ASR 响应长度错误。');
  let payload = frame.subarray(offset);
  const compression = frame[2] & 15;
  if (compression === 1) payload = gunzipSync(payload, { maxOutputLength: 1_000_000 });
  else if (compression !== 0) throw new Error('不支持的 ASR 压缩格式。');
  if (frame[2] >> 4 !== 1) throw new Error('不支持的 ASR 序列化格式。');
  const data = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('ASR 响应格式错误。');
  if (type === 15 || (data.code !== undefined && data.code !== 0 && data.code !== 1000 && data.code !== 20000000)) {
    throw new Error(`ASR 服务错误 ${code || data.code}：${String(data.message || data.error || '请检查服务开通与额度').slice(0, 200)}`);
  }
  return { data, last: Boolean(flags & 2) || sequence < 0 || data.is_last_package === true };
}

export class VolcengineAsrStream {
  private socket: WebSocket;
  private sequence = 1;
  private ready = false;
  private finishing = false;
  private closed = false;
  private completed = false;
  private text = '';
  private finishTimer?: ReturnType<typeof setTimeout>;
  private lifetime: ReturnType<typeof setTimeout>;

  constructor(input: { apiKey: string; resourceId: string; enablePunc: boolean; enableItn: boolean; url?: string; maxMs?: number; finishMs?: number }, private emit: (event: AsrEvent) => void) {
    this.socket = new WebSocket(input.url || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async', {
      headers: { 'X-Api-Key': input.apiKey, 'X-Api-Resource-Id': input.resourceId, 'X-Api-Request-Id': randomUUID(), 'X-Api-Sequence': '-1' },
      handshakeTimeout: 15_000, maxPayload: 1_000_000,
    });
    this.lifetime = setTimeout(() => this.fail('录音已超过两分钟限制，请结束并确认已识别文字。'), input.maxMs ?? 120_000);
    this.lifetime.unref();
    this.socket.once('open', () => {
      const config = { user: { uid: 'openclawx' }, audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 }, request: { model_name: 'bigmodel', result_type: 'full', show_utterances: true, enable_nonstream: true, enable_punc: input.enablePunc, enable_itn: input.enableItn } };
      this.socket.send(encodeAsrFrame(1, Buffer.from(JSON.stringify(config)), this.sequence++));
      this.ready = true; this.emit({ type: 'connected' });
    });
    this.socket.on('message', (raw) => {
      if (this.closed || this.completed) return;
      try {
        const frame = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        const { data, last } = decodeAsrFrame(frame);
        const result = Array.isArray(data.result) ? data.result[0] : data.result;
        if (result && typeof result === 'object' && typeof result.text === 'string') {
          if (result.text.length > 32_000) throw new Error('ASR 识别文字超过长度限制。');
          this.text = result.text; this.emit({ type: 'transcript', text: this.text, isFinal: last });
        }
        if (last) {
          this.completed = true; this.emit({ type: 'completed', text: this.text }); this.close();
        }
      } catch (cause) { this.fail(cause instanceof Error ? cause.message : 'ASR 响应解析失败。'); }
    });
    this.socket.once('unexpected-response', (_request, response) => {
      response.resume(); this.fail(`ASR 握手失败（HTTP ${response.statusCode}）。请检查密钥、ASR 开通和资源额度。`);
    });
    this.socket.on('error', () => this.fail('ASR 网络连接失败，请检查网络及服务配置。'));
    this.socket.once('close', () => {
      if (!this.closed && !this.completed) this.fail('ASR 连接提前断开，已识别文字仍可使用。');
    });
    this.finishMs = input.finishMs ?? 10_000;
  }

  private finishMs: number;
  audio(bytes: Buffer) {
    if (!this.ready || this.closed || this.finishing || this.socket.readyState !== WebSocket.OPEN) throw new Error('ASR 尚未就绪或已结束。');
    if (!bytes.length || bytes.length > 32_000 || bytes.length % 2) throw new Error('ASR 音频格式错误。');
    if (this.socket.bufferedAmount > 128_000) throw new Error('ASR 音频上传过慢，请重新录音。');
    this.socket.send(encodeAsrFrame(2, bytes, this.sequence++));
  }

  finish() {
    if (this.finishing || this.completed) return;
    if (!this.ready || this.closed) throw new Error('ASR 尚未就绪或已关闭。');
    this.finishing = true;
    this.socket.send(encodeAsrFrame(2, Buffer.alloc(0), this.sequence++, true));
    this.finishTimer = setTimeout(() => this.fail('等待 ASR 最终结果超时，当前文字可手动确认。'), this.finishMs);
    this.finishTimer.unref();
  }

  private fail(message: string) {
    if (this.closed) return;
    this.emit({ type: 'error', message: message.slice(0, 500) }); this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.lifetime); clearTimeout(this.finishTimer);
    this.socket.terminate(); this.emit({ type: 'closed' });
  }
}
