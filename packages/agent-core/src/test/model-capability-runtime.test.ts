import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveProviderBaseUrl, suggestedSpeechVoices } from '@openclawx/contracts';
import type { ModelCapabilityRuntime } from '@openclawx/contracts';
import { createModelCapabilityTools } from '../model-capability-runtime.js';
import { iflytekTtsUrl } from '../speech-provider-adapters.js';
import { transcribeDashScope, transcribeIflytek } from '../speech-provider-adapters.js';

test('free CogView submits native parameters and saves the returned image URL', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-cogview-'));
  let submitted: unknown;
  let baseUrl = '';
  const server = createServer(async (request, response) => {
    if (request.url === '/images/generations') {
      let body = ''; for await (const chunk of request) body += chunk.toString();
      submitted = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ url: `${baseUrl}/image.png` }] }));
    } else if (request.url === '/image.png') {
      assert.equal(request.headers.authorization, undefined, 'download must not leak the model key');
      response.setHeader('content-type', 'image/png');
      response.end(Buffer.from('png'));
    } else { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const [tool] = createModelCapabilityTools({ workspaceRoot, configs: [{
      id: 'free-image', capability: 'image', provider: 'glm', baseUrl,
      apiKey: 'test-key', modelId: 'cogview-3-flash', mode: 'auto', imageProtocol: 'openai-images',
    }] });
    const result = (await tool.execute('cogview', { prompt: '海边日落' }, undefined)).details as any;
    assert.equal(result.ok, true);
    assert.deepEqual(submitted, { model: 'cogview-3-flash', prompt: '海边日落', size: '1024x1024' });
    assert.equal((await readFile(path.join(workspaceRoot, result.path))).toString(), 'png');
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections(); await closed;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('free CogVideoX submits an async task, polls it and saves the MP4 result', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-cogvideo-'));
  let submitted: unknown;
  let baseUrl = '';
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/videos/generations') {
      let body = ''; for await (const chunk of request) body += chunk.toString();
      submitted = JSON.parse(body);
      response.end(JSON.stringify({ id: 'video-task' }));
    } else if (request.url === '/async-result/video-task') {
      response.end(JSON.stringify({ task_status: 'SUCCESS', video_result: [{ url: `${baseUrl}/result.mp4` }] }));
    } else if (request.url === '/result.mp4') {
      assert.equal(request.headers.authorization, undefined, 'download must not leak the model key');
      response.setHeader('content-type', 'video/mp4');
      response.end(Buffer.from('0000ftypisom-video'));
    } else { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const [tool] = createModelCapabilityTools({ workspaceRoot, configs: [{
      id: 'free-video', capability: 'video', provider: 'glm', baseUrl,
      apiKey: 'test-key', modelId: 'cogvideox-flash', mode: 'auto',
    }] });
    const result = (await tool.execute('cogvideo', { prompt: '海边日落', size: '1920x1080' }, undefined)).details as any;
    assert.equal(result.ok, true);
    assert.deepEqual(submitted, { model: 'cogvideox-flash', prompt: '海边日落', size: '1920x1080' });
    assert.equal(result.mimeType, 'video/mp4');
    assert.equal((await readFile(path.join(workspaceRoot, result.path))).toString(), '0000ftypisom-video');
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections(); await closed;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Volcengine realtime models expose curated popular voices while preserving custom IDs', () => {
  assert.deepEqual(suggestedSpeechVoices('volcengine', '1.2.6.1'), [
    'zh_female_vv_jupiter_bigtts',
    'zh_female_xiaohe_jupiter_bigtts',
    'zh_male_yunzhou_jupiter_bigtts',
    'zh_male_xiaotian_jupiter_bigtts',
    'saturn_zh_female_aojiaonvyou_tob',
  ]);
});

test('Qwen realtime models expose model-specific voices', () => {
  assert.deepEqual(suggestedSpeechVoices('qwen', 'qwen-audio-3.1-realtime-plus').slice(0, 2), ['longanqian_v3.1', 'longanhuan_v3.1']);
  assert.deepEqual(suggestedSpeechVoices('qwen', 'qwen3.8-omni-flash-realtime'), ['Tina']);
});

test('local Alibaba ASR uploads temporary audio, resolves OSS and saves a text deliverable', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-local-asr-'));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(path.join(workspaceRoot, 'meeting.mp3'), 'audio'));
  const hits: string[] = [];
  let submitted: any;
  let resolveHeader: string | undefined;
  let uploaded = '';
  let baseUrl = '';
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost'); hits.push(url.pathname);
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/v1/uploads') {
      assert.equal(url.searchParams.get('model'), 'paraformer-v2');
      response.end(JSON.stringify({ data: { upload_host: `${baseUrl}/oss`, upload_dir: 'tmp', oss_access_key_id: 'oss-key', signature: 'signature', policy: 'policy', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true' } }));
    } else if (url.pathname === '/oss') {
      for await (const chunk of request) uploaded += chunk.toString();
      assert.equal(request.headers.authorization, undefined);
      response.end('{}');
    } else if (url.pathname.endsWith('/transcription')) {
      let body = ''; for await (const chunk of request) body += chunk.toString();
      submitted = JSON.parse(body);
      resolveHeader = request.headers['x-dashscope-ossresourceresolve'] as string;
      response.end(JSON.stringify({ output: { task_id: 'asr-task' } }));
    } else if (url.pathname === '/api/v1/tasks/asr-task') {
      response.end(JSON.stringify({ output: { task_status: 'SUCCEEDED', results: [{ subtask_status: 'SUCCEEDED', transcription_url: `${baseUrl}/transcript` }] } }));
    } else response.end(JSON.stringify({ transcripts: [{ text: '会议转写成功。' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const [tool] = createModelCapabilityTools({ workspaceRoot, configs: [{ id: 'asr', capability: 'asr', provider: 'qwen', baseUrl, apiKey: 'key', modelId: 'paraformer-v2', mode: 'auto' }] });
    const result = (await tool.execute('local', { path: 'meeting.mp3', outputFormat: 'text' }, undefined)).details as any;
    assert.equal(result.ok, true);
    assert.match(submitted.input.file_urls[0], /^oss:\/\/tmp\//);
    assert.equal(resolveHeader, 'enable');
    assert.match(uploaded, /audio/);
    assert.equal((await readFile(path.join(workspaceRoot, result.path))).toString(), '会议转写成功。');
    assert.deepEqual(hits, ['/api/v1/uploads', '/oss', '/api/v1/services/audio/asr/transcription', '/api/v1/tasks/asr-task', '/transcript']);
    const subtitle = (await tool.execute('subtitle', { path: 'meeting.mp3', outputFormat: 'srt' }, undefined)).details as any;
    assert.equal(subtitle.ok, false);
    assert.equal(hits.length, 5);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('ASR polling stops on cancellation and iFlytek business errors', async () => {
  let mode = 'qwen';
  let polls = 0;
  const controller = new AbortController();
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (mode === 'qwen') {
      if (request.url?.includes('/tasks/')) { polls++; response.end(JSON.stringify({ output: { task_status: 'RUNNING' } })); }
      else response.end(JSON.stringify({ output: { task_id: 'task' } }));
    } else if (request.url?.includes('/upload')) response.end(JSON.stringify({ code: '000000', content: { orderId: 'task' } }));
    else { polls++; response.end(JSON.stringify({ code: 'AUTH_FAILED', descInfo: 'invalid credential' })); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const config: ModelCapabilityRuntime = { id: 'asr', capability: 'asr', provider: 'qwen', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'key', appId: 'app', apiSecret: 'secret', modelId: 'paraformer-v2', mode: 'auto' };
  try {
    await assert.rejects(transcribeDashScope({ config, sourceUrl: 'https://example.com/audio.mp3', signal: controller.signal, report: (message) => { if (message.includes('正在转写')) controller.abort(); } }), /abort/i);
    assert.equal(polls, 1);
    mode = 'iflytek'; polls = 0;
    await assert.rejects(transcribeIflytek({ config, bytes: Buffer.from('audio'), fileName: 'audio.mp3', report: () => undefined }), /AUTH_FAILED/);
    assert.equal(polls, 1);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed;
  }
});

test('iFlytek TTS builds an HMAC-SHA256 signed WebSocket URL', () => {
  const url = new URL(iflytekTtsUrl('api-key', 'api-secret', new Date('2026-09-24T00:00:00Z')));
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.pathname, '/v2/tts');
  assert.equal(url.searchParams.get('host'), 'tts-api.xfyun.cn');
  const authorization = Buffer.from(String(url.searchParams.get('authorization')), 'base64').toString();
  assert.match(authorization, /api_key="api-key"/);
  assert.match(authorization, /algorithm="hmac-sha256"/);
  assert.match(authorization, /headers="host date request-line"/);
});

test('Bailian workspace uses the region implied by the shared host and preserves custom hosts', () => {
  assert.equal(
    resolveProviderBaseUrl({ provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', workspaceId: 'llm-demo' }),
    'https://llm-demo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  );
  assert.equal(
    resolveProviderBaseUrl({ provider: 'qwen', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', workspaceId: 'llm-demo' }),
    'https://llm-demo.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  );
  assert.equal(
    resolveProviderBaseUrl({ provider: 'qwen', baseUrl: 'https://gateway.example.com/v1', workspaceId: 'llm-demo' }),
    'https://gateway.example.com/v1',
  );
});

test('authorized model capabilities expose typed tools and invoke distinct provider endpoints', async () => {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url || '');
    if (request.url === '/embeddings') response.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }], model: 'embed' }));
    else if (request.url === '/chat/completions') response.end(JSON.stringify({ choices: [{ message: { content: 'print("bell")' } }], usage: { total_tokens: 12 } }));
    else if (request.url === '/images/generations') response.end(JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }));
    else if (request.url === '/audio/transcriptions') response.end(JSON.stringify({ text: 'hello' }));
    else if (request.url === '/audio/speech') { response.setHeader('content-type', 'audio/mpeg'); response.end(Buffer.from('mp3')); }
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-capability-'));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(path.join(workspaceRoot, 'sample.wav'), 'audio'));
  const capabilities: ModelCapabilityRuntime['capability'][] = ['quantum-code', 'embedding', 'image', 'asr', 'tts'];
  const configs: ModelCapabilityRuntime[] = capabilities.map((capability) => ({ id: capability, capability, provider: 'openai-compatible', baseUrl, apiKey: '', modelId: capability, mode: 'auto' }));
  try {
    const tools = createModelCapabilityTools({ configs, workspaceRoot });
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['model_embed_text', 'model_generate_image', 'model_synthesize_speech', 'model_transcribe_audio', 'quantum_code_generate']);
    const call = async (name: string, params: object) => {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool);
      return (await tool.execute('test', params, undefined)).details as any;
    };
    assert.match((await call('quantum_code_generate', { task: 'Bell state' })).content, /bell/);
    assert.deepEqual((await call('model_embed_text', { texts: ['hello'] })).vectors, [[0.1, 0.2]]);
    const image = await call('model_generate_image', { prompt: 'circuit' });
    assert.equal((await readFile(path.join(workspaceRoot, image.path))).toString(), 'png');
    const transcript = await call('model_transcribe_audio', { path: 'sample.wav' });
    assert.equal(transcript.text, 'hello');
    assert.equal(transcript.deliverable, true);
    assert.deepEqual(JSON.parse((await readFile(path.join(workspaceRoot, transcript.path))).toString()), { text: 'hello' });
    const speech = await call('model_synthesize_speech', { text: 'hello' });
    assert.equal((await readFile(path.join(workspaceRoot, speech.path))).toString(), 'mp3');
    assert.deepEqual(hits.sort(), ['/audio/speech', '/audio/transcriptions', '/chat/completions', '/embeddings', '/images/generations']);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('non-realtime ASR validates workspace audio and preserves provider diagnostics', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-asr-'));
  await import('node:fs/promises').then(({ writeFile }) => Promise.all([
    writeFile(path.join(workspaceRoot, 'notes.txt'), 'not audio'),
    writeFile(path.join(workspaceRoot, 'sample.wav'), 'audio'),
  ]));
  const server = createServer((_request, response) => {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: { message: 'unsupported codec' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const [tool] = createModelCapabilityTools({
      workspaceRoot,
      configs: [{ id: 'asr', capability: 'asr', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: '', modelId: 'asr', mode: 'auto' }],
    });
    const invalid = (await tool.execute('invalid', { path: 'notes.txt' }, undefined)).details as any;
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /Unsupported ASR audio format/);
    const failed = (await tool.execute('failed', { path: 'sample.wav' }, undefined)).details as any;
    assert.equal(failed.ok, false);
    assert.match(failed.error, /HTTP 400 POST .*\/audio\/transcriptions.*unsupported codec/);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('non-realtime TTS supports output format and rejects non-audio responses', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-tts-'));
  let valid = true;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', valid ? 'audio/wav' : 'application/json');
    response.end(valid ? Buffer.from('wave') : JSON.stringify({ error: 'wrong route' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const [tool] = createModelCapabilityTools({
      workspaceRoot,
      configs: [{ id: 'tts', capability: 'tts', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: '', modelId: 'tts', mode: 'auto' }],
    });
    const speech = (await tool.execute('valid', { text: 'hello', format: 'wav', speed: 1.1 }, undefined)).details as any;
    assert.equal(speech.format, 'wav');
    assert.equal(speech.mimeType, 'audio/wav');
    assert.equal((await readFile(path.join(workspaceRoot, speech.path))).toString(), 'wave');
    valid = false;
    const failed = (await tool.execute('invalid', { text: 'hello' }, undefined)).details as any;
    assert.equal(failed.ok, false);
    assert.match(failed.error, /unsupported content type: application\/json/);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('DashScope non-realtime TTS downloads the generated audio URL and accepts a voice id', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-qwen-tts-'));
  let baseUrl = '';
  let requestBody: any;
  const server = createServer(async (request, response) => {
    if (request.url === '/api/v1/services/audio/tts/SpeechSynthesizer') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBody = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ output: { audio: { url: `${baseUrl}/audio.wav` } } }));
      return;
    }
    if (request.url === '/audio.wav') {
      response.setHeader('content-type', 'audio/wav');
      response.end(Buffer.from('wave'));
      return;
    }
    response.statusCode = 404; response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const [tool] = createModelCapabilityTools({ workspaceRoot, configs: [{ id: 'tts', capability: 'tts', provider: 'qwen', baseUrl: `${baseUrl}/compatible-mode/v1`, apiKey: 'key', modelId: 'cosyvoice-v3-flash', mode: 'auto' }] });
    const output = (await tool.execute('qwen-tts', { text: '你好', voice: 'clone_voice_id', format: 'wav' }, undefined)).details as any;
    assert.equal(requestBody.input.voice, 'clone_voice_id');
    assert.equal((await readFile(path.join(workspaceRoot, output.path))).toString(), 'wave');
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections(); await closed;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('DashScope defaults match the actual model and 411 blocks blind retries within the run', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-voice-411-'));
  let fail = false;
  const received: any[] = [];
  let baseUrl = '';
  const server = createServer(async (request, response) => {
    if (request.url === '/audio') { response.setHeader('content-type', 'audio/mpeg'); response.end('audio'); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (fail) { response.statusCode = 400; response.end(JSON.stringify({ code: 'InvalidParameter', request_id: 'r-411', message: '[cosyvoice:]Engine error [411]: TTS speak operation failed' })); return; }
    response.end(JSON.stringify({ output: { audio: { url: `${baseUrl}/audio` } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const make = (modelId: string, voice?: string) => createModelCapabilityTools({ workspaceRoot, configs: [{ id: 'tts', capability: 'tts', provider: 'qwen', baseUrl, apiKey: 'key', modelId, voice, mode: 'auto' }] })[0];
  try {
    for (const [model, expected] of [
      ['qwen-audio-3.1-tts-flash', 'longanhuan_v3.1'], ['qwen-audio-3.0-tts-flash', 'longanhuan_v3.6'],
      ['qwen-audio-3.0-tts-plus', 'longanlingxin'], ['cosyvoice-v3-flash', 'longanyang'], ['cosyvoice-v2', 'longxiaochun_v2'],
    ]) {
      const result = (await make(model).execute('default', { text: '你好' }, undefined)).details as any;
      assert.equal(result.ok, true);
      assert.equal(received.at(-1).input.voice, expected);
      assert.equal((await readFile(path.join(workspaceRoot, result.path))).toString(), 'audio');
    }
    await make('cosyvoice-v2', 'my-clone').execute('custom', { text: '你好' }, undefined);
    assert.equal(received.at(-1).input.voice, 'my-clone');
    fail = true;
    const tool = make('qwen-audio-3.1-tts-flash', 'longanyang');
    const before = received.length;
    const failure = (await tool.execute('fail', { text: '你好' }, undefined)).details as any;
    assert.equal(failure.retryable, false);
    assert.equal(failure.requestId, 'r-411');
    assert.equal(failure.voice, 'longanyang');
    for (let i = 0; i < 10; i++) await tool.execute(`retry-${i}`, { text: 'short', voice: 'alloy', format: 'wav' }, undefined);
    assert.equal(received.length, before + 1);
    fail = false;
    assert.equal(((await make('qwen-audio-3.1-tts-flash').execute('new-run', { text: '你好' }, undefined)).details as any).ok, true);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Volcengine recorded-file ASR sends base64 audio with vendor headers', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-volc-asr-'));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(path.join(workspaceRoot, 'sample.wav'), 'audio'));
  let apiKey = '';
  let body: any;
  const server = createServer(async (request, response) => {
    apiKey = String(request.headers['x-api-key'] || '');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    body = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader('x-api-status-code', '20000000');
    response.end(JSON.stringify({ result: { text: '火山转写成功', utterances: [] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    const [tool] = createModelCapabilityTools({ workspaceRoot, configs: [{ id: 'asr', capability: 'asr', provider: 'volcengine', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'volc-key', appId: 'app', modelId: 'bigmodel', mode: 'auto' }] });
    const output = (await tool.execute('volc-asr', { path: 'sample.wav' }, undefined)).details as any;
    assert.equal(output.text, '火山转写成功');
    assert.equal(apiKey, 'volc-key');
    assert.equal(Buffer.from(body.audio.data, 'base64').toString(), 'audio');
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Volcengine TTS uses the configured default voice and saves decoded audio', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-volc-tts-'));
  let body: any;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    body = JSON.parse(Buffer.concat(chunks).toString());
    response.end(JSON.stringify({ code: 3000, data: Buffer.from('volc-audio').toString('base64') }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    const [tool] = createModelCapabilityTools({ workspaceRoot, configs: [{ id: 'tts', capability: 'tts', provider: 'volcengine', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'token', appId: 'app', modelId: 'volc-tts', voice: 'S_xxx', mode: 'auto' }] });
    const output = (await tool.execute('volc-tts', { text: '你好', format: 'mp3' }, undefined)).details as any;
    assert.equal(body.audio.voice_type, 'S_xxx');
    assert.equal((await readFile(path.join(workspaceRoot, output.path))).toString(), 'volc-audio');
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('iFlytek recorded-file ASR signs upload and polling requests', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-ifly-asr-'));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(path.join(workspaceRoot, 'sample.wav'), 'audio'));
  const hits: URL[] = [];
  const orderResult = JSON.stringify({ lattice: [{ json_1best: JSON.stringify({ st: { rt: [{ ws: [{ cw: [{ w: '讯飞' }] }, { cw: [{ w: '转写' }] }] }] } }) }] });
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    hits.push(url);
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/v2/api/upload') response.end(JSON.stringify({ code: '000000', content: { orderId: 'order-1' } }));
    else response.end(JSON.stringify({ code: '000000', content: { orderInfo: { status: 4 }, orderResult } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    const [tool] = createModelCapabilityTools({ workspaceRoot, configs: [{ id: 'asr', capability: 'asr', provider: 'iflytek', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'key', apiSecret: 'secret', appId: 'app', modelId: 'ifasr', mode: 'auto' }] });
    const output = (await tool.execute('ifly-asr', { path: 'sample.wav' }, undefined)).details as any;
    assert.equal(output.text, '讯飞转写');
    assert.deepEqual(hits.map((url) => url.pathname), ['/v2/api/upload', '/v2/api/getResult']);
    assert.ok(hits.every((url) => url.searchParams.get('appId') === 'app' && Boolean(url.searchParams.get('signa'))));
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('disabled specialist models are not exposed to the controller model', () => {
  const tools = createModelCapabilityTools({
    workspaceRoot: '/tmp/not-used',
    configs: [{ id: 'q', capability: 'quantum-code', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', apiKey: '', modelId: 'q', mode: 'disabled' }],
  });
  assert.equal(tools.length, 0);
});

test('Qwen Image 3 can use the shared endpoint when Workspace ID is omitted', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-qwen-default-workspace-'));
  const nativeFetch = globalThis.fetch;
  let requestedUrl = '';
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const tools = createModelCapabilityTools({
      workspaceRoot,
      configs: [{ id: 'qwen-image', capability: 'image', provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'key', modelId: 'qwen-image-3.0', mode: 'auto' }],
    });
    const output = (await tools[0].execute('test', { prompt: 'test' }, undefined)).details as any;
    assert.equal(output.ok, true);
    assert.equal(requestedUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations');
    assert.equal((await readFile(path.join(workspaceRoot, output.path))).toString(), 'png');
  } finally {
    globalThis.fetch = nativeFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('DashScope multimodal image protocol uses the native synchronous endpoint and payload', async () => {
  let captured: { url?: string; body?: any } = {};
  const nativeFetch = globalThis.fetch;
  const server = createServer(async (request, response) => {
    if (request.url === '/result.png') {
      response.setHeader('content-type', 'image/png');
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    captured = { url: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    response.end(JSON.stringify({ output: { choices: [{ message: { content: [{ image: `http://127.0.0.1:${address.port}/result.png` }] } }] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-dashscope-sync-'));
  try {
    for (const modelId of ['wan2.7-image', 'qwen-image-2.0']) {
    const tools = createModelCapabilityTools({
      workspaceRoot,
      configs: [{ id: 'image', capability: 'image', provider: 'qwen', baseUrl: `http://127.0.0.1:${address.port}/compatible-mode/v1`, apiKey: 'key', modelId, imageProtocol: 'dashscope-multimodal', mode: 'auto' }],
    });
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/result.png')) return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('TLS reset'), { code: 'ECONNRESET' }) }));
      return nativeFetch(input, init);
    }) as typeof fetch;
    const progress: Array<{ summary?: string; progress?: number }> = [];
    const output = (await tools[0].execute('test', { prompt: '竹林', size: '1280x1280' }, undefined, (update) => progress.push(update.details as any))).details as any;
    assert.equal(captured.url, '/api/v1/services/aigc/multimodal-generation/generation');
    assert.equal(captured.body.model, modelId);
    assert.equal(captured.body.input.messages[0].content[0].text, '竹林');
    assert.equal(captured.body.parameters.size, '1280*1280');
    assert.equal(output.protocol, 'dashscope-multimodal');
    assert.equal(output.url, undefined);
    assert.equal(output.deliverable, true);
    assert.equal((await readFile(path.join(workspaceRoot, output.path))).subarray(0, 4).toString('hex'), '89504e47');
    assert.ok(progress.some((item) => item.summary?.includes('兼容下载通道')));
    assert.ok(progress.some((item) => item.progress === 92));
    }
  } finally {
    globalThis.fetch = nativeFetch;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('DashScope asynchronous image protocol submits and polls a task', async () => {
  const hits: Array<{ method?: string; url?: string; asyncHeader?: string }> = [];
  let polls = 0;
  const server = createServer((request, response) => {
    hits.push({ method: request.method, url: request.url, asyncHeader: request.headers['x-dashscope-async'] as string | undefined });
    if (request.url === '/api/v1/services/aigc/text2image/image-synthesis') {
      response.end(JSON.stringify({ output: { task_id: 'task-1' } }));
    } else if (request.url === '/api/v1/tasks/task-1') {
      polls += 1;
      if (polls === 1) {
        response.end(JSON.stringify({ output: { task_status: 'RUNNING' } }));
        return;
      }
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      response.end(JSON.stringify({ output: { task_status: 'SUCCEEDED', results: [{ url: `http://127.0.0.1:${address.port}/async.png` }] } }));
    } else if (request.url === '/async.png') {
      response.setHeader('content-type', 'image/png');
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-dashscope-async-'));
  try {
    const tools = createModelCapabilityTools({
      workspaceRoot,
      configs: [{ id: 'wan', capability: 'image', provider: 'qwen', baseUrl: `http://127.0.0.1:${address.port}/compatible-mode/v1`, apiKey: 'key', modelId: 'wan2.5-t2i-preview', mode: 'auto' }],
    });
    const progress: Array<{ summary?: string; progress?: number }> = [];
    const output = (await tools[0].execute('test', { prompt: '园林' }, undefined, (update) => progress.push(update.details as any))).details as any;
    assert.deepEqual(hits, [
      { method: 'POST', url: '/api/v1/services/aigc/text2image/image-synthesis', asyncHeader: 'enable' },
      { method: 'GET', url: '/api/v1/tasks/task-1', asyncHeader: undefined },
      { method: 'GET', url: '/api/v1/tasks/task-1', asyncHeader: undefined },
      { method: 'GET', url: '/async.png', asyncHeader: undefined },
    ]);
    assert.equal(output.taskId, 'task-1');
    assert.equal(output.url, undefined);
    assert.equal(output.deliverable, true);
    assert.equal((await readFile(path.join(workspaceRoot, output.path))).subarray(0, 4).toString('hex'), '89504e47');
    assert.ok(progress.some((item) => item.summary?.includes('RUNNING')));
    assert.ok(progress.some((item) => item.summary?.includes('正在下载临时图片')));
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('image protocol errors retain HTTP method, status, and request URL', async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'route not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-image-error-'));
  try {
    const tools = createModelCapabilityTools({
      workspaceRoot,
      configs: [{ id: 'image', capability: 'image', provider: 'glm', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'secret', modelId: 'glm-image', imageProtocol: 'openai-images', mode: 'auto' }],
    });
    const output = (await tools[0].execute('test', { prompt: 'test' }, undefined)).details as { ok: false; error: string };
    assert.equal(output.ok, false);
    assert.match(output.error, new RegExp(`HTTP 404 POST http://127\\.0\\.0\\.1:${address.port}/images/generations.*route not found`));
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('image network errors retain method, endpoint, and low-level cause', async () => {
  const nativeFetch = globalThis.fetch;
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'openclawx-image-network-error-'));
  try {
    globalThis.fetch = (() => Promise.reject(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    }))) as typeof fetch;
    const tools = createModelCapabilityTools({
      workspaceRoot,
      configs: [{ id: 'image', capability: 'image', provider: 'qwen', baseUrl: 'https://llm-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKey: 'secret', modelId: 'qwen-image-3.0', imageProtocol: 'openai-images', mode: 'auto' }],
    });
    const output = (await tools[0].execute('test', { prompt: 'test' }, undefined)).details as { ok: false; error: string };
    assert.equal(output.ok, false);
    assert.match(output.error, /POST https:\/\/llm-example\.cn-beijing\.maas\.aliyuncs\.com\/compatible-mode\/v1\/images\/generations/);
    assert.match(output.error, /ECONNRESET/);
  } finally {
    globalThis.fetch = nativeFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
