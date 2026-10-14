import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractContextAnchors,
  formatAnchorsBlock,
  formatCommandResultEnvelope,
  sanitizeToolPayloadsInMessages,
  stubWriteArgs,
} from '../context-sanitize.js';

test('MDA-R7: paged data metadata retains valid JSON beyond generic 2500-character tool limit', () => {
  const payload = JSON.stringify({ ok: true, data: { columns: Array.from({ length: 30 }, (_, id) => ({ id, description: 'schema field'.repeat(20) })), pagination: { nextOffset: 30 } } });
  assert.ok(payload.length > 2500 && payload.length < 16000);
  const clean = sanitizeToolPayloadsInMessages([result('schema', 'data_get_schema', JSON.parse(payload))]) as any[];
  assert.deepEqual(JSON.parse(clean[0].content[0].text), JSON.parse(payload));
});

function assistantWith(content: unknown[]) {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'openai',
    model: 'x',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  } as any;
}

test('WR-T4: work result IDs and bounded text remain valid JSON through context hygiene',()=>{
  const data={ok:true,items:[{id:crypto.randomUUID()}],text:'三亚行程'.repeat(2000)};
  const clean=sanitizeToolPayloadsInMessages([result('work','read_work_result',data)]) as any[];
  assert.deepEqual(JSON.parse(clean[0].content[0].text),data);
  const huge={...data,text:'\u0001'.repeat(16000)};
  const clipped=sanitizeToolPayloadsInMessages([result('large','read_work_result',huge)]) as any[];
  const value=JSON.parse(clipped[0].content[0].text);assert.equal(value.truncated,true);assert.equal(value.items[0].id,data.items[0].id);assert.ok(clipped[0].content[0].text.length<=32000);
});

function result(id: string, toolName: string, value: unknown, isError = false) {
  return { role: 'toolResult', toolCallId: id, toolName,
    content: [{ type: 'text', text: JSON.stringify(value) }], isError, timestamp: Date.now() } as any;
}

test('sanitize strips thinking blocks from assistant messages', () => {
  const messages = [assistantWith([
    { type: 'thinking', thinking: 'long private chain of thought…' },
    { type: 'text', text: 'visible' },
    {
      type: 'toolCall',
      id: '1',
      name: 'write_workspace_file',
      arguments: { path: 'output/a.html', content: 'x'.repeat(500) },
    },
  ])];

  const out = sanitizeToolPayloadsInMessages(messages);
  const content = (out[0] as any).content as Array<{ type: string }>;
  assert.equal(content.some((b) => b.type === 'thinking'), false);
  assert.equal(content.some((b) => b.type === 'text'), true);
});

test('sanitize stubs write bodies to path-only without _omittedBody', () => {
  const big = 'a'.repeat(2_000);
  const messages = [assistantWith([{
    type: 'toolCall',
    id: '1',
    name: 'write_workspace_file',
    arguments: { path: 'output/assets/css/style.css', content: big, mode: 'append' },
  }]), result('1', 'write_workspace_file', { ok: true, path: 'output/assets/css/style.css' })];

  const out = sanitizeToolPayloadsInMessages(messages);
  const args = (out[0] as any).content[0].arguments;
  assert.equal(args.path, 'output/assets/css/style.css');
  assert.equal(args.status, 'written');
  assert.equal(args.contextPolicy, 'path-only');
  assert.equal(args.content, undefined);
  assert.equal(args._omittedBody, undefined);
  assert.match(String(args.hint), /do NOT treat as a failed write/i);
  assert.ok(Number(args.bytes) >= 2_000);
});

test('stubWriteArgs always path-only', () => {
  const stub = stubWriteArgs({ path: 'output/x.md', content: 'hi', mode: 'replace', deliverable: true });
  assert.equal(stub.path, 'output/x.md');
  assert.equal(stub.content, undefined);
  assert.equal(stub.chunks, undefined);
});

test('TP-T5: failed, pending and mismatched writes never claim written; source history remains immutable', () => {
  for (const outcome of ['pending', 'failed', 'error', 'unrelated', 'other-tool'] as const) {
    const call = assistantWith([{ type: 'toolCall', id: 'write', name: 'write_workspace_file',
      arguments: { path: 'output/styles.css', content: 'x'.repeat(12_001) } }]);
    const messages = [call, ...(outcome === 'pending' ? [] : [result(outcome === 'unrelated' ? 'other' : 'write',
      outcome === 'other-tool' ? 'read_workspace_file' : 'write_workspace_file', { ok: outcome !== 'failed', path: 'output/styles.css' }, outcome === 'error')])];
    const before = JSON.stringify(messages);
    const clean = sanitizeToolPayloadsInMessages(messages);
    assert.equal((clean[0] as any).content[0].arguments.content.length, 12_001);
    assert.equal((clean[0] as any).content[0].arguments.status, undefined);
    assert.equal(JSON.stringify(messages), before);
  }
});

for (const [name, field] of [['append_workspace_write', 'text'], ['append_artifact_source_write', 'content']]) {
  test(`TP-T5: ${name} retains callable sequence arguments, even after success`, () => {
    for (const ok of [true, false]) {
      const args = { writeId: 'fixture-write-id', seq: 2, [field]: 'body'.repeat(500) };
      const messages = [assistantWith([{ type: 'toolCall', id: 'piece', name, arguments: args }]),
        result('piece', name, { ok, nextSeq: ok ? 3 : 2 }, !ok)];
      const before = JSON.stringify(messages);
      const once = sanitizeToolPayloadsInMessages(messages);
      const twice = sanitizeToolPayloadsInMessages(once);
      assert.deepEqual((twice[0] as any).content[0].arguments, args);
      assert.equal((twice[0] as any).content[0].arguments.contextPolicy, undefined);
      assert.equal(JSON.stringify(messages), before);
    }
  });
}

test('TP-T5: written anchors require successful persistence, not merely proposed or rejected writes', () => {
  const messages = [assistantWith([{ type: 'toolCall', id: 'bad', name: 'write_workspace_file',
    arguments: { path: 'output/failed.css', content: 'oversized' } }]),
    result('bad', 'write_workspace_file', { ok: false, path: 'output/failed.css' }),
    result('good', 'finish_workspace_write', { ok: true, path: 'output/done.css' }),
    result('artifact', 'run_workspace_script', { ok: false, artifacts: ['output/not-created.pdf'] }),
  ];
  assert.deepEqual(extractContextAnchors(messages).writtenPaths, ['output/done.css']);
});

test('sanitize wraps script tool results as command-result envelopes', () => {
  const payload = JSON.stringify({
    ok: true,
    exitCode: 0,
    stdout: 'hello\n'.repeat(400),
    stderr: 'warn\n'.repeat(50),
    artifacts: ['output/report.pdf'],
  });
  const messages = [{
    role: 'toolResult',
    toolCallId: '1',
    toolName: 'run_workspace_script',
    content: [{ type: 'text', text: payload }],
    isError: false,
    timestamp: Date.now(),
  }] as any;

  const out = sanitizeToolPayloadsInMessages(messages);
  const text = (out[0] as any).content[0].text as string;
  assert.match(text, /\[command-result\]/);
  assert.match(text, /tool: run_workspace_script/);
  assert.match(text, /artifacts: output\/report\.pdf/);
  assert.match(text, /\[\/command-result\]/);
  assert.ok(text.length < payload.length);
});

test('sanitize truncates large read_workspace_file results', () => {
  const messages = [{
    role: 'toolResult',
    toolCallId: '1',
    toolName: 'read_workspace_file',
    content: [{ type: 'text', text: 'x'.repeat(8_000) }],
    isError: false,
    timestamp: Date.now(),
  }] as any;

  const out = sanitizeToolPayloadsInMessages(messages);
  const text = (out[0] as any).content[0].text as string;
  assert.ok(text.length < 8_000);
  assert.match(text, /truncated/);
});

test('extractContextAnchors captures goal paths and errors', () => {
  const messages = [
    { role: 'user', content: '做一个小野鸭射击游戏，交付 index.html', timestamp: Date.now() },
    assistantWith([{
      type: 'toolCall',
      id: '1',
      name: 'write_workspace_file',
      arguments: { path: 'output/index.html', status: 'written', contextPolicy: 'path-only', bytes: 100 },
    }]),
    result('1', 'write_workspace_file', { ok: true, path: 'output/index.html' }),
    {
      role: 'toolResult',
      toolCallId: '1',
      toolName: 'run_workspace_script',
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'ModuleNotFoundError: foo' }) }],
      isError: false,
      timestamp: Date.now(),
    },
  ] as any;

  const anchors = extractContextAnchors(messages);
  assert.match(anchors.goal, /小野鸭/);
  assert.ok(anchors.writtenPaths.includes('output/index.html'));
  assert.ok(anchors.errors.some((e) => /ModuleNotFoundError/.test(e)));
  assert.match(formatAnchorsBlock(anchors), /\[context-anchors\]/);
});

test('formatCommandResultEnvelope labels truncated stdout', () => {
  const text = formatCommandResultEnvelope('run_skill_script', JSON.stringify({
    ok: true,
    exitCode: 0,
    stdout: 'A'.repeat(5_000),
    stderr: '',
  }));
  assert.match(text, /\[command-result\]/);
  assert.match(text, /chars omitted/);
  assert.ok(text.length < 5_000);
});
