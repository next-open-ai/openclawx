import type { FastifyInstance } from 'fastify';
import type { KeyValueStore } from '@workmate/orchestrator';
import { algorithmDefinitionSchema, workflowDefinitionSchema } from '@workmate/contracts';
import { requireAuth } from '../auth/service.js';

/** Private reusable definitions only; existing ProjectService remains the execution owner. */
export function registerDefinitionRoutes(app: FastifyInstance, store: KeyValueStore) {
  for (const kind of ['workflows', 'algorithms'] as const) {
    const schema = kind === 'workflows' ? workflowDefinitionSchema : algorithmDefinitionSchema;
    const base = `/definitions/${kind}`;
    const prefixFor = (auth: { orgId: string; userId: string }) =>
      `definitions:v1:${encodeURIComponent(auth.orgId)}:${encodeURIComponent(auth.userId)}:${kind}:`;
    app.get(base, async request => {
      const prefix = prefixFor(requireAuth(request));
      const keys = await store.keys(prefix);
      const values = await Promise.all(keys.map(key => store.get(key)));
      return { items: values.filter((value): value is string => value !== null).map(value => JSON.parse(value)) };
    });
    app.put(`${base}/:id`, async (request, reply) => {
      const prefix = prefixFor(requireAuth(request));
      const { id } = request.params as { id: string };
      const parsed = schema.safeParse(request.body);
      if (!parsed.success || parsed.data.id !== id) return reply.code(400).send({ message: parsed.success ? '登记 ID 不匹配' : parsed.error.issues[0]?.message });
      await store.set(prefix + id, JSON.stringify(parsed.data));
      return { item: parsed.data };
    });
    app.delete(`${base}/:id`, async request => {
      const prefix = prefixFor(requireAuth(request));
      const { id } = request.params as { id: string };
      await store.delete(prefix + id);
      return { ok: true };
    });
  }
}
