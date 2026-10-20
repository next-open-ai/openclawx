import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DecisionGuardPolicySchema, DecisionRuntimeConfigSchema, ModelCapabilitySchema, type DecisionRuntimeConfig } from '@openclawx/contracts';
import { createDecisionAgentTool, evaluateDecision, guardAgentTools } from '../decision-runtime.js';
import { defineAgentTool, extractToolDetails, Type } from '../pi-tools.js';

test('decision runtime is off by default and enforce guard runs before side effects', async () => {
  let requests = 0;
  let executed = 0;
  const server = createServer(async (request, response) => {
    requests += 1;
    for await (const _ of request) { /* consume */ }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ answers: { risk: { choice: 'high', confidence: 0.98 }, allow: { value: false, confidence: 0.99 }, healthy: { value: true } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base: DecisionRuntimeConfig = { enabled: true, mode: 'enforce', provider: 'stub', protocol: 'system-one-v1', baseUrl: `http://127.0.0.1:${port}`, model: 'decision-test', timeoutMs: 1000, failurePolicy: 'allow', guardTools: true, agentTool: true, mcpEnabled: false };
  try {
    const off = await evaluateDecision({ ...base, enabled: false, mode: 'off' }, {}, {});
    assert.equal(off.bypassed, true); assert.equal(requests, 0);
    assert.equal(createDecisionAgentTool(base)[0]?.name, 'decision_evaluate');
    const write = defineAgentTool({ name: 'write_record', description: 'write', parameters: Type.Object({ value: Type.String() }), execute: () => { executed += 1; return { ok: true }; } });
    const [guarded] = guardAgentTools([write], base);
    const blocked = extractToolDetails(await guarded.execute('call', { value: 'x' }, undefined));
    assert.equal((blocked as any).ok, false); assert.equal(executed, 0); assert.equal(requests, 1);
    const observed = guardAgentTools([write], { ...base, mode: 'observe' })[0];
    const allowed = extractToolDetails(await observed.execute('call-2', { value: 'x' }, undefined));
    assert.equal((allowed as any).ok, true); assert.equal(executed, 1); assert.equal(requests, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('decision is an application-model capability and persisted policy contains no provider secret', () => {
  assert.equal(ModelCapabilitySchema.parse('decision'), 'decision');
  const policy = DecisionGuardPolicySchema.parse({ applicationModelId: 'decision-model-1' });
  assert.deepEqual(policy, {
    enabled: false,
    mode: 'off',
    applicationModelId: 'decision-model-1',
    timeoutMs: 1500,
    failurePolicy: 'allow',
    guardTools: true,
    agentTool: true,
    mcpEnabled: false,
  });
  assert.equal('apiKey' in policy, false);
  assert.equal(DecisionRuntimeConfigSchema.safeParse(policy).success, false);
});
