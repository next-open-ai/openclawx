import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { strToU8, zipSync } from 'fflate';

const port = 4497;
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openclawx-attachments-regression-'));
const origin = `http://127.0.0.1:${port}`;
const api = spawn(process.execPath, ['apps/api/dist/main.cjs'], {
  cwd: process.cwd(),
  env: { ...process.env, OPENCLAWX_API_PORT: String(port), OPENCLAWX_DATA_DIR: dataDir, OPENCLAWX_ORCH_RUNNER: 'memory-echo' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
let token = '';
api.stdout.on('data', (chunk) => { logs += chunk; });
api.stderr.on('data', (chunk) => { logs += chunk; });

async function waitFor(fn, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out. API logs:\n${logs.slice(-2000)}`);
}
async function json(url, init) {
  const response = await fetch(`${origin}${url}`, { ...init, headers: { ...(init?.headers || {}), ...(token ? { 'x-openclawx-session': token } : {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url} -> ${response.status}: ${body.message || JSON.stringify(body)}`);
  return body;
}

try {
  await waitFor(async () => (await fetch(`${origin}/api/health`)).ok);
  const auth = await json('/api/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', displayName: 'Admin', password: 'attachment-test' }) });
  token = auth.token;
  const created = await json('/api/orch/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'attachment regression' }) });
  const sessionId = created.session.id;
  const source = Buffer.from('# Quarterly brief\nRevenue increased by 18 percent.\nRisk: supplier concentration.');
  const uploadResponse = await fetch(`${origin}/api/orch/sessions/${sessionId}/files`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-openclawx-file-name': encodeURIComponent('季度简报.md'), 'x-openclawx-session': token }, body: source,
  });
  const uploaded = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200, JSON.stringify(uploaded));
  assert.equal(uploaded.attachment.kind, 'document');

  const htmlSource = Buffer.from('<!doctype html><html><head><title>项目周报</title><style>.secret{display:none}</style></head><body><h1>本周进展</h1><p>已完成 HTML 附件支持。</p><script>window.evil = true</script><ul><li>保留正文</li><li>过滤脚本</li></ul></body></html>');
  const htmlUploadResponse = await fetch(`${origin}/api/orch/sessions/${sessionId}/files`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-openclawx-file-name': encodeURIComponent('项目周报.html'), 'x-openclawx-session': token }, body: htmlSource,
  });
  const uploadedHtml = await htmlUploadResponse.json();
  assert.equal(htmlUploadResponse.status, 200, JSON.stringify(uploadedHtml));
  assert.equal(uploadedHtml.attachment.mimeType, 'text/html');
  assert.match(uploadedHtml.attachment.summary, /HTML 正文/);
  const htmlContext = await readFile(path.join(dataDir, 'chat-attachments', sessionId, uploadedHtml.attachment.id, 'context.txt'), 'utf8');
  assert.match(htmlContext, /标题：项目周报/);
  assert.match(htmlContext, /已完成 HTML 附件支持/);
  assert.doesNotMatch(htmlContext, /window\.evil|display:none/);

  const presentation = Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'),
    'ppt/slides/slide1.xml': strToU8('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>年度经营回顾</a:t></a:r></a:p><a:p><a:r><a:t>营业收入增长 18%</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'),
    'ppt/slides/slide2.xml': strToU8('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>风险与计划</a:t></a:r></a:p><a:p><a:r><a:t>下一季度重点降低供应商集中度</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'),
    'ppt/slides/_rels/slide2.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>'),
    'ppt/notesSlides/notesSlide1.xml': strToU8('<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>向管理层解释供应链改善计划</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>'),
  }));
  const presentationUpload = await fetch(`${origin}/api/orch/sessions/${sessionId}/files`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-openclawx-file-name': encodeURIComponent('年度经营报告.pptx'), 'x-openclawx-session': token }, body: presentation,
  });
  const uploadedPresentation = await presentationUpload.json();
  assert.equal(presentationUpload.status, 200, JSON.stringify(uploadedPresentation));
  assert.match(uploadedPresentation.attachment.summary, /2 页幻灯片/);
  const presentationContext = await readFile(path.join(dataDir, 'chat-attachments', sessionId, uploadedPresentation.attachment.id, 'context.txt'), 'utf8');
  assert.match(presentationContext, /第 1 页：年度经营回顾/);
  assert.match(presentationContext, /营业收入增长 18%/);
  assert.match(presentationContext, /演讲者备注[\s\S]*向管理层解释供应链改善计划/);

  const context = { profile: { id: 'general', name: 'General', instructions: 'Answer.', toolIds: [] }, model: { provider: 'ollama', chatModel: 'smoke', apiKey: 'ollama' }, skills: [], searchProviders: [], mcpConnections: [], knowledgeBases: [] };
  await json(`/api/orch/sessions/${sessionId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '收入增长多少？', fileAttachments: [uploaded.attachment, uploadedPresentation.attachment, uploadedHtml.attachment], context }) });
  const settled = await waitFor(async () => {
    const current = await json(`/api/orch/sessions/${sessionId}`);
    return current.session.messages.some((item) => item.role === 'assistant' && item.content) ? current.session : null;
  });
  const user = settled.messages.find((item) => item.role === 'user');
  assert.equal(user.fileAttachments[0].name, '季度简报.md');
  assert.equal(user.fileAttachments[1].name, '年度经营报告.pptx');
  assert.equal(user.fileAttachments[2].name, '项目周报.html');
  assert.equal(user.content, '收入增长多少？');
  assert.equal(Object.hasOwn(user, 'attachmentContext'), false, 'model-only attachment context must not leak through the API');

  const asset = await json('/api/assets/import-chat-attachment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, attachmentId: uploaded.attachment.id }) });
  assert.equal(asset.name, '季度简报.md');
  await json(`/api/orch/sessions/${sessionId}`, { method: 'DELETE' });
  await assert.rejects(readFile(path.join(dataDir, 'chat-attachments', sessionId, uploaded.attachment.id, 'original')));
  console.log('[chat-attachments] document/HTML/PPTX upload, sanitization, slide notes, send, asset promotion and cleanup: PASS');
} finally {
  api.kill('SIGTERM');
  await new Promise((resolve) => api.once('exit', resolve));
  await rm(dataDir, { recursive: true, force: true });
}
