/** VIS-T3: isolated authenticated API -> orchestrator -> real Pi -> local mock HTTP provider. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-vision-e2e-'));
const payloads = [];
const provider = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  payloads.push(JSON.parse(raw));
  const payload = payloads.at(-1);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null, usage) => `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
  if (payload.model === 'text-mock' && payload.messages.at(-1)?.role !== 'tool') {
    res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'inspect-picture', type: 'function', function: { name: 'model_understand_images', arguments: JSON.stringify({ focus: '检查与用户问题相关的细节和可读文字' }) } }] }));
    res.end(chunk({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) + 'data: [DONE]\n\n'); return;
  }
  res.write(chunk({ role: 'assistant', content: payload.model === 'text-mock' ? '已依据图片理解工具的证据完成回答。' : '已收到原始图片（本地协议测试，不是实际识图结论）。' }));
  res.end(chunk({}, 'stop', payload.model === 'specialist-mock'
    ? { prompt_tokens: 31, completion_tokens: 9, total_tokens: 40 }
    : { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) + 'data: [DONE]\n\n');
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const allocator = createServer();
await new Promise((resolve) => allocator.listen(0, '127.0.0.1', resolve));
const apiPort = allocator.address().port;
await new Promise((resolve) => allocator.close(resolve));
const base = `http://127.0.0.1:${apiPort}/api`;
let serverLog = '';
const child = spawn(process.execPath, ['apps/api/dist/main.cjs'], { env: {
  ...process.env, OPENCLAWX_DATA_DIR: root, OPENCLAWX_API_PORT: String(apiPort),
  OPENCLAWX_ORCH_RUNNER: '', OPENCLAWX_AGENT_ENGINE: 'pi', OPENCLAWX_AGENT_ENGINE_FORCE: '0',
  OPENCLAWX_AGENTSCOPE_ENABLED: '0', OPENCLAWX_EXPERIENCE_DIR: path.join(root, 'experience'),
  OPENCLAWX_SKILLS_DIR: path.join(root, 'skills'), OPENCLAWX_WEB_STATIC_DIR: process.env.VISION_UI === '1' ? path.resolve('apps/renderer/dist') : '',
}, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (data) => { serverLog = (serverLog + data).slice(-5000); });
child.stderr.on('data', (data) => { serverLog = (serverLog + data).slice(-5000); });
let token = '';
async function call(route, method = 'GET', body, expected = 200, auth = token) {
  const response = await fetch(base + route, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(auth ? { 'x-openclawx-session': auth } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(data)}`);
  return data;
}
async function until(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do { const result = await fn(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 100)); } while (Date.now() < deadline);
  throw new Error('Timed out');
}
try {
  await until(() => fetch(base + '/health').then((response) => response.ok).catch(() => false));
  token = (await call('/auth/bootstrap', 'POST', { username: 'vision-admin', displayName: 'Vision test', password: 'temporary-vision-test-password' })).token;
  const { session } = await call('/orch/sessions', 'POST', { title: 'VIS-001', employeeId: 'general' });
  const url = `/orch/sessions/${session.id}`;
  const { attachment } = await call(url + '/images', 'POST', { name: '测试.png', dataBase64: png });
  await call(url + '/images', 'POST', { name: 'fake.png', dataBase64: 'PHN2Zy8+' }, 400);
  await call(url + '/images', 'POST', { name: 'x.png', dataBase64: png }, 401, '');
  const response = await fetch(base + url + `/images/${attachment.id}`, { headers: { 'x-openclawx-session': token } });
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('base64'), png);
  await call('/auth/users', 'POST', { username: 'vision-member', displayName: 'Member', password: 'temporary-vision-test-password' });
  const memberToken = (await call('/auth/login', 'POST', { username: 'vision-member', password: 'temporary-vision-test-password' })).token;
  await call(url + `/images/${attachment.id}`, 'GET', undefined, 404, memberToken);
  const second = await call('/orch/sessions', 'POST', { title: 'Other', employeeId: 'general' });
  const context = { profile: { id: 'general', name: 'Test', instructions: 'Answer briefly without tools.', toolIds: [] }, model: { provider: 'openai-compatible', chatModel: 'vision-mock', apiKey: 'local-test', supportsVision: true, baseUrl: `http://127.0.0.1:${provider.address().port}/v1` }, engine: 'pi', skills: [], searchProviders: [], knowledgeBases: [], mcpConnections: [], modelCapabilities: [] };
  const bad = await fetch(base + `/orch/sessions/${second.session.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-openclawx-session': token }, body: JSON.stringify({ content: 'cross session', attachments: [attachment], context }) });
  assert.ok(!bad.ok); assert.match((await bad.json()).message, /IMAGE_UNAVAILABLE/);
  await call('/chat', 'POST', { ...context, conversationId: session.id, messages: [{ role: 'user', content: 'bypass', attachments: [attachment] }] }, 400);
  for (const unsupported of [{ ...context, engine: 'dsh' }, { ...context, model: { ...context.model, supportsVision: false } }]) {
    const result = await fetch(base + url + '/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-openclawx-session': token }, body: JSON.stringify({ content: 'should reject', attachments: [attachment], context: unsupported }) });
    assert.ok(!result.ok); assert.match((await result.json()).message, /VISION_.*UNSUPPORTED/);
  }
  for (const [content, attachments] of [['分析图片', [attachment]], ['继续检查原图', undefined]]) {
    const { runId } = await call(url + '/messages', 'POST', { content, attachments, context });
    await until(async () => {
      const { session: current } = await call(url);
      const message = current.messages.find((item) => item.runId === runId);
      return message?.content?.includes('已收到原始图片');
    });
  }
  assert.equal(payloads.length, 2);
  for (const payload of payloads) {
    assert.ok(payload.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url' && part.image_url.url === `data:image/png;base64,${png}`)), 'original image in first AND follow-up model HTTP request');
  }
  // M2: primary is text-only; actual Pi loop must call the unified vision tool.
  const visionConfig = { id: 'specialist', capability: 'vision', provider: 'openai-compatible', modelId: 'specialist-mock', baseUrl: context.model.baseUrl, apiKey: 'local-test', mode: 'auto' };
  const textContext = { ...context, profile: { ...context.profile, instructions: 'Use the image understanding tool before answering image questions.' }, model: { ...context.model, chatModel: 'text-mock', supportsVision: false }, modelCapabilities: [visionConfig] };
  const textUrl = `/orch/sessions/${second.session.id}`;
  const textAttachment = (await call(textUrl + '/images', 'POST', { name: '目标截图.png', dataBase64: png })).attachment;
  const questions = ['这张截图为何连接失败？', '再看原图，有什么状态码？'];
  for (let index = 0; index < questions.length; index++) {
    const { runId } = await call(textUrl + '/messages', 'POST', { content: questions[index], ...(index === 0 ? { attachments: [textAttachment] } : {}), context: textContext });
    await until(async () => {
      const { session: current } = await call(textUrl);
      return current.messages.find((item) => item.runId === runId)?.content?.includes('已依据图片理解工具');
    });
    const { run } = await call(`/orch/runs/${runId}`);
    assert.ok(run.activities.some((item) => item.toolName === 'model:vision' && item.status === 'completed'), 'visible successful vision activity');
    assert.ok(run.eventLog.some((event) => event.type === 'capability.progress' && event.capability === 'vision'), 'visible vision progress');
    assert.equal(run.model.chatModel, 'text-mock', 'application usage must not replace primary model identity');
    assert.equal(run.usage.byModel.find((item) => item.capability === 'vision' && item.chatModel === 'specialist-mock')?.totalTokens, 40, 'vision usage attributed to specialist model');
  }
  const mainCalls = payloads.filter((payload) => payload.model === 'text-mock');
  const visionCalls = payloads.filter((payload) => payload.model === 'specialist-mock');
  assert.equal(mainCalls.length, 4); assert.equal(visionCalls.length, 2);
  assert.ok(mainCalls.every((payload) => !JSON.stringify(payload).includes(png)), 'text primary never receives raw images');
  visionCalls.forEach((payload, index) => {
    assert.ok(JSON.stringify(payload).includes(png));
    assert.ok(JSON.stringify(payload).includes(questions[index]), 'original current question carried into vision call');
  });
  const domain = await readFile(path.join(root, 'domain.json'), 'utf8');
  assert.ok(!domain.includes(png), 'no base64 in durable domain/run records');
  assert.ok(domain.includes(attachment.id), 'durable attachment reference');
  await call(url, 'DELETE');
  await call(url + `/images/${attachment.id}`, 'GET', undefined, 404);
  console.log('VIS-T3 + VIS-M2-T2 PASS: auth/scope/direct vision/text-primary -> vision tool -> answer/follow-up/progress/persistence/delete; no paid provider calls.');
  if (process.env.VISION_UI === '1') {
    await call('/settings/model', 'PUT', { version: 3, providerInstances: [{ id: 'local-vision', type: 'openai-compatible', name: '本地视觉协议测试', baseUrl: context.model.baseUrl, apiKey: 'local-test' }], models: [{ id: 'vision-model', providerInstanceId: 'local-vision', capability: 'chat', modelId: 'vision-mock', supportsVision: true }, { id: 'text-model', providerInstanceId: 'local-vision', capability: 'chat', modelId: 'text-mock' }, { id: 'specialist', providerInstanceId: 'local-vision', capability: 'vision', modelId: 'specialist-mock' }], activeChatModelId: 'text-model', capabilityBindings: [{ capability: 'vision', modelId: 'specialist', enabled: true }], agentCapabilityAssignments: [{ agentId: 'general', capability: 'vision', mode: 'auto' }] });
    await writeFile(path.join(root, 'test.png'), Buffer.from(png, 'base64'));
    console.log(`UI fixture: http://127.0.0.1:${apiPort}/ ; image=${path.join(root, 'test.png')} ; login=vision-admin (temporary password in script). Stop with Ctrl+C.`);
    await once(process, 'SIGINT');
  }
} catch (error) {
  console.error(serverLog); throw error;
} finally {
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await new Promise((resolve) => provider.close(resolve));
  await rm(root, { recursive: true, force: true });
}
