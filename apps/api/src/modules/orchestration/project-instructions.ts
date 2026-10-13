import type { FastifyInstance } from 'fastify';
import { ProjectInstructionSchema } from '@workmate/contracts';
import { withKeyLock, type Orchestrator, type ConfirmProjectInput } from '@workmate/orchestrator';
import { requireAuth } from '../auth/service.js';
import { canWriteOwnedResource } from '../auth/ownership.js';
import { saveChatFile } from './chat-attachments.js';
import { materializeWorkflowFiles, workflowFileScope } from './workflow-files.js';

export function registerProjectInstructionRoutes(app: FastifyInstance, orch: Orchestrator) {
  app.post('/projects/:projectId/uploads/:requestId', { bodyLimit: 26 * 1024 * 1024 }, async (request, reply) => {
    const auth = requireAuth(request);
    const { projectId, requestId } = request.params as { projectId: string; requestId: string };
    const project = await orch.projects.getProject(projectId);
    if (!project || !canWriteOwnedResource(project, auth, { allowLegacyUnowned: true })) return reply.code(404).send({ message: '项目不可用或没有编辑权限' });
    if (project.executionWorkspaceMode === 'isolated' && project.kind !== 'conversation') return reply.code(400).send({ message: '此类隔离数据应用项目暂不支持参考文档上传，请使用文字描述要求' });
    if (!ProjectInstructionSchema.safeParse({ employeeId: 'upload', content: 'upload', requestId }).success) return reply.code(400).send({ message: '上传标识无效' });
    try {
      const name = decodeURIComponent(String(request.headers['x-workmate-file-name'] || ''));
      if (!/\.(pdf|docx|pptx|ppsx|xlsx|xls|csv|md|txt|html|htm)$/i.test(name) || !Buffer.isBuffer(request.body)) throw new Error('请选择支持的文档文件');
      return await saveChatFile(workflowFileScope(auth, `project:${projectId}`, requestId), { name, bytes: request.body });
    } catch (cause) { return reply.code(400).send({ message: cause instanceof Error ? cause.message : '上传失败' }); }
  });
  app.post('/projects/:projectId/instructions', async (request, reply) => {
    const auth = requireAuth(request);
    const { projectId } = request.params as { projectId: string };
    const parsed = ProjectInstructionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: '请输入问题并选择有效的项目员工；文档或请求标识无效' });
    try {
      // Serialise admission and material staging. ProjectService retains the domain lock.
      return await withKeyLock(`project-instruction:${projectId}`, async () => {
        const project = await orch.projects.getProject(projectId);
        if (!project || !canWriteOwnedResource(project, auth, { allowLegacyUnowned: true })) return reply.code(404).send({ message: '项目不可用或没有编辑权限' });
        if (project.status === 'running') return reply.code(409).send({ message: '项目正在执行，请等待完成或停止后再发送' });
        const input = parsed.data;
        if (input.fileIds.length && project.executionWorkspaceMode === 'isolated' && project.kind !== 'conversation') return reply.code(400).send({ message: '此类隔离数据应用项目暂不支持参考文档，请使用文字描述要求' });
        if (project.kind !== 'conversation' && !project.tasks.some(task => task.employeeId === input.employeeId && task.status !== 'superseded')) return reply.code(400).send({ message: '所选员工不在当前项目中' });
        if (input.fileIds.length && !project.workspacePath) return reply.code(400).send({ message: '项目尚未配置工作目录，无法接收文档' });
        const materials = await materializeWorkflowFiles(workflowFileScope(auth, `project:${projectId}`, input.requestId ?? ''), input.fileIds, project.workspacePath ?? '', input.requestId ?? '', input.content, true);
        const body = (request.body ?? {}) as ConfirmProjectInput;
        const result = await orch.projects.dispatchInstruction(projectId, { employeeId: input.employeeId, employeeLabel: input.employeeLabel, content: input.content + materials.prompt }, {
          ...(project.kind === 'conversation' ? {} : { runContextByTask: body.runContextByTask, defaultContext: body.defaultContext, summaryContext: body.summaryContext }),
        });
        if (!result) return reply.code(404).send({ message: '项目不存在' });
        return result;
      });
    } catch (cause) { return reply.code(400).send({ message: cause instanceof Error ? cause.message : '发送失败，请重试' }); }
  });
}
