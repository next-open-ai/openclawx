import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentEventSchema } from '@workmate/contracts';
import { diagnoseModelFailure } from '../model-failure.js';
import { streamAgentReply } from '../pi-runtime.js';

test('RD-R1: model failures are classified without retaining private response bodies', () => {
  for (const [raw, code] of [
    ['Model stream idle after 180s', 'MODEL_IDLE_TIMEOUT'],
    ['HTTP 429', 'UPSTREAM_RATE_LIMIT'], ['status: 401', 'UPSTREAM_AUTH'],
    ['HTTP 503', 'UPSTREAM_SERVICE'], ['fetch failed ECONNRESET', 'CONNECTION_INTERRUPTED'],
    ['Unexpected token in JSON', 'TOOL_ARGUMENTS'], ['AbortError', 'MODEL_ABORTED'],
    ['unknown private response', 'MODEL_ERROR'],
  ]) {
    const result = diagnoseModelFailure(new Error(`${raw} secret=sk-FAKE https://private/?token=FAKE prompt=PRIVATE`), { phase: 'after-tool', elapsedMs: 140000 });
    assert.equal(result.failure.code, code);
    assert.equal(result.failure.phase, 'after-tool'); assert.equal(result.failure.elapsedMs, 140000);
    assert.doesNotMatch(JSON.stringify(result), /sk-FAKE|https:|token=|PRIVATE/);
    assert.ok(AgentEventSchema.safeParse({ type: 'run.failed', runId: 'r', ...result }).success);
  }
  assert.ok(AgentEventSchema.safeParse({ type: 'run.failed', runId: 'r', message: 'legacy' }).success);
  const structured = diagnoseModelFailure(Object.assign(new Error('private'), { status: 429, cause: { code: 'ECONNRESET' } }), { phase: 'first-response', elapsedMs: 5 });
  assert.equal(structured.failure.status, 429); assert.equal(structured.failure.transportCode, 'ECONNRESET');
});

test('RD-T5: balance errors survive SDK serialization, without exposing upstream bodies', () => {
  const privateData = ' secret=sk-FAKE https://private/?token=FAKE prompt=PRIVATE';
  for (const raw of [
    '402 Insufficient Balance', 'HTTP 402 Payment Required', 'status: 402',
    '402 {"error":{"message":"Insufficient Balance","code":"invalid_request_error"}}',
    'InsufficientBalance', 'Insufficient Balance', 'Insufficient funds', 'Insufficient credits',
    'Your credit balance is too low', 'Arrearage', '账户余额不足', '账号欠费', '账户已处于欠费状态',
  ]) {
    const result = diagnoseModelFailure(raw + privateData, { phase: 'first-response', elapsedMs: 12 });
    assert.equal(result.failure.code, 'UPSTREAM_BALANCE', raw);
    assert.match(result.message, /余额不足或已欠费/);
    assert.match(result.message, /充值.*切换其他供应商/);
    assert.doesNotMatch(result.message, /稍后重试|网络/);
    assert.doesNotMatch(JSON.stringify(result), /sk-FAKE|https:|token=|PRIVATE/);
    assert.equal(result.failure.status, /402/.test(raw) ? 402 : undefined);
    assert.ok(AgentEventSchema.safeParse({ type: 'run.failed', runId: 'balance', ...result }).success);
  }
  for (const error of [Object.assign(new Error('private'), { status: 402 }), { code: 'InsufficientBalance', message: 'private' }]) {
    assert.equal(diagnoseModelFailure(error, { phase: 'first-response', elapsedMs: 1 }).failure.code, 'UPSTREAM_BALANCE');
  }
  for (const [raw, expected] of [
    ['401 Incorrect API key', 'UPSTREAM_AUTH'], ['403 Access denied', 'UPSTREAM_AUTH'],
    ['429 Rate limit reached', 'UPSTREAM_RATE_LIMIT'], ['503 Unavailable', 'UPSTREAM_SERVICE'],
    ['400 Invalid request', 'MODEL_ERROR'], ['insufficient_quota', 'MODEL_ERROR'],
    ['unknown at https://private/402 tokens=402', 'MODEL_ERROR'],
  ]) {
    assert.equal(diagnoseModelFailure(raw, { phase: 'execution', elapsedMs: 1 }).failure.code, expected, raw);
  }
});

test('RD-T5: actual Pi SDK HTTP 402 becomes one visible balance failure before any tool runs', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workmate-balance-'));
  let requests = 0;
  const server = createServer((request, response) => {
    requests++; request.resume();
    response.writeHead(402, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Insufficient Balance secret=sk-FAKE prompt=PRIVATE', type: 'unknown_error', code: 'invalid_request_error' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const events = [];
    for await (const event of streamAgentReply({
      runId: 'balance-test', projectWorkspacePath: root,
      profile: { id: 'general', name: 'Test', instructions: 'Create a website.', toolIds: [] },
      messages: [{ role: 'user', content: '创建一个卖花网站' }],
      model: { provider: 'deepseek', chatModel: 'deepseek-chat', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'mock-key' },
    })) events.push(event);
    assert.equal(requests, 1, 'billing failure must not trigger automatic model retries');
    const failures = events.filter(event => event.type === 'run.failed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].failure?.code, 'UPSTREAM_BALANCE');
    assert.equal(failures[0].failure?.status, 402);
    assert.match(failures[0].message, /余额不足/);
    assert.ok(!events.some(event => event.type === 'tool.started' || event.type === 'run.completed'));
    assert.doesNotMatch(JSON.stringify(events), /sk-FAKE|PRIVATE/);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
