import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ImageGenerationProtocol, ModelCapabilityRuntime } from '@workmate/contracts';
import { suggestedSpeechVoices } from '@workmate/contracts';
import { embedOpenAiCompatible } from './embedding-http.js';
import { materializeAudioInput } from './audio-input.js';
import { createVisionCapabilityTool, type VisionToolContext } from './vision-capability.js';
import { SpeechNetworkError } from './speech-http.js';
import { uploadDashScopeAudio } from './speech-provider-adapters.js';
import { Type, defineAgentTool } from './pi-tools.js';
import { createUnifiedToolSession, registrationsFromTools, type UnifiedToolSession } from './unified-tool-runtime.js';
import { SpeechProviderHttpError, synthesizeDashScope, synthesizeIflytek, synthesizeVolcengine, transcribeDashScope, transcribeIflytek, transcribeVolcengine } from './speech-provider-adapters.js';

export const MODEL_CAPABILITY_BY_TOOL = {
  quantum_code_generate: 'quantum-code',
  model_generate_image: 'image',
  model_generate_video: 'video',
  model_understand_images: 'vision',
  model_embed_text: 'embedding',
  model_transcribe_audio: 'asr',
  model_synthesize_speech: 'tts',
} as const;

function endpoint(baseUrl: string, suffix: string) {
  return `${baseUrl.replace(/\/$/, '')}${suffix}`;
}

function headers(config: ModelCapabilityRuntime) {
  return { ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}), 'content-type': 'application/json' };
}

async function jsonRequest(
  config: ModelCapabilityRuntime,
  suffix: string,
  body: unknown,
  timeoutMs = 60_000,
  options: { method?: 'GET' | 'POST'; headers?: Record<string, string> } = {},
) {
  const method = options.method ?? 'POST';
  const url = endpoint(config.baseUrl, suffix);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { ...headers(config), ...options.headers },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = fetchFailureDetail(error) || 'unknown network error';
    throw new Error(`Capability provider network request failed: ${method} ${url} — ${detail}`);
  }
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!response.ok) {
    const detail = String(data?.error?.message || data?.message || text.slice(0, 300) || 'empty response');
    throw new Error(`Capability provider request failed: HTTP ${response.status} ${method} ${url} — ${detail}`);
  }
  if (!data) throw new Error('Capability provider returned invalid JSON.');
  return data;
}

function imageProtocol(config: ModelCapabilityRuntime): ImageGenerationProtocol {
  if (config.imageProtocol) return config.imageProtocol;
  const id = config.modelId.trim().toLowerCase();
  if (config.provider !== 'qwen') return 'openai-images';
  if (/^qwen-image-3(?:\.|-|$)/.test(id)) return 'openai-images';
  if (/^(wan2\.[0-5]|wanx)/.test(id)) return 'dashscope-image-async';
  return 'dashscope-multimodal';
}

function dashscopeConfig(config: ModelCapabilityRuntime): ModelCapabilityRuntime {
  const baseUrl = config.baseUrl.replace(/\/$/, '').replace(/\/(?:compatible-mode\/v1|api\/v1)$/, '');
  return { ...config, baseUrl };
}

function normalizeImageSize(size: string | undefined, separator: 'x' | '*') {
  const value = (size || '1024x1024').trim();
  return separator === '*' ? value.replace(/[x×]/i, '*') : value.replace(/[×*]/, 'x');
}

function imageUrlsFromDashScope(data: any): string[] {
  const content = data?.output?.choices?.flatMap((choice: any) => choice?.message?.content ?? []) ?? [];
  return [
    ...(data?.output?.results ?? []).map((item: any) => item?.url || item?.image),
    ...content.map((item: any) => item?.image || item?.url),
  ].filter((item: unknown): item is string => typeof item === 'string' && item.length > 0);
}

type ProgressReporter = (summary: string, progress?: number) => void;

async function generateImage(config: ModelCapabilityRuntime, prompt: string, size?: string, report: ProgressReporter = () => undefined) {
  const protocol = imageProtocol(config);
  if (protocol === 'openai-images') {
    report('正在向图片模型提交生成请求…', 10);
    const data = await jsonRequest(config, '/images/generations', {
      model: config.modelId, prompt, size: normalizeImageSize(size, 'x'),
      // BigModel's image API returns temporary URLs and does not document
      // OpenAI's n/response_format options. Keep other providers unchanged.
      ...(config.provider === 'glm' ? {} : { n: 1, response_format: 'b64_json' }),
    }, 180_000);
    const row = data?.data?.[0];
    if (row?.b64_json) { report('图片生成完成，正在保存到工作区…', 85); return { bytes: Buffer.from(row.b64_json, 'base64') }; }
    if (row?.url) { report('图片生成完成，正在下载临时图片…', 80); return { url: String(row.url) }; }
    throw new Error('Image provider returned neither image data nor URL.');
  }

  if (protocol === 'dashscope-multimodal') {
    report('正在向图片模型提交生成请求…', 10);
    const data = await jsonRequest(dashscopeConfig(config), '/api/v1/services/aigc/multimodal-generation/generation', {
      model: config.modelId,
      input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
      parameters: { size: normalizeImageSize(size, '*'), n: 1 },
    }, 300_000);
    const url = imageUrlsFromDashScope(data)[0];
    if (!url) throw new Error('DashScope multimodal provider returned no image URL.');
    report('图片生成完成，正在下载临时图片…', 80);
    return { url };
  }

  const nativeConfig = dashscopeConfig(config);
  report('正在提交异步图片生成任务…', 5);
  const submitted = await jsonRequest(nativeConfig, '/api/v1/services/aigc/text2image/image-synthesis', {
    model: config.modelId,
    input: { prompt },
    parameters: { size: normalizeImageSize(size, '*'), n: 1 },
  }, 60_000, { headers: { 'X-DashScope-Async': 'enable' } });
  const taskId = String(submitted?.output?.task_id || '');
  if (!taskId) throw new Error('DashScope asynchronous provider returned no task_id.');
  const deadline = Date.now() + 300_000;
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    const task = await jsonRequest(nativeConfig, `/api/v1/tasks/${encodeURIComponent(taskId)}`, undefined, 30_000, { method: 'GET' });
    const status = String(task?.output?.task_status || '').toUpperCase();
    if (status === 'SUCCEEDED' || status === 'SUCCESS') {
      const url = imageUrlsFromDashScope(task)[0];
      if (!url) throw new Error(`DashScope task ${taskId} completed without an image URL.`);
      report('图片生成完成，正在下载临时图片…', 80);
      return { url, taskId };
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED') {
      throw new Error(`DashScope image task ${taskId} ${status.toLowerCase()}: ${String(task?.output?.message || task?.message || 'unknown error')}`);
    }
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1_000));
    const progress = Math.min(75, 15 + Math.floor(elapsedSeconds / 6));
    report(`图片正在生成（${status || '排队中'}，已等待 ${elapsedSeconds} 秒）…`, progress);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`DashScope image task ${taskId} timed out after 300000ms.`);
}

const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function imageExtension(contentType: string, bytes: Uint8Array) {
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/png') return 'png';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'webp';
  throw new Error(`Image provider download returned unsupported content type: ${mime || 'unknown'}.`);
}

function fetchFailureDetail(error: unknown) {
  const value = error as { message?: unknown; cause?: { code?: unknown; message?: unknown } };
  return [value?.message, value?.cause?.code, value?.cause?.message].filter(Boolean).map(String).join(' / ');
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function providerFetch(url: string, init: RequestInit, signal: AbortSignal | undefined, timeoutMs: number, label: string) {
  try {
    return await fetch(url, { ...init, signal: requestSignal(signal, timeoutMs) });
  } catch (error) {
    throw new Error(`${label} network request failed: ${String(init.method || 'GET')} ${url} — ${fetchFailureDetail(error) || 'unknown network error'}`);
  }
}

async function downloadWithCurl(url: URL) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'workmate-image-'));
  const target = path.join(tempRoot, 'download');
  try {
    await execFileAsync('curl', [
      '--fail', '--location', '--silent', '--show-error',
      '--connect-timeout', '20', '--max-time', '120',
      '--max-filesize', String(MAX_GENERATED_IMAGE_BYTES),
      '--output', target, url.toString(),
    ], { timeout: 130_000, maxBuffer: 64 * 1024 });
    return new Uint8Array(await readFile(target));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function downloadGeneratedImage(urlValue: string, report: ProgressReporter = () => undefined) {
  let url: URL;
  try { url = new URL(urlValue); } catch { throw new Error('Image provider returned an invalid image URL.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Image provider returned a non-HTTP image URL.');
  let bytes: Uint8Array;
  let contentType = '';
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAX_GENERATED_IMAGE_BYTES) throw new Error('Generated image exceeds the 25 MB download limit.');
    contentType = response.headers.get('content-type') || '';
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    report('直接下载连接失败，正在切换兼容下载通道…', 82);
    try {
      bytes = await downloadWithCurl(url);
    } catch (fallbackError) {
      throw new Error(`Generated image download failed. Direct: ${fetchFailureDetail(error) || 'unknown error'}; fallback: ${fetchFailureDetail(fallbackError) || 'unknown error'}`);
    }
  }
  if (bytes.byteLength === 0) throw new Error('Image provider download returned an empty file.');
  if (bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) throw new Error('Generated image exceeds the 25 MB download limit.');
  return { bytes, extension: imageExtension(contentType, bytes) };
}

const MAX_GENERATED_VIDEO_BYTES = 200 * 1024 * 1024;

async function generateVideo(config: ModelCapabilityRuntime, prompt: string, size: string | undefined, duration: number | undefined, report: ProgressReporter) {
  if (config.provider !== 'glm') throw new Error('Video generation currently supports the GLM provider protocol only.');
  report('正在提交异步视频生成任务…', 5);
  const submitted = await jsonRequest(config, '/videos/generations', {
    model: config.modelId,
    prompt: prompt.slice(0, 512),
    ...(size ? { size: normalizeImageSize(size, 'x') } : {}),
    ...(config.modelId.toLowerCase() === 'cogvideox-3' && duration ? { duration } : {}),
  }, 60_000);
  const taskId = String(submitted?.id || submitted?.request_id || '');
  if (!taskId) throw new Error('GLM video provider returned no task ID.');
  const deadline = Date.now() + 10 * 60_000;
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    const task = await jsonRequest(config, `/async-result/${encodeURIComponent(taskId)}`, undefined, 30_000, { method: 'GET' });
    const status = String(task?.task_status || '').toUpperCase();
    if (status === 'SUCCESS' || status === 'SUCCEEDED') {
      const url = String(task?.video_result?.[0]?.url || '');
      if (!url) throw new Error(`GLM video task ${taskId} completed without a video URL.`);
      report('视频生成完成，正在下载临时视频…', 82);
      return { url, taskId };
    }
    if (['FAIL', 'FAILED', 'CANCELED', 'CANCELLED'].includes(status)) {
      throw new Error(`GLM video task ${taskId} ${status.toLowerCase()}: ${String(task?.error?.message || task?.message || 'unknown error')}`);
    }
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1_000));
    report(`视频正在生成（${status || '排队中'}，已等待 ${elapsedSeconds} 秒）…`, Math.min(78, 12 + Math.floor(elapsedSeconds / 8)));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`GLM video task ${taskId} timed out after 600000ms.`);
}

async function downloadGeneratedVideo(urlValue: string) {
  let url: URL;
  try { url = new URL(urlValue); } catch { throw new Error('Video provider returned an invalid video URL.'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Video provider returned a non-HTTP video URL.');
  const response = await providerFetch(url.toString(), { redirect: 'follow' }, undefined, 180_000, 'Generated video download');
  if (!response.ok) throw new Error(`Generated video download failed: HTTP ${response.status}.`);
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > MAX_GENERATED_VIDEO_BYTES) throw new Error('Generated video exceeds the 200 MB download limit.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength) throw new Error('Video provider download returned an empty file.');
  if (bytes.byteLength > MAX_GENERATED_VIDEO_BYTES) throw new Error('Generated video exceeds the 200 MB download limit.');
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const hasMp4Signature = bytes.byteLength > 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp';
  if (!contentType.startsWith('video/') && !hasMp4Signature) throw new Error(`Video provider download returned unsupported content type: ${contentType || 'unknown'}.`);
  return bytes;
}

function safeWorkspacePath(root: string, relative: string) {
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Path is outside the run workspace.');
  return target;
}

async function safeReadableWorkspacePath(root: string, relative: string) {
  const candidate = safeWorkspacePath(root, relative);
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  const rel = path.relative(realRoot, realCandidate);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Resolved path is outside the run workspace.');
  return realCandidate;
}

const MAX_AUDIO_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_AUDIO_OUTPUT_BYTES = 25 * 1024 * 1024;
const AUDIO_INPUT_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.mp4', '.mpeg', '.mpga', '.ogg', '.opus', '.wav', '.webm']);

async function readableAudioFile(root: string, relative: string) {
  const target = await safeReadableWorkspacePath(root, relative);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('ASR input must be a regular audio file.');
  if (!AUDIO_INPUT_EXTENSIONS.has(path.extname(target).toLowerCase())) throw new Error('Unsupported ASR audio format. Use AAC, FLAC, M4A, MP3, MP4, MPEG, OGG, OPUS, WAV, or WEBM.');
  if (info.size <= 0) throw new Error('ASR input audio is empty.');
  if (info.size > MAX_AUDIO_INPUT_BYTES) throw new Error('ASR input exceeds the 25 MB limit. Split or compress the audio before transcription.');
  return { target, info };
}

function audioMime(extension: string) {
  return ({ mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg', pcm: 'audio/pcm' } as Record<string, string>)[extension] || 'application/octet-stream';
}

async function writeOutput(root: string, extension: string, bytes: Uint8Array) {
  const relative = `output/capability-${crypto.randomUUID()}.${extension}`;
  const target = safeWorkspacePath(root, relative);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(path.dirname(target))]);
  const parentRel = path.relative(realRoot, realParent);
  if (parentRel === '..' || parentRel.startsWith(`..${path.sep}`) || path.isAbsolute(parentRel)) throw new Error('Output directory escapes the run workspace.');
  await writeFile(target, bytes, { mode: 0o600 });
  return relative;
}

function configFor(configs: ModelCapabilityRuntime[], capability: ModelCapabilityRuntime['capability']) {
  return configs.find((item) => item.capability === capability && item.mode !== 'disabled');
}

export function createModelCapabilityTools(input: { configs?: ModelCapabilityRuntime[]; workspaceRoot: string; visionContext?: VisionToolContext }): AgentTool<any>[] {
  const configs = input.configs ?? [];
  const tools: AgentTool<any>[] = [];
  const vision = configFor(configs, 'vision');
  if (vision && input.visionContext?.messages.some((message) => message.attachments?.length)) tools.push(createVisionCapabilityTool(vision, input.visionContext));
  const quantum = configFor(configs, 'quantum-code');
  if (quantum) tools.push(defineAgentTool({
    name: 'quantum_code_generate',
    description: 'Use the authorized specialist model to generate or repair Qiskit/Python code for a focused quantum-programming subtask. It generates code only and does not execute it.',
    parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 12_000 }), sdkVersion: Type.Optional(Type.String({ maxLength: 80 })), existingCode: Type.Optional(Type.String({ maxLength: 24_000 })) }),
    execute: async ({ task, sdkVersion, existingCode }) => {
      const data = await jsonRequest(quantum, '/chat/completions', {
        model: quantum.modelId,
        messages: [
          { role: 'system', content: `You are a quantum-code specialist. Target ${sdkVersion || 'qiskit-2.x'}. Return code first; never claim execution.` },
          { role: 'user', content: existingCode ? `${task}\n\nExisting code to repair:\n${existingCode}` : task },
        ],
        temperature: 0.1,
      });
      const content = String(data?.choices?.[0]?.message?.content || '');
      if (!content) throw new Error('Quantum-code provider returned no content.');
      return { ok: true, capability: 'quantum-code', modelId: quantum.modelId, content, usage: data.usage ?? null };
    },
  }));

  const embedding = configFor(configs, 'embedding');
  if (embedding) tools.push(defineAgentTool({
    name: 'model_embed_text',
    description: 'Create embeddings with the authorized embedding model. Use only when numeric vectors are required by the task.',
    parameters: Type.Object({ texts: Type.Array(Type.String({ minLength: 1, maxLength: 20_000 }), { minItems: 1, maxItems: 32 }) }),
    execute: async ({ texts }) => ({ ok: true, capability: 'embedding', modelId: embedding.modelId, ...(await embedOpenAiCompatible({ baseUrl: embedding.baseUrl, apiKey: embedding.apiKey, model: embedding.modelId }, texts)) }),
  }));

  const image = configFor(configs, 'image');
  if (image) tools.push(defineAgentTool({
    name: 'model_generate_image',
    description: 'Generate an image with the authorized image model and save it in the run workspace.',
    parameters: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 8_000 }), size: Type.Optional(Type.String({ maxLength: 40 })) }),
    execute: async ({ prompt, size }, { reportProgress }) => {
      const report: ProgressReporter = (summary, progress) => reportProgress({ summary, ...(progress !== undefined ? { progress } : {}) });
      const result = await generateImage(image, prompt, size, report);
      const downloaded = result.bytes
        ? { bytes: result.bytes, extension: 'png' }
        : await downloadGeneratedImage(result.url, report);
      report('正在保存图片到运行工作区…', 92);
      return {
        ok: true,
        capability: 'image',
        modelId: image.modelId,
        protocol: imageProtocol(image),
        path: await writeOutput(input.workspaceRoot, downloaded.extension, downloaded.bytes),
        deliverable: true,
        ...(result.taskId ? { taskId: result.taskId } : {}),
      };
    },
  }));

  const video = configFor(configs, 'video');
  if (video) tools.push(defineAgentTool({
    name: 'model_generate_video',
    description: 'Generate a short video with the authorized video model and save it in the run workspace. Video generation is asynchronous and may take several minutes.',
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 512 }),
      size: Type.Optional(Type.String({ maxLength: 40 })),
      duration: Type.Optional(Type.Union([Type.Literal(5), Type.Literal(10)])),
    }),
    execute: async ({ prompt, size, duration }, { reportProgress }) => {
      const report: ProgressReporter = (summary, progress) => reportProgress({ summary, ...(progress !== undefined ? { progress } : {}) });
      const generated = await generateVideo(video, prompt, size, duration, report);
      const bytes = await downloadGeneratedVideo(generated.url);
      report('正在保存视频到运行工作区…', 94);
      return { ok: true, capability: 'video', modelId: video.modelId, path: await writeOutput(input.workspaceRoot, 'mp4', bytes), mimeType: 'video/mp4', deliverable: true, taskId: generated.taskId };
    },
  }));

  const asr = configFor(configs, 'asr');
  let asrNetworkFailure: { ok: false; retryable: false; retryScope: 'current_run'; canRetryInNewRun: true; error: string; modelId: string; stage: string; attempts: number; endpoint: string; method: string } | undefined;
  if (asr) tools.push(defineAgentTool({
    name: 'model_transcribe_audio',
    description: 'Transcribe a recording using the authorized ASR model. Pass an uploaded audio-upload: reference or a run-workspace relative path as path. Alibaba also accepts HTTPS sourceUrl; local Alibaba audio is uploaded to temporary vendor storage. Use text or json output for vendor adapters. The transcript is saved as a deliverable. retryable=false with retryScope=current_run stops automatic retries ONLY in the current execution. A new user turn explicitly requesting transcription or retry may call this tool again, even in the same conversation. Historical failures are NOT current attempts. Do not bypass a current-run block via paths/formats or Bash. File size alone does not prove the audio codec or contents are valid.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      sourceUrl: Type.Optional(Type.String({ minLength: 8, maxLength: 2_000 })),
      language: Type.Optional(Type.String({ maxLength: 20 })),
      prompt: Type.Optional(Type.String({ maxLength: 2_000 })),
      outputFormat: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('text'), Type.Literal('srt'), Type.Literal('vtt')])),
      timestamps: Type.Optional(Type.Boolean()),
    }),
    execute: async ({ path: relative, sourceUrl, language, prompt, outputFormat, timestamps }, { signal, reportProgress }) => {
      if (asrNetworkFailure) return asrNetworkFailure;
      try {
      if (['qwen', 'volcengine', 'iflytek'].includes(asr.provider) && (outputFormat === 'srt' || outputFormat === 'vtt')) throw new Error('当前厂商适配支持 text/json 转写；暂不支持 SRT/VTT，请选择 text 或 json。');
      reportProgress({ summary: '正在校验并读取音频文件…', progress: 8 });
      if (relative?.startsWith('audio-upload:')) relative = await materializeAudioInput(relative, input.workspaceRoot);
      if (!relative && !sourceUrl) throw new Error('ASR requires either a workspace path or an HTTPS sourceUrl.');
      if (sourceUrl && !/^https:\/\//i.test(sourceUrl)) throw new Error('ASR sourceUrl must use HTTPS.');
      const local = relative ? await readableAudioFile(input.workspaceRoot, relative) : null;
      const bytes = local ? await readFile(local.target) : new Uint8Array();
      const providerReport: ProgressReporter = (summary, progress) => reportProgress({ summary, ...(progress !== undefined ? { progress } : {}) });
      let vendorResult: { text: string; segments?: unknown[]; raw?: unknown; taskId?: string } | null = null;
      if (asr.provider === 'qwen') {
        if (!sourceUrl && local) sourceUrl = await uploadDashScopeAudio({ config: asr, bytes, extension: path.extname(local.target), signal, report: providerReport });
        if (!sourceUrl) throw new Error('DashScope ASR requires an audio upload, workspace path or HTTPS URL.');
        vendorResult = await transcribeDashScope({ config: asr, sourceUrl, language, signal, report: providerReport });
      } else if (asr.provider === 'volcengine') {
        if (!local) throw new Error('Volcengine ASR currently requires a workspace audio path.');
        vendorResult = await transcribeVolcengine({ config: asr, bytes, signal, report: providerReport });
      } else if (asr.provider === 'iflytek') {
        if (!local) throw new Error('iFlytek ASR currently requires a workspace audio path.');
        vendorResult = await transcribeIflytek({ config: asr, bytes, fileName: path.basename(relative || local.target), language, signal, report: providerReport });
      }
      const form = new FormData();
      const format = outputFormat || 'json';
      let raw = '';
      let data: any = null;
      if (vendorResult) {
        data = { text: vendorResult.text, segments: vendorResult.segments ?? [], providerResult: vendorResult.raw, ...(vendorResult.taskId ? { taskId: vendorResult.taskId } : {}) };
        raw = format === 'json' || timestamps ? JSON.stringify(data) : vendorResult.text;
      } else {
        if (!local) throw new Error('OpenAI-compatible ASR requires a workspace audio path.');
        form.set('model', asr.modelId);
        form.set('file', new Blob([bytes]), path.basename(relative || local.target));
        if (language) form.set('language', language);
        if (prompt) form.set('prompt', prompt);
        form.set('response_format', timestamps ? 'verbose_json' : format);
        if (timestamps) form.append('timestamp_granularities[]', 'segment');
        reportProgress({ summary: '正在转写音频…', progress: 25 });
        const url = endpoint(asr.baseUrl, '/audio/transcriptions');
        const response = await providerFetch(url, { method: 'POST', headers: asr.apiKey ? { Authorization: `Bearer ${asr.apiKey}` } : {}, body: form }, signal, 300_000, 'ASR provider');
        raw = await response.text();
        if (!response.ok) {
          let detail = raw.slice(0, 500) || 'empty response';
          try { detail = String(JSON.parse(raw)?.error?.message || JSON.parse(raw)?.message || detail); } catch { /* keep text */ }
          throw new Error(`ASR provider request failed: HTTP ${response.status} POST ${url} — ${detail}`);
        }
        if (format === 'json' || timestamps) {
          try { data = JSON.parse(raw); } catch { throw new Error('ASR provider returned invalid JSON.'); }
        }
      }
      const text = String(data?.text ?? raw).trim();
      if (!text) throw new Error('ASR provider returned an empty transcript.');
      const extension = timestamps || format === 'json' ? 'json' : format === 'text' ? 'txt' : format;
      const stored = extension === 'json' ? JSON.stringify(data ?? { text }, null, 2) : text;
      reportProgress({ summary: '转写完成，正在保存结果…', progress: 90 });
      const transcriptPath = await writeOutput(input.workspaceRoot, extension, Buffer.from(stored, 'utf8'));
      return {
        ok: true, capability: 'asr', modelId: asr.modelId, text,
        ...(Array.isArray(data?.segments) ? { segments: data.segments } : {}),
        path: transcriptPath, format: extension, deliverable: true,
      };
      } catch (error) {
        if (error instanceof SpeechNetworkError) {
          const stage = error.stage ?? (error.method === 'GET' ? 'poll_or_download' : 'task_submit');
          const summary = `${error.message} ${stage === 'upload' || stage === 'upload_policy' ? '尚未提交转写任务。' : ''}仅停止本次运行内自动重试；用户下一条消息明确要求转写或重试时可重新调用，无需新建会话。历史错误不代表新一轮已尝试。本错误不能证明音频内容/编码正常或厂商服务宕机。`;
          const stageLabel = stage === 'upload' ? '上传录音' : stage === 'upload_policy' ? '获取上传凭证' : stage === 'task_submit' ? '提交转写任务' : '查询任务或下载结果';
          reportProgress({ summary: `${stageLabel}失败 · 阶段尝试${error.attempts}次；本次运行已停止，用户可在新一轮重试。` });
          asrNetworkFailure = { ok: false, retryable: false, retryScope: 'current_run', canRetryInNewRun: true, error: summary, modelId: asr.modelId, stage, attempts: error.attempts, endpoint: error.endpoint, method: error.method };
          return asrNetworkFailure;
        }
        throw error;
      }
    },
  }));

  const tts = configFor(configs, 'tts');
  const defaultVoice = tts?.voice?.trim() || (tts ? suggestedSpeechVoices(tts.provider, tts.modelId)[0] : undefined)
    || (tts && !['qwen', 'volcengine'].includes(tts.provider) ? 'alloy' : '');
  let ttsBlocked: { ok: false; error: string; retryable: false; modelId: string; voice: string; status: number; requestId?: string } | undefined;
  if (tts) tools.push(defineAgentTool({
    name: 'model_synthesize_speech',
    description: `Synthesize non-realtime speech and save audio in the run workspace. Model: ${tts.modelId}. Default voice: ${defaultVoice || 'not configured'}. Omit voice unless the user requests a specific compatible voice ID. Never guess OpenAI or other model voices. If retryable=false, stop TTS calls for this run and report the configuration error; do not claim a service outage.`,
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 12_000 }),
      voice: Type.Optional(Type.String({ maxLength: 240, description: 'Optional compatible voice ID. Omit to use the model-specific configured default.' })),
      format: Type.Optional(Type.Union([Type.Literal('mp3'), Type.Literal('wav'), Type.Literal('aac'), Type.Literal('flac'), Type.Literal('opus'), Type.Literal('pcm')])),
      speed: Type.Optional(Type.Number({ minimum: 0.25, maximum: 4 })),
    }),
    execute: async ({ text, voice, format, speed }, { signal, reportProgress }) => {
      if (ttsBlocked) return { ...ttsBlocked, error: `${ttsBlocked.error} 本次运行已停止 TTS 请求，请先修正模型/音色配置后新建一轮重试。` };
      const extension = format || 'mp3';
      const url = endpoint(tts.baseUrl, '/audio/speech');
      reportProgress({ summary: '正在提交语音合成请求…', progress: 10 });
      const selectedVoice = voice?.trim() || defaultVoice;
      if (!selectedVoice) return { ok: false, retryable: false, modelId: tts.modelId, error: '请在此 TTS 模型中配置兼容的默认音色 ID，当前模型没有已确认的默认音色。' };
      try {
      let bytes: Uint8Array;
      let contentType = '';
      if (tts.provider === 'qwen' || tts.provider === 'volcengine' || tts.provider === 'iflytek') {
        const result = tts.provider === 'qwen'
          ? await synthesizeDashScope({ config: tts, text, voice: selectedVoice, format: extension, speed, signal, report: (summary, progress) => reportProgress({ summary, progress }) })
          : tts.provider === 'volcengine'
            ? await synthesizeVolcengine({ config: tts, text, voice: selectedVoice, format: extension, speed, signal, report: (summary, progress) => reportProgress({ summary, progress }) })
            : await synthesizeIflytek({ config: tts, text, voice: selectedVoice, format: extension, speed, signal, report: (summary, progress) => reportProgress({ summary, progress }) });
        bytes = result.bytes;
        contentType = result.contentType;
      } else {
        const response = await providerFetch(url, { method: 'POST', headers: headers(tts), body: JSON.stringify({ model: tts.modelId, input: text, voice: selectedVoice, response_format: extension, ...(speed ? { speed } : {}) }) }, signal, 300_000, 'TTS provider');
        if (!response.ok) throw new Error(`TTS provider request failed: HTTP ${response.status} POST ${url} — ${(await response.text()).slice(0, 500) || 'empty response'}`);
        const declaredSize = Number(response.headers.get('content-length') || 0);
        if (declaredSize > MAX_AUDIO_OUTPUT_BYTES) throw new Error('TTS output exceeds the 25 MB limit.');
        contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
        bytes = new Uint8Array(await response.arrayBuffer());
      }
      if (contentType && !contentType.startsWith('audio/') && contentType !== 'application/octet-stream') throw new Error(`TTS provider returned unsupported content type: ${contentType}.`);
      if (!bytes.byteLength) throw new Error('TTS provider returned an empty audio file.');
      if (bytes.byteLength > MAX_AUDIO_OUTPUT_BYTES) throw new Error('TTS output exceeds the 25 MB limit.');
      reportProgress({ summary: '语音合成完成，正在保存到运行工作区…', progress: 90 });
      return { ok: true, capability: 'tts', modelId: tts.modelId, path: await writeOutput(input.workspaceRoot, extension, bytes), mimeType: contentType || audioMime(extension), format: extension, bytes: bytes.byteLength, deliverable: true };
      } catch (error) {
        if (error instanceof SpeechProviderHttpError && !error.retryable) {
          ttsBlocked = { ok: false, retryable: false, modelId: tts.modelId, voice: selectedVoice, status: error.status, requestId: error.requestId,
            error: `${error.message} [model=${tts.modelId}, voice=${selectedVoice}] 请检查模型对应的音色、参数与访问权限；411 请优先核对模型与音色匹配，不能据此判断服务暂时不可用。停止更换文本/音色进行盲目重试。` };
          return ttsBlocked;
        }
        throw error;
      }
    },
  }));
  return tools;
}

/** One engine-neutral application-model backend session for this run. */
export function createModelCapabilityToolSession(input: { configs?: ModelCapabilityRuntime[]; workspaceRoot: string; visionContext?: VisionToolContext }): UnifiedToolSession {
  const tools = createModelCapabilityTools(input);
  return createUnifiedToolSession(registrationsFromTools(tools, {
    category: 'model-capability',
    capabilities: MODEL_CAPABILITY_BY_TOOL,
  }));
}
