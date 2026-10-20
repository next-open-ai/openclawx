import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { MemoryStore } from '@openclawx/orchestrator';
import { registerDefinitionRoutes } from './definition-routes.js';

test('WA-R1/R2: private definitions persist, validate DAGs and isolate users', async () => {
  const app = Fastify(); const store = new MemoryStore();
  app.addHook('preHandler', async request => {
    request.auth = { userId: String(request.headers['x-test-user'] || 'alice'), orgId: String(request.headers['x-test-org'] || 'org'), role: 'member', username: 'test', displayName: 'test', sessionId: 'synthetic' };
  });
  registerDefinitionRoutes(app, store);
  const first = randomUUID(); const second = randomUUID(); const id = randomUUID();
  const definition = { id, name: '报告生成', description: '', nodes: [
    { id: first, title: '分析', employeeId: 'general', objective: '分析数据', dependsOn: [], acceptance: '' },
    { id: second, title: '成文', employeeId: 'general', objective: '生成报告', dependsOn: [first], acceptance: '' },
  ] };
  const endpoint = `/definitions/workflows/${id}`;
  try {
    assert.equal((await app.inject({ method: 'PUT', url: endpoint, payload: definition })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/definitions/workflows' })).json().items[0].nodes[1].dependsOn[0], first);
    for (const headers of [{ 'x-test-user': 'bob' }, { 'x-test-org': 'elsewhere' }]) {
      assert.deepEqual((await app.inject({ method: 'GET', url: '/definitions/workflows', headers })).json().items, []);
      await app.inject({ method: 'DELETE', url: endpoint, headers });
      assert.equal((await app.inject({ method: 'GET', url: '/definitions/workflows' })).json().items.length, 1);
    }
    const cycle = structuredClone(definition); cycle.nodes[0].dependsOn = [second];
    assert.equal((await app.inject({ method: 'PUT', url: endpoint, payload: cycle })).statusCode, 400);
    const dangling = structuredClone(definition); dangling.nodes[0].dependsOn = [randomUUID()];
    assert.equal((await app.inject({ method: 'PUT', url: endpoint, payload: dangling })).statusCode, 400);
    const duplicate = structuredClone(definition); duplicate.nodes.push(duplicate.nodes[0]);
    assert.equal((await app.inject({ method: 'PUT', url: endpoint, payload: duplicate })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: `/definitions/workflows/${randomUUID()}`, payload: definition })).statusCode, 400);
    definition.name = '修改后';
    await app.inject({ method: 'PUT', url: endpoint, payload: definition });
    assert.equal((await app.inject({ method: 'GET', url: '/definitions/workflows' })).json().items.length, 1);
    await app.inject({ method: 'DELETE', url: endpoint });
    assert.deepEqual((await app.inject({ method: 'GET', url: '/definitions/workflows' })).json().items, []);
    const algorithm = { id: randomUUID(), name: '领域算法', description: '调用已安装的 Skill', skillId: 'local-algorithm', version: '1.0.0' };
    assert.equal((await app.inject({ method: 'PUT', url: `/definitions/algorithms/${algorithm.id}`, payload: algorithm })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/definitions/algorithms' })).json().items[0].skillId, 'local-algorithm');
    assert.deepEqual((await app.inject({ method: 'GET', url: '/definitions/workflows' })).json().items, []);
  } finally { await app.close(); await store.close(); }
});
