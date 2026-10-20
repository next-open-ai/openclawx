import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publicVoiceInputSettings, readVoiceInputSettings, saveVoiceInputSettings } from './asr-settings.js';
import { publicRealtimeConversationSettings, readRealtimeConversationSettings, resolveRealtimeRuntime, saveRealtimeConversationSettings } from './realtime-settings.js';
import { applyParentSecrets } from '../orchestration/secrets.js';
import { readVoicePreferences } from './voice-preferences.js';

test('VSM-R1/R2: legacy settings migrate into independent capability stores', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-voice-modules-'));
  const previous = process.env.OPENCLAWX_DATA_DIR; process.env.OPENCLAWX_DATA_DIR = root;
  try {
    fs.writeFileSync(path.join(root, 'voice-realtime-settings.json'), JSON.stringify({ enabled: true, apiKey: 'realtime-secret', voiceMode: 'input', asrEnabled: true, asrReuseKey: false, asrApiKey: 'asr-secret', asrResourceId: 'volc.bigasr.sauc.duration', model: 'legacy-model' }));
    assert.equal(readRealtimeConversationSettings().model, 'legacy-model');
    assert.equal(readVoiceInputSettings().resourceId, 'volc.bigasr.sauc.duration');
    assert.equal(readVoicePreferences().defaultMode, 'input');
    for (const name of ['voice-realtime-settings.v2.json', 'voice-input-settings.json', 'voice-preferences.json']) assert.equal(fs.statSync(path.join(root, name)).mode & 0o777, 0o600);

    saveVoiceInputSettings({ enabled: false, apiKey: 'new-asr-secret', reuseRealtimeKey: false });
    assert.equal(readRealtimeConversationSettings().enabled, true);
    assert.equal(publicRealtimeConversationSettings().apiKeyMasked, '••••••••cret');
    saveRealtimeConversationSettings({ enabled: false, apiKey: 'new-realtime-secret' });
    assert.equal(readVoiceInputSettings().enabled, false);
    assert.equal(publicVoiceInputSettings().apiKeyMasked, '••••••••cret');

    applyParentSecrets({ model: {
      providerInstances: [{ id: 'volc-rt', type: 'volcengine', name: '火山实时语音', service: 'realtime', baseUrl: 'https://openspeech.bytedance.com', apiKey: 'provider-realtime-secret' }],
      models: [{ id: 'rt-model', providerInstanceId: 'volc-rt', capability: 'realtime', modelId: '1.2.6.1', voice: 'zh_male_yunzhou_jupiter_bigtts' }],
      capabilityBindings: [{ capability: 'realtime', modelId: 'rt-model', enabled: true }],
    } });
    const runtime = resolveRealtimeRuntime();
    assert.equal(runtime.source, 'provider'); assert.equal(runtime.model, '1.2.6.1'); assert.equal(runtime.voice, 'zh_male_yunzhou_jupiter_bigtts');
    assert.match(runtime.endpoint, /openspeech\.bytedance\.com/);
    const publicValue = publicRealtimeConversationSettings();
    assert.equal(publicValue.apiKeySource, 'provider'); assert.equal(publicValue.providerName, '火山实时语音'); assert.equal(JSON.stringify(publicValue).includes('provider-realtime-secret'), false);

    applyParentSecrets({ model: {
      providerInstances: [{ id: 'qwen', type: 'qwen', name: '百炼综合服务', service: 'unified', baseUrl: 'https://dashscope.aliyuncs.com', workspaceId: 'space-1', apiKey: 'qwen-secret' }],
      models: [{ id: 'qwen-rt', providerInstanceId: 'qwen', capability: 'realtime', modelId: 'qwen-audio-3.1-realtime-plus', voice: 'longanqian_v3.1' }],
      capabilityBindings: [{ capability: 'realtime', modelId: 'qwen-rt', enabled: true }],
    } });
    const qwen = resolveRealtimeRuntime();
    assert.equal(qwen.provider, 'qwen'); assert.equal(qwen.model, 'qwen-audio-3.1-realtime-plus'); assert.equal(qwen.voice, 'longanqian_v3.1');
    assert.match(qwen.endpoint, /^wss:\/\/space-1\.cn-beijing\.maas\.aliyuncs\.com\/api-ws\/v1\/realtime$/);
  } finally {
    applyParentSecrets({});
    if (previous === undefined) delete process.env.OPENCLAWX_DATA_DIR; else process.env.OPENCLAWX_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
