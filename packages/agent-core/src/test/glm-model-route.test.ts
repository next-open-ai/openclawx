import assert from 'node:assert/strict';
import test from 'node:test';
import { mapOpenClawXModelToDshRoute } from '../dsh/model-route.js';
import { createChatCompletionsPayloadPatch, toPiModel } from '../pi-model.js';

const glmConfig = {
  provider: 'glm' as const,
  chatModel: 'glm-4.5-flash',
  apiKey: 'test-key',
};

test('GLM uses the Zhipu OpenAI-compatible endpoint in the Pi runtime', () => {
  const model = toPiModel(glmConfig);
  assert.equal(model.api, 'openai-completions');
  assert.equal(model.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
});

test('GLM-5.3 stays text-only and never receives a disabled thinking parameter', () => {
  const config = { ...glmConfig, chatModel: 'glm-5.3', disableThinking: true };
  const model = toPiModel(config);
  assert.equal(model.id, 'glm-5.3');
  assert.deepEqual(model.input, ['text']);
  const body: Record<string, unknown> = { model: model.id, tools: [{ type: 'function' }] };
  createChatCompletionsPayloadPatch(config)(body);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.thinking, undefined, 'omit thinking to use the official always-enabled default');
  assert.equal(body.think, undefined);
});

test('GLM uses the Zhipu OpenAI-compatible endpoint in the dsh runtime', () => {
  const route = mapOpenClawXModelToDshRoute(glmConfig);
  assert.equal(route.api, 'openai-completions');
  assert.equal(route.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(route.apiKey, 'test-key');
});
