import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelCapabilityRuntime } from '@openclawx/contracts';
import { speechFetch as fetch, SpeechNetworkError } from './speech-http.js';

type Report = (summary: string, progress?: number) => void;

type MultipartUploadInput = { url: URL; fields: Record<string, string>; bytes: Uint8Array; fileName: string; signal: AbortSignal };

function multipartToken(value: string) {
  return value.replace(/[\r\n]/g, '').replace(/["\\]/g, '\\$&');
}

/** Compatibility transport for OSS hosts on which Node fetch/undici resets TLS.
 * It is used only for temporary object upload, never for paid ASR submission. */
async function uploadMultipartWithNode(input: MultipartUploadInput): Promise<Response> {
  const boundary = `----openclawx-${crypto.randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(input.fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${multipartToken(name)}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${multipartToken(input.fileName)}"\r\nContent-Type: application/octet-stream\r\n\r\n`, 'utf8'));
  parts.push(Buffer.from(input.bytes));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  const body = Buffer.concat(parts);
  const endpoint = `${input.url.origin}${input.url.pathname}`;
  return new Promise<Response>((resolve, reject) => {
    const transport = input.url.protocol === 'https:' ? https : http;
    const request = transport.request(input.url, { method: 'POST', signal: input.signal, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.byteLength) } }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > 1024 * 1024) response.destroy(new Error('DashScope upload response exceeds 1 MB.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode || 500, headers }));
      });
    });
    request.on('error', (error) => reject(new SpeechNetworkError(`语音兼容上传失败：POST ${endpoint} [${String((error as NodeJS.ErrnoException).code || error.name)}]`, 'POST', endpoint, 'upload', 3)));
    request.end(body);
  });
}

export class SpeechProviderHttpError extends Error {
  constructor(message: string, readonly status: number, readonly requestId?: string) { super(message); }
  get retryable() { return this.status === 408 || this.status === 429 || this.status >= 500; }
}

function root(baseUrl: string) {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}`;
}

async function checkedJson(response: Response, label: string) {
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!response.ok) throw new SpeechProviderHttpError(`${label}: HTTP ${response.status} ${new URL(response.url).origin}${new URL(response.url).pathname} — ${String(data?.message || data?.error?.message || text || 'empty response').slice(0, 500)}`, response.status, data?.request_id);
  if (!data) throw new Error(`${label} returned invalid JSON.`);
  return data;
}

async function downloadAudio(urlValue: string, signal?: AbortSignal) {
  const url = new URL(urlValue);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Speech provider returned a non-HTTP audio URL.');
  const response = await fetch(url, { signal, redirect: 'follow' });
  if (!response.ok) throw new Error(`Speech audio download failed: HTTP ${response.status}.`);
  return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') || '' };
}

export async function synthesizeDashScope(input: { config: ModelCapabilityRuntime; text: string; voice: string; format: string; speed?: number; signal?: AbortSignal; report: Report }) {
  const { config } = input;
  const nativeRoot = root(config.baseUrl);
  const url = `${nativeRoot}/api/v1/services/audio/tts/SpeechSynthesizer`;
  input.report('正在调用百炼非实时语音合成…', 20);
  const response = await fetch(url, {
    method: 'POST', signal: input.signal,
    headers: { Authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.modelId, input: { text: input.text, voice: input.voice, format: input.format, sample_rate: 24_000, ...(input.speed ? { rate: input.speed } : {}) } }),
  });
  const data = await checkedJson(response, 'DashScope TTS request failed');
  const audioUrl = String(data?.output?.audio?.url || data?.output?.url || data?.url || '');
  if (!audioUrl) throw new Error('DashScope TTS returned no audio URL.');
  input.report('合成完成，正在下载临时音频…', 80);
  return downloadAudio(audioUrl, input.signal);
}

export async function transcribeDashScope(input: { config: ModelCapabilityRuntime; sourceUrl: string; language?: string; signal?: AbortSignal; report: Report }) {
  input = { ...input, signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000) };
  const base = root(input.config.baseUrl);
  const submitUrl = `${base}/api/v1/services/audio/asr/transcription`;
  input.report('正在提交百炼录音文件识别任务…', 10);
  const submitted = await checkedJson(await fetch(submitUrl, {
    method: 'POST', signal: input.signal,
    headers: { Authorization: `Bearer ${input.config.apiKey}`, 'content-type': 'application/json', 'X-DashScope-Async': 'enable', ...(input.sourceUrl.startsWith('oss://') ? { 'X-DashScope-OssResourceResolve': 'enable' } : {}) },
    body: JSON.stringify({ model: input.config.modelId, input: { file_urls: [input.sourceUrl] }, parameters: { ...(input.language ? { language_hints: [input.language] } : {}) } }),
  }), 'DashScope ASR submit failed');
  const taskId = String(submitted?.output?.task_id || '');
  if (!taskId) throw new Error('DashScope ASR returned no task_id.');
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const task = await checkedJson(await fetch(`${base}/api/v1/tasks/${encodeURIComponent(taskId)}`, { signal: input.signal, headers: { Authorization: `Bearer ${input.config.apiKey}` } }), 'DashScope ASR query failed');
    const status = String(task?.output?.task_status || '').toUpperCase();
    if (status === 'SUCCEEDED') {
      const row = task?.output?.results?.[0] || {};
      if (row.subtask_status && row.subtask_status !== 'SUCCEEDED') throw new Error(`DashScope ASR subtask failed: ${String(row.message || row.subtask_status)}`);
      const resultUrl = String(row.transcription_url || row.result_url || '');
      if (!resultUrl) throw new Error('DashScope ASR completed without a transcription URL.');
      const result = await checkedJson(await fetch(resultUrl, { signal: input.signal }), 'DashScope ASR result download failed');
      const text = String(result?.transcripts?.map((item: any) => item?.text || '').join('\n') || result?.text || '').trim();
      if (!text) throw new Error('DashScope ASR returned an empty transcript.');
      return { text, segments: result?.transcripts ?? [], raw: result, taskId };
    }
    if (status === 'FAILED' || status === 'CANCELED') throw new Error(`DashScope ASR task ${taskId} ${status.toLowerCase()}: ${String(task?.output?.message || 'unknown error')}`);
    input.report(`百炼正在转写（${status || '排队中'}）…`, 35);
    await delay(2_000, undefined, { signal: input.signal });
  }
  throw new Error(`DashScope ASR task ${taskId} timed out.`);
}

export async function uploadDashScopeAudio(input: { config: ModelCapabilityRuntime; bytes: Uint8Array; extension: string; signal?: AbortSignal; report: Report; compatUpload?: (value: MultipartUploadInput) => Promise<Response> }) {
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  const base = new URL(input.config.baseUrl);
  // Temporary-upload policies use the shared API host, not a workspace inference host.
  if (base.hostname.endsWith('.cn-beijing.maas.aliyuncs.com')) base.hostname = 'dashscope.aliyuncs.com';
  if (base.hostname.endsWith('.ap-southeast-1.maas.aliyuncs.com')) base.hostname = 'dashscope-intl.aliyuncs.com';
  const policyUrl = `${base.origin}/api/v1/uploads?${new URLSearchParams({ action: 'getPolicy', model: input.config.modelId })}`;
  input.report('正在获取阿里临时录音上传凭证（桌面试用）…', 10);
  let policy: any;
  try {
    policy = (await checkedJson(await fetch(policyUrl, { signal, headers: { Authorization: `Bearer ${input.config.apiKey}` } }), 'DashScope upload policy failed')).data;
  } catch (error) {
    if (error instanceof SpeechNetworkError) throw new SpeechNetworkError(error.message, error.method, error.endpoint, 'upload_policy');
    throw error;
  }
  const uploadUrl = new URL(String(policy?.upload_host || ''));
  if (uploadUrl.protocol !== 'https:' && !(uploadUrl.protocol === 'http:' && uploadUrl.origin === base.origin && ['127.0.0.1', 'localhost'].includes(uploadUrl.hostname))) throw new Error('Invalid DashScope upload host.');
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal.throwIfAborted();
    // A lost response may leave an object behind. A fresh key avoids forbidden
    // overwrite conflicts; neither upload attempt submits a paid ASR task.
    const fileName = `${crypto.randomUUID()}${input.extension}`;
    const key = `${policy.upload_dir}/${fileName}`;
    const fields: Record<string, string> = {};
    for (const [name, value] of Object.entries({ OSSAccessKeyId: policy.oss_access_key_id, Signature: policy.signature, policy: policy.policy, 'x-oss-object-acl': policy.x_oss_object_acl, 'x-oss-forbid-overwrite': policy.x_oss_forbid_overwrite, key, success_action_status: '200' })) {
      if (value === undefined) throw new Error('DashScope returned an incomplete upload policy.');
      fields[name] = String(value);
    }
    input.report(attempt === maxAttempts ? `默认连接连续中断，正在使用兼容通道上传录音（第${attempt}/${maxAttempts}次）；尚未提交转写…` : `正在上传录音到阿里临时存储（第${attempt}/${maxAttempts}次），尚未提交转写…`, 18);
    let response: Response;
    try {
      if (attempt === maxAttempts) response = await (input.compatUpload ?? uploadMultipartWithNode)({ url: uploadUrl, fields, bytes: input.bytes, fileName, signal });
      else {
        const form = new FormData();
        for (const [name, value] of Object.entries(fields)) form.set(name, value);
        form.set('file', new Blob([Buffer.from(input.bytes)]), fileName);
        response = await fetch(uploadUrl, { method: 'POST', body: form, signal });
      }
    } catch (error) {
      if (!(error instanceof SpeechNetworkError)) throw error;
      if (attempt === maxAttempts || signal.aborted) {
        input.report(`录音上传失败（已尝试${attempt}次），尚未提交转写。`, 18);
        throw new SpeechNetworkError(error.message, error.method, error.endpoint, 'upload', attempt);
      }
      input.report(attempt === 1 ? '录音上传连接异常，500ms后使用新临时对象重试；尚未提交转写。' : '默认上传通道再次中断，500ms后切换兼容通道；尚未提交转写。', 18);
      await delay(500, undefined, { signal });
      continue;
    }
    if (!response.ok) throw new Error(`DashScope audio upload failed: HTTP ${response.status}.`);
    return `oss://${key}`;
  }
  throw new Error('DashScope audio upload attempts exhausted.');
}

export async function transcribeVolcengine(input: { config: ModelCapabilityRuntime; bytes: Uint8Array; signal?: AbortSignal; report: Report }) {
  input = { ...input, signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000) };
  const url = `${root(input.config.baseUrl)}/api/v3/auc/bigmodel/recognize/flash`;
  const requestId = crypto.randomUUID();
  input.report('正在调用火山引擎录音文件识别…', 25);
  const response = await fetch(url, {
    method: 'POST', signal: input.signal,
    headers: {
      'content-type': 'application/json',
      'X-Api-Key': input.config.apiKey,
      'X-Api-Resource-Id': 'volc.bigasr.auc_turbo',
      'X-Api-Request-Id': requestId,
      'X-Api-Sequence': '-1',
    },
    body: JSON.stringify({ user: { uid: input.config.appId || 'openclawx' }, audio: { data: Buffer.from(input.bytes).toString('base64') }, request: { model_name: 'bigmodel' } }),
  });
  const data = await checkedJson(response, 'Volcengine ASR request failed');
  const status = response.headers.get('x-api-status-code');
  if (status && status !== '20000000') throw new Error(`Volcengine ASR failed: ${status} ${response.headers.get('x-api-message') || ''}`.trim());
  const text = String(data?.result?.text || '').trim();
  if (!text) throw new Error('Volcengine ASR returned an empty transcript.');
  return { text, segments: data?.result?.utterances ?? [], raw: data };
}

function iflytekSignature(appId: string, secret: string, ts: string) {
  const md5 = createHash('md5').update(`${appId}${ts}`).digest('hex');
  return createHmac('sha1', secret).update(md5).digest('base64');
}

function iflytekWords(orderResult: string) {
  const parsed = JSON.parse(orderResult || '{}');
  return (parsed.lattice || []).map((row: any) => {
    const one = typeof row.json_1best === 'string' ? JSON.parse(row.json_1best) : row.json_1best;
    return one?.st?.rt?.flatMap((rt: any) => rt?.ws ?? []).flatMap((ws: any) => ws?.cw ?? []).map((cw: any) => cw?.w || '').join('') || '';
  }).join('');
}

export async function transcribeIflytek(input: { config: ModelCapabilityRuntime; bytes: Uint8Array; fileName: string; language?: string; signal?: AbortSignal; report: Report }) {
  input = { ...input, signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000) };
  const appId = input.config.appId || '';
  const secret = input.config.apiSecret || '';
  if (!appId || !secret) throw new Error('iFlytek ASR requires AppID and APISecret.');
  const ts = String(Math.floor(Date.now() / 1_000));
  const query = new URLSearchParams({ appId, ts, signa: iflytekSignature(appId, secret, ts), fileName: input.fileName, fileSize: String(input.bytes.byteLength), duration: '1', language: input.language?.startsWith('zh') ? 'cn' : input.language || 'cn' });
  input.report('正在上传音频到讯飞录音文件转写…', 15);
  const uploaded = await checkedJson(await fetch(`${root(input.config.baseUrl)}/v2/api/upload?${query}`, { method: 'POST', signal: input.signal, headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from(input.bytes) }), 'iFlytek ASR upload failed');
  if (uploaded.code !== '000000') throw new Error(`iFlytek ASR upload failed: ${uploaded.code} ${uploaded.descInfo || ''}`.trim());
  const orderId = String(uploaded?.content?.orderId || '');
  if (!orderId) throw new Error('iFlytek ASR upload returned no orderId.');
  const deadline = Date.now() + 600_000;
  for (let attempt = 0; attempt < 100 && Date.now() < deadline; attempt++) {
    const pollTs = String(Math.floor(Date.now() / 1_000));
    const poll = new URLSearchParams({ appId, ts: pollTs, signa: iflytekSignature(appId, secret, pollTs), orderId });
    const data = await checkedJson(await fetch(`${root(input.config.baseUrl)}/v2/api/getResult?${poll}`, { method: 'POST', signal: input.signal }), 'iFlytek ASR query failed');
    if (String(data.code) !== '000000') throw new Error(`iFlytek ASR query failed: ${String(data.code)} ${String(data.descInfo || '')}`);
    const status = Number(data?.content?.orderInfo?.status);
    if (status === 4) {
      const text = iflytekWords(String(data?.content?.orderResult || '')).trim();
      if (!text) throw new Error('iFlytek ASR completed with an empty transcript.');
      return { text, segments: [], raw: data, taskId: orderId };
    }
    if (status === -1) throw new Error(`iFlytek ASR task ${orderId} failed (type ${String(data?.content?.orderInfo?.failType ?? 'unknown')}).`);
    input.report(`讯飞正在转写（任务 ${orderId}）…`, 35);
    await delay(Math.min(2_000 + attempt * 500, 10_000), undefined, { signal: input.signal });
  }
  throw new Error(`iFlytek ASR task ${orderId} timed out.`);
}

export async function synthesizeVolcengine(input: { config: ModelCapabilityRuntime; text: string; voice: string; format: string; speed?: number; signal?: AbortSignal; report: Report }) {
  const url = `${root(input.config.baseUrl)}/api/v1/tts`;
  if (!input.config.appId) throw new Error('Volcengine TTS requires AppID.');
  input.report('正在调用火山引擎语音合成…', 20);
  const data = await checkedJson(await fetch(url, {
    method: 'POST', signal: input.signal,
    headers: { Authorization: `Bearer;${input.config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ app: { appid: input.config.appId, token: input.config.apiKey, cluster: 'volcano_tts' }, user: { uid: 'openclawx' }, audio: { voice_type: input.voice, encoding: input.format === 'opus' ? 'ogg_opus' : input.format, speed_ratio: input.speed || 1 }, request: { reqid: crypto.randomUUID(), text: input.text, text_type: 'plain', operation: 'query' } }),
  }), 'Volcengine TTS request failed');
  if (Number(data.code ?? 0) !== 3000 && Number(data.code ?? 0) !== 0) throw new Error(`Volcengine TTS failed: ${String(data.code)} ${String(data.message || '')}`.trim());
  const audio = String(data.data || data.audio || '');
  if (!audio) throw new Error('Volcengine TTS returned no audio data.');
  return { bytes: new Uint8Array(Buffer.from(audio, 'base64')), contentType: input.format === 'wav' ? 'audio/wav' : 'audio/mpeg' };
}

export function iflytekTtsUrl(apiKey: string, apiSecret: string, now = new Date()) {
  const host = 'tts-api.xfyun.cn';
  const path = '/v2/tts';
  const date = now.toUTCString();
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
  const signature = createHmac('sha256', apiSecret).update(signatureOrigin).digest('base64');
  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const query = new URLSearchParams({ authorization: Buffer.from(authorizationOrigin).toString('base64'), date, host });
  return `wss://${host}${path}?${query}`;
}

export async function synthesizeIflytek(input: { config: ModelCapabilityRuntime; text: string; voice: string; format: string; speed?: number; signal?: AbortSignal; report: Report }) {
  if (!input.config.appId || !input.config.apiSecret) throw new Error('iFlytek TTS requires AppID and APISecret.');
  if (Buffer.byteLength(input.text, 'utf8') >= 8_000) throw new Error('iFlytek TTS text must be shorter than 8000 UTF-8 bytes.');
  const { default: WebSocket } = await import('ws');
  const url = iflytekTtsUrl(input.config.apiKey, input.config.apiSecret);
  input.report('正在连接讯飞语音合成服务…', 15);
  return new Promise<{ bytes: Uint8Array; contentType: string }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const socket = new WebSocket(url);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.close();
      if (error) reject(error);
      else resolve({ bytes: new Uint8Array(Buffer.concat(chunks)), contentType: input.format === 'mp3' ? 'audio/mpeg' : input.format === 'opus' ? 'audio/ogg' : 'audio/pcm' });
    };
    const timer = setTimeout(() => finish(new Error('iFlytek TTS timed out.')), 300_000);
    const abort = () => finish(new Error('iFlytek TTS cancelled.'));
    input.signal?.addEventListener('abort', abort, { once: true });
    socket.on('open', () => {
      input.report('讯飞正在合成语音…', 30);
      socket.send(JSON.stringify({
        common: { app_id: input.config.appId },
        business: { aue: input.format === 'mp3' ? 'lame' : input.format === 'opus' ? 'opus-wb' : 'raw', ...(input.format === 'mp3' ? { sfl: 1 } : {}), auf: 'audio/L16;rate=16000', vcn: input.voice, speed: Math.max(0, Math.min(100, Math.round(50 * (input.speed || 1)))), tte: 'UTF8' },
        data: { status: 2, text: Buffer.from(input.text, 'utf8').toString('base64') },
      }));
    });
    socket.on('message', (raw, isBinary) => {
      if (isBinary) { chunks.push(Buffer.from(raw as any)); return; }
      try {
        const data = JSON.parse(raw.toString());
        if (Number(data.code || 0) !== 0) return finish(new Error(`iFlytek TTS failed: ${String(data.code)} ${String(data.message || '')}`.trim()));
        if (data?.data?.audio) chunks.push(Buffer.from(String(data.data.audio), 'base64'));
        if (Number(data?.data?.status) === 2) {
          clearTimeout(timer);
          input.signal?.removeEventListener('abort', abort);
          if (!chunks.length) return finish(new Error('iFlytek TTS returned empty audio.'));
          finish();
        }
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.on('error', (error) => finish(new Error(`iFlytek TTS WebSocket failed: ${error.message}`)));
  });
}
