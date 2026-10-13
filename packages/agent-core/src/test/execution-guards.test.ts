import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Type, defineAgentTool } from '../pi-tools.js';
import { combinedExecutionSignal, guardToolBudget, MATERIAL_TASK_CONTRACT, toolFailureText } from '../execution-guards.js';
import { ResourceAccessPolicy } from '../resource-access.js';
import { streamAgentReply } from '../pi-runtime.js';

test('WA-R18: external and internal cancellation both reach the provider signal', () => {
  for (const internalAbort of [true, false]) {
    const external = new AbortController(); const internal = new AbortController();
    const signal = combinedExecutionSignal(external.signal, internal.signal);
    (internalAbort ? internal : external).abort(new Error('stop'));
    assert.equal(signal.aborted, true);
    assert.throws(() => signal.throwIfAborted(), /stop/);
  }
});

test('WA-R18: budget is shared across tools and checked before side effects', async () => {
  let calls = 0; let stopped = 0;
  const tools = guardToolBudget(['a', 'b'].map((name) => defineAgentTool({
    name, description: name, parameters: Type.Object({}), execute: () => { calls++; return 'ok'; },
  })), 2, () => { stopped++; });
  await tools[0].execute('1', {}); await tools[1].execute('2', {});
  await assert.rejects(tools[0].execute('3', {}), /budget exceeded/);
  await assert.rejects(tools[1].execute('4', {}), /budget exceeded/);
  assert.equal(calls, 2); assert.equal(stopped, 1);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(tools[0].execute('5', {}, aborted.signal));
  assert.equal(calls, 2);
});

test('WA-R19: material tools reject outside paths, symlinks and shell exploration but permit project files', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'workmate-material-'));
  const root = path.join(parent, 'project'); await mkdir(root);
  await mkdir(path.join(root, 'inputs')); await writeFile(path.join(parent, 'private.txt'), 'not a source');
  await writeFile(path.join(root, 'inputs/source.txt'), 'source');
  await symlink(parent, path.join(root, 'escape'));
  let reads = 0;
  const policy = new ResourceAccessPolicy(root);
  const read = async (file: string) => { await policy.authorizeFile(file, 'read'); reads++; };
  try {
    await read('inputs/source.txt');
    await assert.rejects(read('../private.txt'), /授权工作区/);
    await assert.rejects(read('escape/private.txt'), /符号链接/);
    assert.equal(reads, 1);
    for (const command of ['cd /Users/ctrip; ls', 'ls /Users/ctrip/biz', 'find $HOME -name "*.xlsx"', 'cd ../; ls', 'cd /tmp; python3 script.py']) {
      assert.throws(() => policy.assertCommand(command), /不允许/);
    }
    assert.doesNotThrow(() => policy.assertCommand('python3 scripts/report.py'));
    assert.match(MATERIAL_TASK_CONTRACT, /stop exploring/);
    assert.match(MATERIAL_TASK_CONTRACT, /Do not substitute quotes/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('WA-R20: Pi text-channel errors remain visible even when details is empty', () => {
  assert.equal(toolFailureText({ details: {}, content: [{ type: 'text', text: 'Command aborted' }] }), 'Command aborted');
});

test('WA-R18: real Pi loop stops a multi-tool response at budget without another provider request', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workmate-budget-loop-'));
  let requests = 0;
  const server = createServer((request, response) => {
    requests++; request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'deepseek-chat', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.write(chunk({ role: 'assistant', tool_calls: [0, 1, 2].map((index) => ({
      index, id: `write-${index}`, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: `page-${index}.html`, content: '<main>test</main>' }) },
    })) }));
    response.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const events = [];
    for await (const event of streamAgentReply({
      runId: 'budget-test', projectWorkspacePath: root, maxSteps: 1,
      profile: { id: 'general', name: 'Test', instructions: 'Write the page.', toolIds: [] },
      messages: [{ role: 'user', content: 'Create HTML page files' }],
      model: { provider: 'deepseek', chatModel: 'deepseek-chat', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'mock-key' },
    })) events.push(event);
    assert.equal(requests, 1);
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('page-')), ['page-0.html']);
    assert.equal(events.filter((event) => event.type === 'tool.started').length, 1);
    assert.equal(events.filter((event) => event.type === 'run.failed').length, 1);
    assert.equal(events.filter((event) => event.type === 'run.completed').length, 0);
    assert.match(JSON.stringify(events.find((event) => event.type === 'run.failed')), /上限（1）/);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('WA-R19: material workflow injects missing-data policy and accepts a truthful text result without forced export', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workmate-missing-data-'));
  let requests = 0; let payload = '';
  const server = createServer(async (request, response) => {
    requests++; for await (const chunk of request) payload += chunk;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'missing', object: 'chat.completion.chunk', created: 1, model: 'deepseek-chat' };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '材料没有九月收入台账。请补充收入、成本与回款数据；目前只能提供指标框架。' }, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const events = [];
    for await (const event of streamAgentReply({
      runId: 'missing-data-test', projectWorkspacePath: root,
      profile: { id: 'general', name: 'Test', instructions: 'Analyze supplied data.', toolIds: [] },
      messages: [{ role: 'user', content: '本次运行的用户材料：inputs/report.pdf。分析九月收入并生成PDF。' }],
      model: { provider: 'deepseek', chatModel: 'deepseek-chat', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'mock-key' },
    })) events.push(event);
    assert.equal(requests, 1);
    assert.match(payload, /stop exploring/);
    assert.match(payload, /read_skill_file/);
    assert.equal(events.filter((event) => event.type === 'run.completed').length, 1);
    assert.equal(events.filter((event) => event.type === 'artifact.created').length, 0);
    assert.equal(events.filter((event) => event.type === 'tool.started').length, 0);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
