import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import { lstat, realpath, readdir, open } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Orchestrator } from '@openclawx/orchestrator';
import { ProjectDraftFileQuerySchema, type ProjectDraftFiles } from '@openclawx/contracts';
import { requireAuth } from '../auth/service.js';
import { canReadOwnedResource } from '../auth/ownership.js';

const textFile = (name: string) => /\.(html?|css|[cm]?js|jsx|tsx?|json|md|txt|csv|ya?ml|xml|svg)$/i.test(name);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
/** Latest failed/running output is inspectable, but never promoted or served as active HTML. */
export function registerProjectDraftFileRoutes(app: FastifyInstance, orch: Orchestrator) {
  const base = '/projects/:projectId/runs/:runId';
  for (const action of ['draft-files', 'draft-file'] as const) {
    app.get<{ Params: { projectId: string; runId: string } }>(`${base}/${action}`, async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const auth = requireAuth(request), { projectId, runId } = request.params;
      const project = await orch.projects.getProject(projectId);
      const run = await orch.chat.getRun(runId);
      if (!project || project.kind !== 'conversation' || !canReadOwnedResource(project, auth) || !run || !canReadOwnedResource(run, auth) || run.sessionId !== projectId || !project.tasks.some(task => task.runId === runId && task.id === run.taskId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) {
        return reply.code(404).send({ message: '运行草稿不存在或无权访问。' });
      }
      const parent = path.resolve(process.env.OPENCLAWX_WORKSPACES_DIR || path.join(os.homedir(), '.openclawx', 'workspaces'));
      const root = path.join(parent, runId, 'output');
      const checked = async (relative = '') => {
        let target = parent;
        for (const part of [runId, 'output', ...relative.split('/').filter(Boolean)]) {
          target = path.join(target, part);
          if ((await lstat(target)).isSymbolicLink()) throw new Error('symlink');
        }
        const canonicalParent = await realpath(parent), canonical = await realpath(target);
        if (!canonical.startsWith(canonicalParent + path.sep)) throw new Error('escape');
        return target;
      };
      try {
        if (action === 'draft-file') {
          const query = ProjectDraftFileQuerySchema.safeParse(request.query);
          if (!query.success || !textFile(query.data.relative)) return reply.code(400).send({ message: '请选择可查看的草稿文本文件。' });
          const target = await checked(query.data.relative);
          const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return reply.code(400).send({ message: '草稿文件不是普通文件或超过2MB。' });
            const content = await handle.readFile();
            if (content.length > 2 * 1024 * 1024) return reply.code(400).send({ message: '草稿文件超过2MB。' });
            return { relative: query.data.relative, content: content.toString('utf8') };
          } finally { await handle.close(); }
        }
        const result: ProjectDraftFiles = { files: [], truncated: false };
        await checked();
        let visited = 0;
        async function walk(relative: string, depth: number): Promise<void> {
          if (depth > 12 || visited >= 1000) { result.truncated = true; return; }
          const directory = await checked(relative);
          for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            if (++visited > 1000 || result.files.length >= 500) { result.truncated = true; return; }
            if (entry.name.startsWith('.') || ['node_modules', 'inputs', 'tmp'].includes(entry.name) || entry.isSymbolicLink()) continue;
            const child = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) await walk(child, depth + 1);
            else if (entry.isFile() && textFile(entry.name) && (await lstat(await checked(child))).size <= 2 * 1024 * 1024) result.files.push({ relative: child, type: 'file' });
          }
        }
        await walk('', 0);
        return result;
      } catch (error) {
        if (missing(error)) return action === 'draft-files' ? { files: [], truncated: false } : reply.code(404).send({ message: '草稿文件尚未生成或已不存在。' });
        return reply.code(400).send({ message: '无法安全读取运行草稿，请检查文件或刷新重试。' });
      }
    });
  }
}
