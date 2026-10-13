import type { FastifyPluginAsync } from 'fastify';
import { resolveProviderBaseUrl } from '@workmate/contracts';
import { createModelCapabilityTools, evaluateDecision, testVisionCapabilityDataUrl } from '@workmate/agent-core';
import { DecisionRuntimeConfigSchema } from '@workmate/contracts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function providerInput(body: unknown) {
  const value = asRecord(body);
  return {
    type: String(value.type || '').trim(),
    baseUrl: String(value.baseUrl || '').trim(),
    workspaceId: String(value.workspaceId || '').trim(),
    service: String(value.service || '').trim(),
    apiKey: String(value.apiKey || '').trim(),
    model: String(value.model || '').trim(),
  };
}

function classifyEmbeddingError(status: number, detail: string) {
  if (status === 401 || status === 403) return { code: 'EMBED_401_UNAUTHORIZED', status: 'unauthorized' as const };
  if (status === 404) return { code: 'EMBED_404_MODEL_NOT_FOUND', status: 'misconfigured' as const };
  if (status === 422 || status === 400) return { code: 'EMBED_422_BAD_INPUT', status: 'misconfigured' as const };
  if (status >= 500) return { code: 'EMBED_503_UNAVAILABLE', status: 'unreachable' as const };
  if (/timeout/i.test(detail)) return { code: 'EMBED_408_TIMEOUT', status: 'unreachable' as const };
  return { code: 'EMBED_424_PROVIDER_INVALID_RESPONSE', status: 'misconfigured' as const };
}

async function readJsonBody(response: Response) {
  const raw = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  return { raw, parsed };
}

function extractModelsCount(payload: Record<string, unknown> | null) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return rows.length;
}

async function testProviderConnection(value: { type: string; baseUrl: string; workspaceId?: string; service?: string; apiKey: string }) {
  const { type, apiKey } = value;
  const baseUrl = resolveProviderBaseUrl({ provider: type, baseUrl: value.baseUrl, workspaceId: value.workspaceId });
  if ((type === 'volcengine' && value.service !== 'language') || type === 'iflytek') {
    return { ok: true as const, message: '语音凭据已完整配置；该厂商没有通用模型列表接口，请通过 ASR/TTS 能力执行真实连通性验证。' };
  }
  if (type === 'ollama') {
    const root = (baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/v1\/?$/, '');
    const response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Ollama 返回 ${response.status}`);
    const payload = await response.json();
    const count = Array.isArray((payload as { models?: unknown[] }).models) ? (payload as { models?: unknown[] }).models!.length : 0;
    return { ok: true as const, message: `已连接 Ollama，发现 ${count} 个本地模型。` };
  }
  if (type === 'anthropic') {
    if (!apiKey) throw new Error('请填写 API Key');
    const root = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const response = await fetch(`${root}/v1/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`Anthropic 返回 ${response.status}`);
    return { ok: true as const, message: 'Anthropic 连接成功。' };
  }
  if (type === 'google') {
    if (!apiKey) throw new Error('请填写 API Key');
    const root = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const response = await fetch(`${root}/models?key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Google 返回 ${response.status}`);
    return { ok: true as const, message: 'Google 连接成功。' };
  }
  if (!baseUrl) throw new Error('请填写 API 地址');
  if (!apiKey && type !== 'openai-compatible') throw new Error('请填写 API Key');
  const root = baseUrl.replace(/\/$/, '');
  const response = await fetch(`${root}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`接口返回 ${response.status}`);
  const payload = await response.json();
  const count = Array.isArray((payload as { data?: unknown[] }).data) ? (payload as { data?: unknown[] }).data!.length : 0;
  return { ok: true as const, message: count ? `连接成功，接口返回 ${count} 个模型。` : '连接成功。' };
}

async function listProviderModels(value: { type: string; baseUrl: string; workspaceId?: string; apiKey: string }) {
  const { type, apiKey } = value;
  const baseUrl = resolveProviderBaseUrl({ provider: type, baseUrl: value.baseUrl, workspaceId: value.workspaceId });
  if (type === 'ollama') {
    const root = (baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/v1\/?$/, '');
    const response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Ollama 返回 ${response.status}`);
    const payload = await response.json();
    return ((payload as { models?: Array<{ name?: unknown }> }).models ?? []).map((item) => String(item.name || '')).filter(Boolean);
  }
  if (type === 'anthropic') {
    if (!apiKey) throw new Error('请填写 API Key');
    const root = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const response = await fetch(`${root}/v1/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`Anthropic 返回 ${response.status}`);
    const payload = await response.json();
    return ((payload as { data?: Array<{ id?: unknown }> }).data ?? []).map((item) => String(item.id || '')).filter(Boolean);
  }
  if (type === 'google') {
    if (!apiKey) throw new Error('请填写 API Key');
    const root = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const response = await fetch(`${root}/models?key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Google 返回 ${response.status}`);
    const payload = await response.json();
    return ((payload as { models?: Array<{ name?: unknown }> }).models ?? [])
      .map((item) => String(item.name || '').replace(/^models\//, ''))
      .filter(Boolean);
  }
  if (!baseUrl) throw new Error('请填写 API 地址');
  const root = baseUrl.replace(/\/$/, '');
  const response = await fetch(`${root}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`接口返回 ${response.status}`);
  const payload = await response.json();
  return ((payload as { data?: Array<{ id?: unknown }> }).data ?? []).map((item) => String(item.id || '')).filter(Boolean);
}

async function testEmbeddingConnection(value: { type: string; baseUrl: string; apiKey: string; model: string }) {
  const startedAt = Date.now();
  const baseUrl = value.baseUrl.replace(/\/$/, '');
  const apiKey = value.apiKey.trim();
  const model = value.model.trim();
  if (!baseUrl) throw new Error('请填写 embedding API 地址');
  if (!model) throw new Error('请填写 embedding 模型 ID');
  const detail: Record<string, number> = {};
  let healthOk = false;
  try {
    const health = await fetch(`${baseUrl}/health`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    detail.healthHttpStatus = health.status;
    healthOk = health.ok;
  } catch {
    // optional health endpoint
  }

  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, input: ['health check'] }),
      signal: AbortSignal.timeout(12_000),
    });
    detail.embedHttpStatus = response.status;
    const { raw, parsed } = await readJsonBody(response);
    if (!response.ok) {
      const message = String((parsed?.error as { message?: unknown } | undefined)?.message || parsed?.message || raw.slice(0, 160) || `HTTP ${response.status}`);
      const classified = classifyEmbeddingError(response.status, message);
      return {
        ok: false as const,
        status: classified.status,
        checkedAt: Date.now(),
        latencyMs: Date.now() - startedAt,
        modelReachable: false,
        message,
        code: classified.code,
        detail,
      };
    }
    const rows = Array.isArray(parsed?.data) ? parsed.data : [];
    if (rows.length !== 1) {
      return {
        ok: false as const,
        status: 'misconfigured' as const,
        checkedAt: Date.now(),
        latencyMs: Date.now() - startedAt,
        modelReachable: false,
        message: 'Embedding 响应数量异常。',
        code: 'EMBED_424_PROVIDER_INVALID_RESPONSE',
        detail,
      };
    }
    const vector = Array.isArray((rows[0] as { embedding?: unknown }).embedding)
      ? ((rows[0] as { embedding?: unknown[] }).embedding ?? []).map((item) => Number(item))
      : [];
    if (!vector.length || vector.some((item) => !Number.isFinite(item))) {
      return {
        ok: false as const,
        status: 'misconfigured' as const,
        checkedAt: Date.now(),
        latencyMs: Date.now() - startedAt,
        modelReachable: false,
        message: 'Embedding 向量格式非法。',
        code: 'EMBED_424_PROVIDER_INVALID_RESPONSE',
        detail,
      };
    }
    return {
      ok: true as const,
      status: healthOk ? 'healthy' as const : 'degraded' as const,
      checkedAt: Date.now(),
      latencyMs: Date.now() - startedAt,
      modelReachable: true,
      message: `Embedding 可用，返回 ${vector.length} 维向量。`,
      code: null,
      detail: { ...detail, dimension: vector.length },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const classified = classifyEmbeddingError(408, message);
    return {
      ok: false as const,
      status: classified.status,
      checkedAt: Date.now(),
      latencyMs: Date.now() - startedAt,
      modelReachable: false,
      message,
      code: /timed out/i.test(message) ? 'EMBED_408_TIMEOUT' : 'EMBED_503_UNAVAILABLE',
      detail,
    };
  }
}

async function pullOllamaModel(body: unknown) {
  const value = asRecord(body);
  const root = String(value.baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/v1\/?$/, '');
  const name = String(value.modelName || '').trim();
  if (!name) throw new Error('缺少模型名称');
  const response = await fetch(`${root}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, stream: false }),
    signal: AbortSignal.timeout(900_000),
  });
  if (!response.ok) throw new Error(`Ollama 拉取失败 ${response.status}`);
  const payload = await response.json();
  return { ok: true as const, status: String((payload as { status?: unknown }).status || 'success') };
}

export const providerRoutes: FastifyPluginAsync = async (app) => {
  app.post('/providers/test-decision', async (request, reply) => {
    const parsed = DecisionRuntimeConfigSchema.safeParse(asRecord(request.body));
    if (!parsed.success) return reply.code(400).send({ ok: false, message: parsed.error.issues[0]?.message || '决策模型配置无效。' });
    const result = await evaluateDecision({ ...parsed.data, enabled: true, mode: 'observe' }, { request: 'Workmate decision connection test' }, { healthy: { type: 'noul', instructions: 'Is this a valid decision-model test request?' } });
    return reply.code(result.ok && !result.error ? 200 : 400).send(result);
  });
  app.post('/providers/test-model-capability', { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const value = asRecord(request.body);
    const capability = String(value.capability || '');
    if (!['chat', 'vision', 'image', 'video', 'tts', 'asr', 'embedding', 'quantum-code', 'decision', 'ontology'].includes(capability)) return reply.code(400).send({ message: '不支持该模型能力测试。' });
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'workmate-model-test-'));
    const startedAt = Date.now();
    try {
      const baseUrl = resolveProviderBaseUrl({ provider: String(value.type || ''), baseUrl: String(value.baseUrl || ''), workspaceId: String(value.workspaceId || '') });
      const config = {
        id: 'model-test', capability, mode: 'auto',
        provider: String(value.type || 'openai-compatible'), baseUrl,
        apiKey: String(value.apiKey || ''), apiSecret: String(value.apiSecret || ''), appId: String(value.appId || ''),
        modelId: String(value.model || ''), voice: String(value.voice || ''), imageProtocol: value.imageProtocol || undefined,
      } as any;
      if (capability === 'decision') {
        const result = await evaluateDecision({
          enabled: true,
          mode: 'observe',
          provider: String(value.providerLabel || value.type || 'decision'),
          protocol: 'system-one-v1',
          baseUrl,
          apiKey: String(value.apiKey || ''),
          model: String(value.model || ''),
          timeoutMs: 10_000,
          failurePolicy: 'deny',
          guardTools: true,
          agentTool: true,
          mcpEnabled: false,
        }, { request: String(value.prompt || 'Should this low-risk connection test be allowed?') }, { healthy: { type: 'noul', instructions: 'Return whether the request is safe to continue.' } });
        if (!result.ok || result.error) throw new Error(result.error || '决策模型未返回有效判断。');
        return { ok: true, latencyMs: Date.now() - startedAt, result: { ...result, content: JSON.stringify(result.answers ?? result, null, 2) } };
      }
      if (capability === 'vision') {
        if (!String(value.imageDataUrl || '').startsWith('data:image/')) throw new Error('请先选择一张测试图片。');
        const result = await testVisionCapabilityDataUrl(config, String(value.prompt || '请简要描述图片内容。'), String(value.imageDataUrl));
        return { ok: true, latencyMs: Date.now() - startedAt, result: { ...result, content: result.analysis } };
      }
      if (capability === 'chat' || capability === 'ontology') {
        const content = String(value.prompt || '请用一句话介绍你自己。');
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(value.apiKey ? { authorization: `Bearer ${String(value.apiKey)}` } : {}) }, body: JSON.stringify({ model: String(value.model || ''), messages: [{ role: 'user', content }], max_tokens: 300 }), signal: AbortSignal.timeout(120_000) });
        const raw = await response.text();
        let data: any; try { data = JSON.parse(raw); } catch { data = null; }
        if (!response.ok) throw new Error(String(data?.error?.message || data?.message || raw.slice(0, 500) || `HTTP ${response.status}`));
        const output = String(data?.choices?.[0]?.message?.content || '').trim();
        if (!output) throw new Error('模型没有返回文本内容。');
        return { ok: true, latencyMs: Date.now() - startedAt, result: { content: output, usage: data?.usage ?? null } };
      }
      const tool = createModelCapabilityTools({ workspaceRoot, configs: [config] })[0];
      if (!tool) throw new Error('无法创建该模型的测试工具。');
      if (capability === 'asr') {
        const bytes = Buffer.from(String(value.audioBase64 || ''), 'base64');
        if (!bytes.byteLength) throw new Error('请先选择一段测试音频。');
        const extension = String(value.audioExtension || 'wav').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'wav';
        await mkdir(path.join(workspaceRoot, 'input'), { recursive: true });
        await writeFile(path.join(workspaceRoot, `input/sample.${extension}`), bytes);
      }
      const input = capability === 'image' ? { prompt: String(value.prompt || '一只放在木桌上的青花瓷杯，柔和自然光，产品摄影'), size: String(value.size || '1024x1024') }
        : capability === 'video' ? { prompt: String(value.prompt || '一只橘猫在阳光下的草地上缓慢奔跑，镜头平稳跟随'), size: String(value.size || '1920x1080') }
        : capability === 'tts' ? { text: String(value.prompt || '你好，这是 Workmate 语音模型测试。'), ...(value.voice ? { voice: String(value.voice) } : {}), format: 'mp3' }
          : capability === 'asr' ? { path: `input/sample.${String(value.audioExtension || 'wav').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'wav'}`, outputFormat: 'text' }
          : capability === 'embedding' ? { texts: [String(value.prompt || 'Workmate 模型测试')] }
            : { task: String(value.prompt || '请给出一个创建 Bell 态的最小 Qiskit 示例。') };
      const result = (await tool.execute('model-test', input, undefined)).details as any;
      if (result?.ok === false) throw new Error(String(result.error || '模型返回失败。'));
      let media: { mimeType: string; base64: string } | undefined;
      if (result?.path && (capability === 'image' || capability === 'video' || capability === 'tts')) {
        const bytes = await readFile(path.join(workspaceRoot, String(result.path)));
        media = { mimeType: capability === 'image' ? `image/${path.extname(result.path).slice(1).replace('jpg', 'jpeg')}` : capability === 'video' ? 'video/mp4' : String(result.mimeType || 'audio/mpeg'), base64: bytes.toString('base64') };
      }
      return { ok: true, latencyMs: Date.now() - startedAt, result, media };
    } catch (error) {
      const cause = (error as { cause?: { code?: unknown; message?: unknown } })?.cause;
      const message = [error instanceof Error ? error.message : String(error), cause?.code, cause?.message].filter(Boolean).map(String).join(' / ');
      return reply.code(400).send({ ok: false, latencyMs: Date.now() - startedAt, message });
    } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
  });

  app.post('/providers/test', async (request, reply) => {
    try {
      return await testProviderConnection(providerInput(request.body));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/providers/models', async (request, reply) => {
    try {
      return { models: await listProviderModels(providerInput(request.body)) };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/providers/test-embedding', async (request, reply) => {
    try {
      const result = await testEmbeddingConnection(providerInput(request.body));
      return reply.code(result.ok ? 200 : 400).send(result);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/providers/ollama/pull', async (request, reply) => {
    try {
      return await pullOllamaModel(request.body);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });
};
