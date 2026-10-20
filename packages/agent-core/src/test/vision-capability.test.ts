import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelCapabilityRuntime } from '@openclawx/contracts';
import { saveChatImage, assertVisionSupported } from '../image-input.js';
import { createModelCapabilityToolSession } from '../model-capability-runtime.js';
import { toPiHistoryMessages } from '../pi-runtime.js';
import { effectiveVisionModelId, formatVisionDuration, formatVisionInputSize, testVisionCapabilityDataUrl } from '../vision-capability.js';

test('APPMODEL-TIME-T05 formats vision phase timing and input size for status updates', () => {
  assert.equal(formatVisionDuration(8), '8 毫秒');
  assert.equal(formatVisionDuration(1_250), '1.3 秒');
  assert.equal(formatVisionDuration(64_187), '1 分 4 秒');
  assert.equal(formatVisionInputSize(311_972), '305 KB');
});

test('VIS-M2-T5 normalizes dated Qwen vision snapshots only for MaaS deployment endpoints', () => {
  assert.equal(effectiveVisionModelId({ provider: 'qwen', baseUrl: 'https://llm-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3-vl-flash-2026-01-22' }), 'qwen3-vl-flash');
  assert.equal(effectiveVisionModelId({ provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3-vl-flash-2026-01-22' }), 'qwen3-vl-flash-2026-01-22');
  assert.equal(effectiveVisionModelId({ provider: 'glm', baseUrl: 'https://example.test/v1', modelId: 'qwen3-vl-flash-2026-01-22' }), 'qwen3-vl-flash-2026-01-22');
});

test('VIS-M2-T1 targeted vision uses trusted question, scoped images, cache and cancellation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-vision-tool-'));
  const previousDir = process.env.OPENCLAWX_DATA_DIR;
  process.env.OPENCLAWX_DATA_DIR = root;
  const payloads: Array<any> = [];
  let fail = false;
  let hold: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    payloads.push(JSON.parse(body));
    if (hold) { hold(); return; }
    if (fail) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'invalid image input' } })); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'v', object: 'chat.completion.chunk', created: 1, model: 'vision-test', choices: [{ index: 0, delta: { role: 'assistant', content: '事实：连接错误。推测：端点问题。不确定：细小文字不可辨。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const attachment = await saveChatImage('s1', { name: 'error.png', dataBase64: png });
    const config: ModelCapabilityRuntime = { id: 'vision', capability: 'vision', provider: 'openai-compatible', modelId: 'vision-test', apiKey: 'local-test', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, mode: 'auto' };
    const directTest = await testVisionCapabilityDataUrl(config, '描述图片', `data:image/png;base64,${png}`);
    assert.match(directTest.analysis, /连接错误/);
    assert.ok(JSON.stringify(payloads[0]).includes(png));
    payloads.length = 0;
    const messages = [{ role: 'assistant' as const, content: '很久以前的无关数据大屏需求' }, { role: 'user' as const, content: '这是生产连接界面', attachments: [attachment] }, { role: 'assistant' as const, content: '请告诉我关注点。' }, { role: 'user' as const, content: '为何连接失败？' }];
    const input = { configs: [config], workspaceRoot: root, visionContext: { conversationId: 's1', messages } };
    const session = createModelCapabilityToolSession(input);
    assert.equal(session.descriptors[0].capability, 'vision');
    assert.equal(createModelCapabilityToolSession({ ...input, configs: [{ ...config, mode: 'disabled' }] }).descriptors.length, 0);
    assert.equal(createModelCapabilityToolSession({ ...input, visionContext: undefined }).descriptors.length, 0);
    assert.doesNotThrow(() => assertVisionSupported(messages, false, 'pi', [config]));
    assert.throws(() => assertVisionSupported(messages, false, 'pi', [{ ...config, mode: 'disabled' }]), /UNSUPPORTED/);
    const history = await toPiHistoryMessages(messages, { provider: 'openai-compatible', chatModel: 'text', apiKey: '', supportsVision: false }, 's1');
    assert.ok(!JSON.stringify(history).includes(png));
    assert.match(JSON.stringify(history), /model_understand_images/);
    const invoke = (args: Record<string, unknown>, signal?: AbortSignal) => session.invoke({ version: 1, invocationId: 'test', runId: 'run', toolId: 'model_understand_images', input: args }, signal);
    const denied = await invoke({ imageIds: ['outside-session'] });
    assert.equal(denied.status, 'failed'); assert.equal(payloads.length, 0);
    const result = await invoke({ focus: '检查地址和状态码' });
    assert.equal(result.status, 'succeeded');
    assert.equal((result.output as any).originalQuestion, '为何连接失败？');
    assert.match(JSON.stringify(payloads[0]), /为何连接失败/);
    assert.match(JSON.stringify(payloads[0]), /生产连接界面/);
    assert.doesNotMatch(JSON.stringify(payloads[0]), /无关数据大屏需求/);
    assert.match(JSON.stringify(payloads[0]), /检查地址和状态码/);
    assert.equal(payloads[0].max_tokens ?? payloads[0].max_completion_tokens, 2048);
    assert.ok(JSON.stringify(payloads[0]).includes(png));
    assert.ok(!JSON.stringify(result).includes(png));
    assert.equal(typeof (result.output as any).timing.readDurationMs, 'number');
    assert.equal(typeof (result.output as any).timing.modelDurationMs, 'number');
    assert.equal(typeof (result.output as any).timing.totalDurationMs, 'number');
    assert.equal((await invoke({ focus: '检查地址和状态码' })).status, 'succeeded');
    assert.equal(payloads.length, 1);
    await invoke({ focus: '检查其他文字' }); assert.equal(payloads.length, 2);
    fail = true;
    const providerFailure = await invoke({ focus: 'invalid' });
    assert.equal(providerFailure.status, 'failed');
    assert.equal((providerFailure.output as any).retryable, false);
    assert.equal((providerFailure.output as any).code, 'VISION_PROVIDER_FAILED');
    assert.match(String((providerFailure.output as any).error), /model=vision-test/);
    const calls = payloads.length;
    assert.equal((await invoke({ focus: 'invalid' })).status, 'failed'); assert.equal(payloads.length, calls);
    const circuitOpen = await invoke({ focus: 'different focus must not bypass terminal failure' });
    assert.equal(circuitOpen.status, 'failed'); assert.equal(payloads.length, calls);
    assert.equal((circuitOpen.output as any).cached, true);
    const abort = new AbortController(); abort.abort();
    assert.equal((await invoke({}, abort.signal)).status, 'cancelled');
    const inFlight = new AbortController();
    const started = new Promise<void>((resolve) => { hold = resolve; });
    const pending = createModelCapabilityToolSession(input).invoke({ version: 1, invocationId: 'cancel-in-flight', runId: 'run', toolId: 'model_understand_images', input: {} }, inFlight.signal);
    await started;
    inFlight.abort();
    assert.equal((await pending).status, 'cancelled');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDir === undefined) delete process.env.OPENCLAWX_DATA_DIR; else process.env.OPENCLAWX_DATA_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  }
});
