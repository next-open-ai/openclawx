import type { FastifyInstance } from 'fastify';
import type { KeyValueStore } from '@workmate/orchestrator';
import { withKeyLock } from '@workmate/orchestrator';
import { employeeDataAssociationSchema, employeeDataAssociationKey } from '@workmate/contracts';
import { requireAuth } from '../auth/service.js';
import type { AgentDataGateway } from './agent-query.js';

/** Users can only change their own object bindings, not arbitrary employee prefs/KV. */
export function registerAgentDataAssociations(app: FastifyInstance, store: () => KeyValueStore, gateway: AgentDataGateway) {
  const validEmployee = (id: string) => id.length > 0 && id.length <= 120;
  app.get<{ Params: { employeeId: string } }>('/data/agent-associations/:employeeId', async (request, reply) => {
    const auth = requireAuth(request), id = request.params.employeeId;
    if (!validEmployee(id)) return reply.code(400).send({ message: '员工标识无效。' });
    const raw = await store().get(employeeDataAssociationKey(auth, id));
    return employeeDataAssociationSchema.parse(raw ? JSON.parse(raw) : { dataSourceIds: [] });
  });
  app.put<{ Params: { employeeId: string } }>('/data/agent-associations/:employeeId', async (request, reply) => {
    const auth = requireAuth(request), id = request.params.employeeId, parsed = employeeDataAssociationSchema.safeParse(request.body);
    if (!validEmployee(id) || !parsed.success) return reply.code(400).send({ message: '请选择最多24个有效数据对象，不支持其他配置项。' });
    const ids = [...new Set(parsed.data.dataSourceIds)], owned = new Set((await gateway.list(auth)).map(s => s.id));
    if (ids.some(sourceId => !owned.has(sourceId))) return reply.code(404).send({ message: '部分数据对象不存在或无权访问，请刷新对象列表后重新选择。' });
    const key = employeeDataAssociationKey(auth, id);
    return withKeyLock(key, async () => {
      const value = { dataSourceIds: ids };
      await store().set(key, JSON.stringify(value)); await store().flush();
      return value;
    });
  });
}
