import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { gzipSync, gunzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import type { AsrEvent } from '@openclawx/contracts';
import { decodeAsrFrame, encodeAsrFrame, VolcengineAsrStream } from '../volcengine-asr.js';

function response(data: unknown, flags = 1, sequence = 1, compressed = true, error = false) {
  const payload = compressed ? gzipSync(Buffer.from(JSON.stringify(data))) : Buffer.from(JSON.stringify(data));
  const prefix = error || (flags & 1) ? 12 : 8;
  const frame = Buffer.alloc(prefix + payload.length);
  frame[0] = 0x11; frame[1] = ((error ? 15 : 9) << 4) | flags; frame[2] = 0x10 | Number(compressed);
  if (prefix === 12) frame.writeInt32BE(sequence, 4);
  frame.writeUInt32BE(payload.length, prefix - 4); payload.copy(frame, prefix); return frame;
}

test('ASR-R2: gzip configuration/audio, negative final sequence and safe response decoding', () => {
  const frame = encodeAsrFrame(1, Buffer.from('{"test":true}'), 1);
  assert.equal(frame[1], 0x11); assert.equal(frame.readInt32BE(4), 1);
  assert.deepEqual(JSON.parse(gunzipSync(frame.subarray(12)).toString()), { test: true });
  const audio = encodeAsrFrame(2, Buffer.alloc(640), 2, true);
  assert.equal(audio[1], 0x23); assert.equal(audio.readInt32BE(4), -2);
  assert.equal(gunzipSync(audio.subarray(12)).length, 640);
  assert.equal(decodeAsrFrame(response({ result: { text: '你好' } }, 0, 0, false)).data.result !== undefined, true);
  assert.equal(decodeAsrFrame(response({ result: { text: '最终结果' } }, 3, -2)).last, true);
  assert.throws(() => decodeAsrFrame(response({ message: '未开通服务' }, 0, 45000001, false, true)), /45000001/);
  assert.throws(() => decodeAsrFrame(Buffer.from([0x11, 0x91, 0x11, 0])), /无效/);
  assert.throws(() => decodeAsrFrame(frame), /响应类型/);
});

async function waitFor(events: AsrEvent[], type: AsrEvent['type']) {
  for (let i = 0; i < 200; i++) { if (events.some((event) => event.type === type)) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error(`Missing ${type}`);
}
test('ASR-R2: mock upstream correction, finish idempotency, final result and no late upload', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const events: AsrEvent[] = []; let finals = 0; let sawConfig = false;
  server.on('connection', (socket, request) => {
    assert.equal(request.headers['x-api-key'], 'test-key'); assert.equal(request.headers['x-api-resource-id'], 'volc.seedasr.sauc.duration');
    socket.on('message', (raw) => {
      const frame = Buffer.from(raw as Buffer);
      if (frame[1] >> 4 === 1) {
        const config = JSON.parse(gunzipSync(frame.subarray(12)).toString());
        assert.equal(config.audio.rate, 16000); assert.equal(config.request.result_type, 'full'); sawConfig = true;
      } else if ((frame[1] & 15) === 3) {
        finals++; socket.send(response({ result: { text: '这是最终修订。' } }, 3, -3));
      } else socket.send(response({ result: { text: '这是中间结果' } }));
    });
  });
  const stream = new VolcengineAsrStream({ apiKey: 'test-key', resourceId: 'volc.seedasr.sauc.duration', enablePunc: true, enableItn: true, url: `ws://127.0.0.1:${address.port}` }, (event) => events.push(event));
  try {
    await waitFor(events, 'connected'); stream.audio(Buffer.alloc(9600)); await waitFor(events, 'transcript');
    stream.finish(); stream.finish(); assert.throws(() => stream.audio(Buffer.alloc(640)), /已结束/);
    await waitFor(events, 'completed'); assert.equal(finals, 1); assert.equal(sawConfig, true);
    assert.deepEqual(events.find((event) => event.type === 'completed'), { type: 'completed', text: '这是最终修订。' });
  } finally { stream.close(); for (const client of server.clients) client.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('ASR-R2: finish deadline reports error instead of pretending partial text is final', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const events: AsrEvent[] = [];
  const stream = new VolcengineAsrStream({ apiKey: 'test', resourceId: 'test', enablePunc: true, enableItn: true, finishMs: 20, url: `ws://127.0.0.1:${address.port}` }, (event) => events.push(event));
  try { await waitFor(events, 'connected'); stream.finish(); await waitFor(events, 'error'); assert.equal(events.some((event) => event.type === 'completed'), false); }
  finally { stream.close(); for (const client of server.clients) client.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
