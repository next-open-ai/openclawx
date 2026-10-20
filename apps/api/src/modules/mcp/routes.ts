import type { FastifyPluginAsync } from 'fastify';
import { McpProbeRequestSchema } from '@openclawx/contracts';
import { probeMcpConnection } from '@openclawx/agent-core';
import { authenticateRequest, requireAuth, sendAuthError } from '../auth/service.js';

export const mcpRoutes: FastifyPluginAsync = async (app) => {
  app.post('/mcp/test', async (request, reply) => {
    try {
      request.auth = authenticateRequest(request);
      requireAuth(request);
      const parsed = McpProbeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ message: 'Invalid MCP probe request.', issues: parsed.error.issues });
      }
      const result = await probeMcpConnection(parsed.data.connection, { timeoutMs: parsed.data.timeoutMs });
      if (!result.ok) return reply.code(400).send(result);
      return result;
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });
};
