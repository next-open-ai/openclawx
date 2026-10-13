import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { ExecutionBackendStreamInput } from '../execution-backend.js';
import { streamTextOnlyReply } from '../text-only-reply.js';
import { streamAgentReply } from '../stream-reply.js';

const input: ExecutionBackendStreamInput = { runId: 'text-only-test', responseMode: 'text-only', engine: 'dsh',
  profile: { id: 'general', name: '通用助理', instructions: 'run shell', toolIds: ['danger'] },
  model: { provider: 'openai-compatible', chatModel: 'synthetic', apiKey: 'synthetic', enableSearch: true },
  messages: [{ role: 'assistant', content: 'old untrusted answer' }, { role: 'user', content: '根据成果解释利润，不重跑' }],
  skills: [], searchProviders: [], mcpConnections: [], knowledgeBases: [] };
const message = { role: 'assistant', content: [], api: 'openai-completions', provider: 'openai-compatible', model: 'synthetic',
  usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } satisfies AssistantMessage;

test('WQ-T3: pure text inference exposes no tools/history and retains usage and failure truth', async () => {
  const events = [];
  for await (const event of streamTextOnlyReply(input, async function* (_model, context, options) {
    assert.deepEqual(context.tools, []); assert.equal(context.messages.length, 1);
    assert.match(String(context.messages[0].content), /根据成果/); assert.ok(!JSON.stringify(context).includes('old untrusted answer'));
    assert.ok(options?.signal);
    // The adapter must never add model-native search for this turn.
    const payload = { messages: [] }; options?.onPayload?.(payload); assert.ok(!JSON.stringify(payload).includes('enable_search'));
    yield { type: 'text_delta', delta: '利润为五万元。', contentIndex: 0, partial: message };
    yield { type: 'done', reason: 'stop', message };
  })) events.push(event);
  assert.deepEqual(events.map(event => event.type), ['run.started', 'message.delta', 'run.usage', 'run.completed']);
  const usage = events.find(event => event.type === 'run.usage'); assert.equal(usage?.usage.totalTokens, 15);
  const failed = [];
  for await (const event of streamTextOnlyReply(input, async function* () { yield { type: 'text_delta', delta: '部分回答', contentIndex: 0, partial: message }; throw new Error('HTTP 429'); })) failed.push(event);
  assert.equal(failed.at(-1)?.type, 'run.failed'); assert.ok(!failed.some(event => event.type === 'run.completed'));
  const controller = new AbortController(); controller.abort(new Error('Operation aborted'));
  const cancelled = [];
  for await (const event of streamTextOnlyReply({ ...input, abortSignal: controller.signal }, async function* (_m, _c, options) {
    assert.fail('pre-aborted inference must not start');
  })) cancelled.push(event);
  assert.equal(cancelled.at(-1)?.type, 'run.failed');
});

test('WQ-T3: public stream entry bypasses DSH/backend tools and calls only local synthetic text provider', async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, reply) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw)); reply.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.write('data: ' + JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '利润为五万元。' }, finish_reason: null }] }) + '\n\n');
    reply.write('data: ' + JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) + '\n\n');
    reply.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const events = [];
    for await (const event of streamAgentReply({ ...input, model: { ...input.model, baseUrl: `http://127.0.0.1:${address.port}/v1` } }, { override: 'dsh' })) events.push(event);
    assert.equal(requests.length, 1); assert.ok(!requests[0].tools || (requests[0].tools as unknown[]).length === 0);
    assert.ok(!requests[0].enable_search); assert.equal(events.at(-1)?.type, 'run.completed');
    assert.ok(events.some(event => event.type === 'run.usage')); assert.ok(!events.some(event => event.type.startsWith('tool.') || event.type === 'artifact.created'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
