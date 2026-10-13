import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from '../apps/renderer/node_modules/vite/dist/node/index.js';

const vite = await createServer({ root: 'apps/renderer', server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
try {
  const { applyRecommendedProviderSetup, classifyCapabilityFailure, createProviderInstance, effectiveProviderBaseUrl, migrateLegacyRealtimeProvider, providerDerivedEndpoints, providerInstanceReady, providerRequiresServiceSelection, providerServiceOptions, providerSupportsRecommendedSetup, providerSuggestedByCapability, sanitizeModelSettings, summarizeProviderModelHealth } = await vite.ssrLoadModule('/src/app/model-config.ts');
  const empty = () => ({ version: 3, providerInstances: [], models: [], activeChatModelId: null, activeEmbeddingModelId: null, employeeDefaultModelIds: {}, capabilityBindings: [], agentCapabilityAssignments: [] });
  const qwen = { id: 'qwen-1', type: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'test', workspaceId: '', disableThinking: false };
  const first = applyRecommendedProviderSetup(empty(), qwen, ['general']);
  assert.equal(first.manualRequired, false);
  assert.equal(first.addedModels, 7);
  assert.equal(first.settings.models.find((item) => item.capability === 'chat')?.modelId, 'qwen3.8-flash');
  assert.equal(first.settings.models.find((item) => item.capability === 'vision')?.modelId, 'qwen3.8-flash');
  assert.equal(first.settings.models.find((item) => item.capability === 'image')?.modelId, 'qwen-image-3.0');
  assert.equal(first.settings.models.find((item) => item.capability === 'image')?.imageProtocol, 'openai-images');
  assert.equal(first.settings.models.find((item) => item.capability === 'asr')?.modelId, 'qwen-audio-3.1-asr-flash-filetrans');
  assert.equal(first.settings.models.find((item) => item.capability === 'tts')?.voice, 'longanhuan_v3.1');
  assert.ok(first.settings.capabilityBindings.some((item) => item.capability === 'vision' && item.enabled));
  assert.ok(first.settings.agentCapabilityAssignments.some((item) => item.agentId === 'general' && item.capability === 'asr' && item.mode === 'auto'));
  for (const model of first.settings.models) {
    assert.ok(
      providerSuggestedByCapability.qwen[model.capability].includes(model.modelId),
      `automatic ${model.capability} choice must stay in the versioned common-recommendation catalog`,
    );
  }

  const repeated = applyRecommendedProviderSetup(first.settings, qwen, ['general']);
  assert.equal(repeated.addedModels, 0);
  assert.equal(repeated.settings.models.length, first.settings.models.length);
  assert.equal(repeated.settings.capabilityBindings.length, first.settings.capabilityBindings.length);
  assert.equal(repeated.settings.agentCapabilityAssignments.length, first.settings.agentCapabilityAssignments.length);

  const withWorkspace = applyRecommendedProviderSetup(empty(), { ...qwen, workspaceId: 'llm-test' }, ['general']);
  assert.equal(withWorkspace.settings.models.find((item) => item.capability === 'image')?.modelId, 'qwen-image-3.0');
  assert.equal(withWorkspace.settings.models.find((item) => item.capability === 'image')?.imageProtocol, 'openai-images');
  assert.ok(providerSuggestedByCapability.qwen.image.includes('qwen-image-3.0'));
  assert.deepEqual(providerSuggestedByCapability.qwen.chat.slice(0, 2), ['qwen3.8-flash', 'qwen3.8-max']);
  assert.deepEqual(providerSuggestedByCapability.qwen.vision.slice(0, 2), ['qwen3.8-flash', 'qwen3.8-max']);
  assert.equal(effectiveProviderBaseUrl({ ...qwen, service: 'unified' }, 'chat'), 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(effectiveProviderBaseUrl({ ...qwen, service: 'unified' }, 'asr'), 'https://dashscope.aliyuncs.com/api/v1');
  assert.ok(providerDerivedEndpoints({ ...qwen, service: 'unified' }).some((item) => item.url === 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'));
  assert.equal(effectiveProviderBaseUrl({ ...qwen, workspaceId: 'llm-test', service: 'unified' }, 'tts'), 'https://llm-test.cn-beijing.maas.aliyuncs.com/api/v1');

  const volcLanguage = { id: 'volc-ark', type: 'volcengine', name: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'test', service: 'language', disableThinking: false };
  const volcLanguageSetup = applyRecommendedProviderSetup(empty(), volcLanguage, ['general']);
  assert.deepEqual(volcLanguageSetup.settings.models.map((item) => item.capability), ['chat']);
  assert.equal(effectiveProviderBaseUrl(volcLanguage, 'chat'), 'https://ark.cn-beijing.volces.com/api/v3');
  const volcSpeechSetup = applyRecommendedProviderSetup(empty(), { ...volcLanguage, id: 'volc-speech', service: 'speech', baseUrl: 'https://openspeech.bytedance.com', appId: 'app' }, ['general']);
  assert.deepEqual(volcSpeechSetup.settings.models.map((item) => item.capability), ['asr', 'tts']);
  const volcRealtime = { ...volcLanguage, id: 'volc-realtime', service: 'realtime', baseUrl: 'https://openspeech.bytedance.com' };
  const volcRealtimeSetup = applyRecommendedProviderSetup(empty(), volcRealtime, ['general']);
  assert.deepEqual(volcRealtimeSetup.settings.models.map((item) => item.capability), ['realtime']);
  assert.equal(volcRealtimeSetup.settings.models[0].voice, 'zh_female_vv_jupiter_bigtts');
  assert.equal(volcRealtimeSetup.settings.capabilityBindings[0]?.modelId, volcRealtimeSetup.settings.models[0].id);
  assert.equal(effectiveProviderBaseUrl(volcRealtime, 'realtime'), 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue');
  assert.equal(providerInstanceReady({ ...volcLanguage, id: 'volc-realtime', service: 'realtime', baseUrl: 'https://openspeech.bytedance.com' }), true);
  assert.equal(providerInstanceReady({ ...volcLanguage, id: 'volc-speech', service: 'speech', baseUrl: 'https://openspeech.bytedance.com' }), false);
  assert.deepEqual(providerServiceOptions('volcengine'), ['language', 'speech', 'realtime']);
  assert.deepEqual(providerServiceOptions('openai'), ['unified', 'language', 'speech']);
  assert.deepEqual(providerServiceOptions('qwen'), ['unified', 'language', 'speech']);
  assert.equal(providerRequiresServiceSelection('openai'), false);
  assert.equal(providerRequiresServiceSelection('qwen'), false);
  assert.equal(providerRequiresServiceSelection('volcengine'), true);
  const providerEditorSource = fs.readFileSync('apps/renderer/src/features/settings/ProviderInstancesEditor.vue', 'utf8');
  assert.match(providerEditorSource, /providerRequiresServiceSelection\(addDraft\.type\)/);
  assert.match(providerEditorSource, /providerRequiresServiceSelection\(instance\.type\)/);
  assert.doesNotMatch(providerEditorSource, /providerServiceAdvanced/);
  assert.match(providerEditorSource, /<details[^>]*>[\s\S]*instance\.type === 'qwen'[\s\S]*settings\.workspaceIdHelp/);
  const i18nSource = fs.readFileSync('apps/renderer/src/app/i18n.ts', 'utf8');
  assert.match(i18nSource, /settings\.workspaceIdHint': '默认留空，无需配置'/);
  assert.match(i18nSource, /标准模型默认使用 API Key 所属的默认业务空间，留空即可/);
  const settingsPageSource = fs.readFileSync('apps/renderer/src/features/settings/SettingsPage.vue', 'utf8');
  assert.doesNotMatch(settingsPageSource, /\{ id: 'voice', labelKey: 'settings\.tabVoice' \}/);
  assert.match(settingsPageSource, /tab === 'models'.*RealtimeVoiceSettingsCard/s);
  assert.deepEqual(providerServiceOptions('google'), ['language']);
  assert.deepEqual(providerServiceOptions('glm'), ['language']);
  assert.deepEqual(providerServiceOptions('iflytek'), ['speech']);
  assert.equal(createProviderInstance('volcengine', []).name, '火山引擎 · 大模型');
  assert.equal(providerSupportsRecommendedSetup({ type: 'volcengine', service: 'realtime' }), true);
  assert.equal(providerSupportsRecommendedSetup({ type: 'glm', service: 'language' }), true);
  const migratedVoice = migrateLegacyRealtimeProvider(empty(), { apiKey: 'legacy-secret', model: 'legacy-realtime', voice: 'legacy-voice' });
  assert.equal(migratedVoice.providerInstances[0]?.service, 'realtime');
  assert.equal(migratedVoice.models[0]?.modelId, 'legacy-realtime'); assert.equal(migratedVoice.models[0]?.voice, 'legacy-voice');
  assert.equal(migrateLegacyRealtimeProvider(migratedVoice, { apiKey: 'again' }).providerInstances.length, 1, 'migration is idempotent');

  const zhipu = { id: 'glm-1', type: 'glm', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'test', service: 'language', disableThinking: false };
  const zhipuSetup = applyRecommendedProviderSetup(empty(), zhipu, ['general']);
  assert.deepEqual(zhipuSetup.settings.models.map((item) => item.capability), ['chat', 'image', 'video', 'vision', 'embedding']);
  for (const [capability, modelId] of Object.entries({ chat: 'glm-5.3', image: 'cogview-3-flash', video: 'cogvideox-flash', vision: 'glm-4.6v-flash' })) {
    assert.equal(zhipuSetup.settings.models.find((item) => item.capability === capability)?.modelId, modelId);
    assert.ok(providerSuggestedByCapability.glm[capability].includes(modelId));
  }
  assert.equal(zhipuSetup.settings.models.find((item) => item.capability === 'image')?.imageProtocol, 'openai-images');
  assert.ok(zhipuSetup.settings.capabilityBindings.some((item) => item.capability === 'video' && item.enabled));
  assert.equal(applyRecommendedProviderSetup(zhipuSetup.settings, zhipu, ['general']).addedModels, 0);
  const oldGlm = empty();
  oldGlm.providerInstances.push(zhipu);
  oldGlm.models.push({ id: 'old-glm-chat', providerInstanceId: zhipu.id, capability: 'chat', modelId: 'glm-4.5-flash' });
  oldGlm.models.push({ id: 'old-glm-image', providerInstanceId: zhipu.id, capability: 'image', modelId: 'glm-image', imageProtocol: 'openai-images' });
  oldGlm.activeChatModelId = 'old-glm-chat';
  oldGlm.capabilityBindings.push({ capability: 'image', modelId: 'old-glm-image', enabled: true, updatedAt: '2026-10-09T00:00:00.000Z' });
  const upgradedGlm = applyRecommendedProviderSetup(oldGlm, zhipu, ['general']);
  assert.equal(upgradedGlm.settings.activeChatModelId, 'old-glm-chat');
  assert.equal(upgradedGlm.settings.capabilityBindings.find((item) => item.capability === 'image')?.modelId, 'old-glm-image');
  assert.ok(upgradedGlm.settings.models.some((item) => item.modelId === 'glm-5.3'));
  assert.ok(upgradedGlm.settings.models.some((item) => item.modelId === 'cogview-3-flash'));

  const existing = empty();
  existing.providerInstances.push({ id: 'custom', type: 'openai-compatible', name: '已有连接', baseUrl: 'https://example.test/v1', apiKey: 'x', disableThinking: false });
  existing.models.push({ id: 'manual-chat', providerInstanceId: 'custom', capability: 'chat', modelId: 'manual-chat' });
  existing.models.push({ id: 'manual-vision', providerInstanceId: 'custom', capability: 'vision', modelId: 'manual-vision' });
  existing.activeChatModelId = 'manual-chat';
  existing.capabilityBindings.push({ capability: 'vision', modelId: 'manual-vision', enabled: true, updatedAt: '2026-09-25T00:00:00.000Z' });
  const preserved = applyRecommendedProviderSetup(existing, qwen, ['general']);
  assert.equal(preserved.settings.activeChatModelId, 'manual-chat');
  assert.equal(preserved.settings.capabilityBindings.find((item) => item.capability === 'vision')?.modelId, 'manual-vision');
  assert.ok(preserved.preserved.includes('chat') && preserved.preserved.includes('vision'));

  const manual = applyRecommendedProviderSetup(empty(), { id: 'custom', type: 'openai-compatible', name: '私有服务', baseUrl: 'https://example.test/v1', apiKey: '', disableThinking: false }, ['general']);
  assert.equal(manual.manualRequired, true);
  assert.equal(manual.addedModels, 0);
  assert.equal(classifyCapabilityFailure('HTTP 403 forbidden'), 'permission_error');
  assert.equal(classifyCapabilityFailure('HTTP 404 model not found'), 'configuration_error');
  assert.equal(classifyCapabilityFailure('fetch failed ECONNRESET'), 'temporarily_unavailable');
  const withHealth = first.settings;
  withHealth.models[0].health = { status: 'available', checkedAt: '2026-09-25T00:00:00.000Z', summary: 'ok' };
  assert.deepEqual(sanitizeModelSettings(withHealth).models[0].health, withHealth.models[0].health);
  withHealth.models[1].health = { status: 'configuration_error', checkedAt: '2026-09-25T00:00:00.000Z', summary: '404' };
  withHealth.models[2].health = { status: 'available', checkedAt: '2026-07-01T00:00:00.000Z', summary: 'old ok' };
  assert.deepEqual(
    summarizeProviderModelHealth(withHealth.models, qwen.id, Date.parse('2026-09-25T12:00:00.000Z')),
    { total: 7, available: 1, issues: 1, stale: 1, unverified: 4 },
  );
  console.log('AMC-AUTO-CONFIG-001 PASS: recommendation, workspace branch, preservation, idempotency and manual fallback.');
} finally {
  await vite.close();
}
