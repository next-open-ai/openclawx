import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { AsrEvent } from '@openclawx/contracts';
import { registerAsrRoutes } from './asr-routes.js';
import { publicRealtimeVoiceSettings, readRealtimeVoiceSettings, resolveAsrKey, saveRealtimeVoiceSettings } from './settings.js';

test('ASR-R1/R3: settings compatibility, secret selection, owner isolation, capacity and commands', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-asr-test-'));
  const previous = { dir: process.env.OPENCLAWX_DATA_DIR, realtime: process.env.OPENCLAWX_VOLCENGINE_REALTIME_API_KEY, asr: process.env.OPENCLAWX_VOLCENGINE_ASR_API_KEY };
  process.env.OPENCLAWX_DATA_DIR = root; delete process.env.OPENCLAWX_VOLCENGINE_REALTIME_API_KEY; delete process.env.OPENCLAWX_VOLCENGINE_ASR_API_KEY;
  const app = Fastify(); const uploads: Buffer[] = []; let finished = 0; let closed = 0;
  let upstreamEvent: ((event: AsrEvent) => void) | undefined;
  try {
    assert.equal(readRealtimeVoiceSettings().voiceMode, 'realtime'); assert.equal(readRealtimeVoiceSettings().asrReuseKey, true); assert.equal(readRealtimeVoiceSettings().audioGateEnabled, false);
    saveRealtimeVoiceSettings({ apiKey: 'shared-secret-1234' }); assert.equal(resolveAsrKey(), 'shared-secret-1234');
    saveRealtimeVoiceSettings({ voiceMode: 'input', asrReuseKey: false, asrApiKey: 'independent-secret-5678' });
    saveRealtimeVoiceSettings({ model: 'updated' }); assert.equal(readRealtimeVoiceSettings().voiceMode, 'input'); assert.equal(resolveAsrKey(), 'independent-secret-5678');
    saveRealtimeVoiceSettings({ audioGateEnabled: false }); assert.equal(readRealtimeVoiceSettings().audioGateEnabled, false);
    assert.equal(publicRealtimeVoiceSettings().audioGateEnabled, false);
    const publicValue = publicRealtimeVoiceSettings(); assert.equal(publicValue.asrApiKeyMasked, '••••••••5678');
    assert.equal(JSON.stringify(publicValue).includes('independent-secret'), false); assert.equal('asrApiKey' in publicValue, false);
    for (const file of ['voice-realtime-settings.v2.json', 'voice-input-settings.json', 'voice-preferences.json']) {
      assert.equal(fs.statSync(path.join(root, file)).mode & 0o777, 0o600);
    }
    process.env.OPENCLAWX_VOLCENGINE_ASR_API_KEY = 'environment-secret'; assert.equal(resolveAsrKey(), 'environment-secret');
    saveRealtimeVoiceSettings({ asrReuseKey: true }); assert.equal(resolveAsrKey(), 'shared-secret-1234');
    saveRealtimeVoiceSettings({ asrReuseKey: false, clearAsrApiKey: true }); delete process.env.OPENCLAWX_VOLCENGINE_ASR_API_KEY; assert.equal(resolveAsrKey(), '');
    saveRealtimeVoiceSettings({ asrReuseKey: true });
    app.addHook('preHandler', async (request) => {
      const user = request.headers['x-test-user'];
      if (typeof user === 'string') request.auth = { userId: user, orgId: String(request.headers['x-test-org'] || 'org'), username: user, displayName: user, role: 'admin', sessionId: 'test' };
    });
    await registerAsrRoutes(app, (input, emit) => {
      upstreamEvent = emit;
      assert.equal(input.apiKey, 'shared-secret-1234'); emit({ type: 'connected' });
      return { audio: (bytes) => { uploads.push(bytes); }, finish: () => { finished++; }, close: () => { closed++; } };
    });
    const post = (operation: string, payload: unknown, user = 'one', org = 'org') => app.inject({ method: 'POST', url: `/voice/asr/${operation}`, headers: { 'x-test-user': user, 'x-test-org': org }, payload: payload as Record<string, unknown> });
    assert.equal((await app.inject({ method: 'POST', url: '/voice/asr/session', payload: {} })).statusCode, 401);
    const created = await post('session', {}); const id = created.json().session_id; assert.equal(created.statusCode, 200);
    upstreamEvent!({ type: 'transcript', text: '旧的中间文字', isFinal: false });
    upstreamEvent!({ type: 'transcript', text: '新的修订文字', isFinal: false });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal((await fetch(`${base}/voice/asr/events?session_id=${id}`, { headers: { 'x-test-user': 'other' } })).status, 404);
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(`${base}/voice/asr/events?session_id=${id}`, { headers: { 'x-test-user': 'one' }, signal: controller.signal });
      assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
      const reader = response.body!.getReader(); let replay = '';
      while (!replay.includes('新的修订文字')) { const chunk = await reader.read(); if (chunk.done) break; replay += new TextDecoder().decode(chunk.value); }
      assert.ok(replay.includes('connected')); assert.ok(replay.includes('新的修订文字')); assert.equal(replay.includes('旧的中间文字'), false);
    } finally { clearTimeout(timeout); controller.abort(); }
    await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(closed, 0, 'SSE unsubscribe does not own upstream lifetime');
    assert.equal((await post('audio', { session_id: id, audio: 'AAAA' }, 'other')).statusCode, 404);
    assert.equal((await post('finish', { session_id: id }, 'one', 'other-org')).statusCode, 404);
    assert.equal((await post('audio', { session_id: id, audio: 'AAAAAA==' })).statusCode, 200); assert.equal(uploads.length, 1);
    assert.equal((await post('audio', { session_id: id, audio: 'AAAA' })).statusCode, 400);
    assert.equal((await post('audio', { session_id: id, audio: '!!!!' })).statusCode, 400);
    await post('finish', { session_id: id }); assert.equal(finished, 1);
    await post('session', {}); assert.equal((await post('session', {})).statusCode, 429);
    await post('close', { session_id: id }); assert.equal(closed, 1); assert.equal((await post('finish', { session_id: id })).statusCode, 404);
    saveRealtimeVoiceSettings({ asrEnabled: false }); assert.equal((await post('session', {})).statusCode, 400);
  } finally {
    await app.close();
    for (const [key, value] of Object.entries({ OPENCLAWX_DATA_DIR: previous.dir, OPENCLAWX_VOLCENGINE_REALTIME_API_KEY: previous.realtime, OPENCLAWX_VOLCENGINE_ASR_API_KEY: previous.asr })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
