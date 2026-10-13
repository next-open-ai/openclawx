import fs from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { setConversationSiteBundleResolver } from '@workmate/agent-core';
import { authRoutes } from './modules/auth/routes.js';
import { authGuard } from './modules/auth/service.js';
import { healthRoutes } from './modules/health/routes.js';
import { chatRoutes } from './modules/chat/routes.js';
import { knowledgeRoutes } from './modules/knowledge/routes.js';
import { assetRoutes, resolveConversationSiteBundleRoot } from './modules/assets/routes.js';
import { mcpRoutes } from './modules/mcp/routes.js';
import { orchestrationRoutes, getOrchestrator } from './modules/orchestration/routes.js';
import {experienceRoutes} from './modules/experience/routes.js';
import { projectSiteRoutes } from './modules/orchestration/project-application-routes.js';
import { providerRoutes } from './modules/providers/routes.js';
import { remoteRoutes } from './modules/remote/routes.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { skillRoutes } from './modules/skills/routes.js';
import { workspaceRoutes } from './modules/workspace/routes.js';
import { dataRoutes, publicDataAppRoutes, createManagedAppQueries } from './modules/data/routes.js';
import { chatMobileRoutes, publicChatMobileRoutes } from './modules/chat-mobile/routes.js';
import { templateTaskRoutes } from './modules/tasks/routes.js';
import { voiceRoutes } from './modules/voice/routes.js';

export async function createApp() {
  const app = Fastify({ logger: true });
  const staticRoot = process.env.WORKMATE_WEB_STATIC_DIR?.trim();
  await app.register(cors, { origin: false });
  // Preview tools map conversation mode to archived SITE bundles (no workspace hydrate).
  setConversationSiteBundleResolver(async (conversationId) => resolveConversationSiteBundleRoot(conversationId));
  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(publicDataAppRoutes, { prefix: '/api' });
  await app.register(publicChatMobileRoutes, { prefix: '/api' });
  await app.register(projectSiteRoutes, { prefix: '/api', orchestrator: getOrchestrator,
    dataApp: async (projectId, owner) => (await createManagedAppQueries()).projectApp(projectId, owner) });
  await app.register(async (secured) => {
    secured.addHook('preHandler', authGuard());
    await secured.register(chatRoutes, { prefix: '/api' });
    await secured.register(knowledgeRoutes, { prefix: '/api' });
    await secured.register(mcpRoutes, { prefix: '/api' });
    await secured.register(assetRoutes, { prefix: '/api' });
    await secured.register(providerRoutes, { prefix: '/api' });
    await secured.register(remoteRoutes, { prefix: '/api' });
    await secured.register(settingsRoutes, { prefix: '/api' });
    await secured.register(experienceRoutes, {prefix:'/api',store:()=>getOrchestrator().store});
    await secured.register(skillRoutes, { prefix: '/api' });
    await secured.register(workspaceRoutes, { prefix: '/api' });
    await secured.register(dataRoutes, { prefix: '/api' });
    await secured.register(chatMobileRoutes, { prefix: '/api' });
    await secured.register(orchestrationRoutes, { prefix: '/api/orch' });
    await secured.register(templateTaskRoutes, { prefix: '/api' });
    await secured.register(voiceRoutes, { prefix: '/api' });
  });
  if (staticRoot) {
    const indexFile = path.join(staticRoot, 'index.html');
    if (!fs.existsSync(indexFile)) {
      throw new Error(`WORKMATE_WEB_STATIC_DIR is missing index.html: ${indexFile}`);
    }
    await app.register(fastifyStatic, {
      root: staticRoot,
      wildcard: false,
      prefix: '/',
      index: false,
    });
    app.get('/', async (_request, reply) => reply.sendFile('index.html'));
    app.setNotFoundHandler(async (request, reply) => {
      const target = request.raw.url || '/';
      if (request.method === 'GET' && !target.startsWith('/api')) {
        return reply.type('text/html; charset=utf-8').send(fs.readFileSync(indexFile, 'utf8'));
      }
      return reply.code(404).send({ message: 'Not Found' });
    });
  }
  return app;
}
