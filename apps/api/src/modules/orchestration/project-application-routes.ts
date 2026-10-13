import type { FastifyInstance, FastifyReply, FastifyPluginAsync } from 'fastify';
import type { Orchestrator } from '@workmate/orchestrator';
import { PublishProjectApplicationSchema } from '@workmate/contracts';
import { requireAuth } from '../auth/service.js';
import { ApplicationError, projectApplications } from './project-application.js';
import { managedAppDocument } from '../data/app-query-page.js';
import type { AuthPrincipal } from '../auth/service.js';

function failure(reply: FastifyReply, cause: unknown) {
  if (cause instanceof ApplicationError) return reply.code(cause.status).send({ code: cause.code, message: cause.message });
  return reply.code(500).send({ code: 'APPLICATION_STORAGE_FAILED', message: '应用文件读取或保存失败，请检查磁盘空间和目录权限后重试。已发布版本不会自动更新。' });
}
export function registerProjectApplicationRoutes(app: FastifyInstance, orch: Orchestrator) {
  const service = projectApplications(orch);
  const base = '/projects/:projectId/application';
  app.get<{ Params: { projectId: string } }>(base, async (request, reply) => {
    try { return await service.status(requireAuth(request), request.params.projectId); }
    catch (cause) { return failure(reply, cause); }
  });
  for (const action of ['preview', 'view'] as const) {
    app.post<{ Params: { projectId: string } }>(`${base}/${action}`, async (request, reply) => {
      try { return await (action === 'preview' ? service.preview(requireAuth(request), request.params.projectId) : service.publishedView(requireAuth(request), request.params.projectId)); }
      catch (cause) { return failure(reply, cause); }
    });
  }
  app.post<{ Params: { projectId: string } }>(`${base}/publish`, async (request, reply) => {
    const parsed = PublishProjectApplicationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'APPLICATION_REQUEST_INVALID', message: '请先预览当前成果，再确认发布。' });
    try { return { published: await service.publish(requireAuth(request), request.params.projectId, parsed.data) }; }
    catch (cause) { return failure(reply, cause); }
  });
}

/** No session bearer in generated HTML. A narrow read-only ticket pins one snapshot. */
export const projectSiteRoutes: FastifyPluginAsync<{ orchestrator: () => Orchestrator; dataApp?: (projectId: string, owner: AuthPrincipal) => Promise<string | undefined> }> = async (app, options) => {
  app.get<{ Params: { ticket: string; '*': string } }>('/project-sites/:ticket/*', { logLevel: 'silent' }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Access-Control-Allow-Origin', '*')
      .header('Content-Security-Policy', "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'");
    try {
      const result = await projectApplications(options.orchestrator()).content(request.params.ticket, request.params['*']);
      if (result.type.startsWith('text/html') && await options.dataApp?.(result.projectId, result.principal)) return reply.type(result.type).send(managedAppDocument(result.bytes.toString('utf8')));
      return reply.type(result.type).send(result.bytes);
    } catch (cause) { return failure(reply, cause); }
  });
};
