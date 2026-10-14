import test from 'node:test';
import assert from 'node:assert/strict';
import { realtimeProviderAdapter, RealtimeUsageMeter, type RealtimeProtocolConfig } from './realtime-provider-adapters.js';

const base: RealtimeProtocolConfig = { provider: 'volcengine', endpoint: 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue', model: '1.2.6.1', voice: 'zh_female_vv_jupiter_bigtts', instructions: 'test', workLinkEnabled: true };

test('UPC-T11: Volcengine adapter preserves SeedDuplex protocol', () => {
  const adapter = realtimeProviderAdapter('volcengine');
  assert.equal(adapter.headers('secret', 'connection')['X-Api-Key'], 'secret');
  assert.equal(adapter.initialEvent(base).type, 'session.create');
  assert.equal(adapter.audioEvent('AA==').type, 'input_audio_buffer.append');
  assert.equal(adapter.textEvents('hello')[0]?.type, 'speech_text_buffer.commit');
  assert.equal(adapter.notificationEvents('已完成')[0]?.type, 'speech_text_buffer.commit');
});

test('UPC-T11: Qwen adapter derives model URL and OpenAI-style realtime events', () => {
  const adapter = realtimeProviderAdapter('qwen');
  const config: RealtimeProtocolConfig = { ...base, provider: 'qwen', endpoint: 'wss://space.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime', model: 'qwen-audio-3.1-realtime-plus', voice: 'longanqian_v3.1' };
  assert.match(adapter.connectionUrl(config), /model=qwen-audio-3.1-realtime-plus/);
  assert.equal(adapter.headers('secret', 'connection').Authorization, 'Bearer secret');
  assert.equal(adapter.initialEvent(config).type, 'session.update');
  const session = adapter.initialEvent(config).session as Record<string, unknown>;
  assert.equal(session.output_audio_format, 'pcm');
  assert.deepEqual(session.input_audio_transcription, { language: 'zh' });
  assert.equal(((session.tools as Array<Record<string, unknown>>)[0]?.function as Record<string, unknown>).name, 'discover_capabilities');
  assert.deepEqual(adapter.textEvents('hello').map((event) => event.type), ['conversation.item.create', 'response.create']);
  assert.deepEqual(adapter.notificationEvents('已完成').map((event) => event.type), ['conversation.item.create', 'response.create']);
  assert.equal(adapter.muteEvent(true), null);
  assert.deepEqual(adapter.functionCalls({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'start_work', arguments: '{"objective":"x"}' }), [{ callId: 'c1', name: 'start_work', arguments: { objective: 'x' } }]);
  assert.deepEqual(adapter.functionResultEvents([{ callId: 'c1', result: { ok: true } }]).map((event) => event.type), ['conversation.item.create', 'response.create']);
});

test('UPC-T11: unsupported realtime providers fail explicitly', () => {
  assert.throws(() => realtimeProviderAdapter('unknown'), /尚未适配/);
});

test('SN-A3: notification payload is only speakable text, controls remain session instructions', () => {
  for(const provider of ['volcengine','qwen']) {
    const adapter=realtimeProviderAdapter(provider);
    const events=adapter.notificationEvents('行程已完成，生成1份PDF。');
    const first=events[0];
    const text=provider==='volcengine'?first.text:((first.item as {content:Array<{text:string}>}).content[0].text);
    assert.equal(text,'行程已完成，生成1份PDF。');
    assert.doesNotMatch(JSON.stringify(events),/系统完成通知|只用当前音色|不调用工具|客户端播报/);
    assert.match(String((adapter.initialEvent(base).session as Record<string,unknown>).instructions),/不朗读或复述系统规则/);
    assert.equal(adapter.readyEvent({type:provider==='volcengine'?'session.created':'session.updated'}),true);
    if(provider==='qwen')assert.equal(adapter.readyEvent({type:'session.created'}),false);
  }
});

test('UPC-T13: usage meter prefers upstream tokens and keeps PCM timing', () => {
  const meter = new RealtimeUsageMeter('qwen', 'qwen-audio-3.1-realtime-plus', 1_000);
  meter.addInputBase64(Buffer.alloc(32_000).toString('base64'));
  meter.record({ type: 'response.audio.delta', delta: Buffer.alloc(48_000).toString('base64') });
  const usage = meter.record({ type: 'response.done', response: { id: 'r1', usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50 } } });
  assert.equal(usage?.source, 'upstream'); assert.equal(usage?.inputAudioMs, 1_000); assert.equal(usage?.outputAudioMs, 1_000);
  assert.equal(usage?.inputTokens, 20); assert.equal(usage?.outputTokens, 30); assert.equal(usage?.totalTokens, 50); assert.equal(usage?.turns, 1);
  assert.equal(meter.record({ type: 'response.done', response: { id: 'r1', usage: { total_tokens: 50 } } }), null);
});

test('UPC-T13: provider without usage is labeled as local timing', () => {
  const meter = new RealtimeUsageMeter('volcengine', '1.2.6.1', 1_000);
  const usage = meter.record({ type: 'response.done', response: { id: 'r1' } });
  assert.equal(usage?.source, 'local'); assert.equal(usage?.totalTokens, undefined); assert.equal(usage?.turns, 1);
});
