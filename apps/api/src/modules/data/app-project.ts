import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withKeyLock, type ProjectService } from '@workmate/orchestrator';
import type { DataAppProjectCreate, DataAppProjectExecution } from '@workmate/contracts';

type Owner = { orgId: string; userId: string };
type Database = { exec(sql: string, params?: unknown[]): Array<{ values?: unknown[][] }>; run(sql: string, params?: unknown[]): void };
export class AppProjectError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}

/** SQL stores stable associations/intent IDs; ProjectService exclusively owns execution. */
export class AppProjectCoordinator {
  constructor(private db: Database, private flush: () => void, private projects: ProjectService, private root: string) {}

  static migrate(db: Database) {
    db.run('CREATE TABLE IF NOT EXISTS data_app_project_requests (org_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, app_id TEXT NOT NULL, PRIMARY KEY (org_id, owner_user_id, request_id))');
    db.run('CREATE TABLE IF NOT EXISTS data_app_project_links (app_id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, employee_id TEXT NOT NULL, permission_tier TEXT NOT NULL, initial_start_attempted INTEGER NOT NULL DEFAULT 0)');
    db.run('CREATE TABLE IF NOT EXISTS data_app_project_operations (app_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY (app_id, request_id))');
  }

  projectId(appId: string) {
    const row = this.db.exec('SELECT project_id FROM data_app_project_links WHERE app_id = ?', [appId])[0]?.values?.[0];
    return row ? String(row[0]) : undefined;
  }

  async create(owner: Owner, input: DataAppProjectCreate, prepare: (id: string) => { name: string; prompt: string }) {
    return withKeyLock(`data-app-create:${owner.orgId}:${owner.userId}:${input.requestId}`, async () => {
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const row = this.db.exec('SELECT fingerprint, app_id FROM data_app_project_requests WHERE org_id = ? AND owner_user_id = ? AND request_id = ?', [owner.orgId, owner.userId, input.requestId])[0]?.values?.[0];
      if (row && row[0] !== fingerprint) throw new AppProjectError('该创建请求内容已变化，请重新提交。');
      const id = row ? String(row[1]) : randomUUID();
      if (!row) {
        this.db.run('INSERT INTO data_app_project_requests VALUES (?, ?, ?, ?, ?)', [owner.orgId, owner.userId, input.requestId, fingerprint, id]);
        this.flush();
      }
      const prepared = prepare(id);
      const projectId = await this.ensure(owner, id, prepared.name, prepared.prompt, input.employeeId, input.permissionTier, input.queryMode === 'managed-readonly');
      const attempted = this.db.exec('SELECT initial_start_attempted FROM data_app_project_links WHERE app_id = ?', [id])[0]?.values?.[0]?.[0];
      if (attempted) return { appId: id, projectId, started: false };
      // Persist intent before launch; after an uncertain crash, continue explicitly in this project.
      this.db.run('UPDATE data_app_project_links SET initial_start_attempted = 1 WHERE app_id = ?', [id]); this.flush();
      try {
        if (input.queryMode === 'managed-readonly') await this.projects.dispatchInstruction(projectId, { employeeId: input.employeeId, content: input.idea });
        else await this.projects.confirmProject(projectId);
        return { appId: id, projectId, started: true };
      }
      catch (cause) { return { appId: id, projectId, started: false, startError: cause instanceof Error ? cause.message : '启动失败，请在项目中继续。' }; }
    });
  }

  async ensure(owner: Owner, appId: string, name: string, prompt: string, employeeId: string, tier: 'read-only' | 'default' | 'full', conversation = false) {
    return withKeyLock(`data-app-link:${appId}`, () => this.ensureLocked(owner, appId, name, prompt, employeeId, tier, conversation));
  }

  private async ensureLocked(owner: Owner, appId: string, name: string, prompt: string, employeeId: string, tier: 'read-only' | 'default' | 'full', conversation: boolean) {
    const existing = this.projectId(appId);
    const projectId = existing || `data-app-${appId}`;
    if (existing) {
      const project = await this.projects.getProject(existing);
      if (!project) throw new AppProjectError('关联项目已删除，应用仍保留。请勿重复创建应用。', 410);
      if (project.orgId !== owner.orgId || (project.ownerUserId ?? project.userId) !== owner.userId) throw new AppProjectError('关联项目不存在或无权访问。', 404);
      return existing;
    }
    const workspacePath = path.join(this.root, projectId);
    fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
    await this.projects.createDraftOnce(projectId, {
      orgId: owner.orgId, ownerUserId: owner.userId, accessScope: 'private', name, goal: conversation ? prompt : `创建并持续优化数据应用「${name}」`,
      ...(conversation ? { kind: 'conversation' as const, defaultEmployeeId: employeeId } : {}),
      mode: 'waterfall', workspacePath, executionWorkspaceMode: 'isolated',
      tasks: [{ title: '创建、验证并交付应用', objective: prompt, employeeId, skillIds: [], permissionTier: tier,
        contract: { outputs: ['output/index.html'], acceptance: '页面使用真实数据网关，具备加载/空态/错误反馈；验证页面后通过 bind_data_app_custom_site 绑定原应用。', maxAttempts: 1 } }],
    });
    this.db.run('INSERT INTO data_app_project_links (app_id, project_id, employee_id, permission_tier) VALUES (?, ?, ?, ?)', [appId, projectId, employeeId, tier]);
    this.flush();
    return projectId;
  }

  async execute(owner: Owner, appId: string, requestId: string, idea: string, prompt: string): Promise<DataAppProjectExecution> {
    return withKeyLock(`data-app-execute:${appId}`, async () => {
      const fingerprint = createHash('sha256').update(idea).digest('hex');
      const prior = this.db.exec('SELECT fingerprint, result_json FROM data_app_project_operations WHERE app_id = ? AND request_id = ?', [appId, requestId])[0]?.values?.[0];
      if (prior) {
        if (prior[0] !== fingerprint) throw new AppProjectError('该执行请求内容已变化，请重新提交。');
        return JSON.parse(String(prior[1])) as DataAppProjectExecution;
      }
      const projectId = this.projectId(appId);
      if (!projectId) throw new AppProjectError('应用尚未关联项目。');
      const project = await this.projects.getProject(projectId);
      if (!project) throw new AppProjectError('关联项目已删除，应用仍保留。', 410);
      if (project.orgId !== owner.orgId || (project.ownerUserId ?? project.userId) !== owner.userId) throw new AppProjectError('关联项目不存在或无权访问。', 404);
      if (project.status === 'running') throw new AppProjectError('项目正在执行，请查看项目进度或先处理审批。');
      const result: DataAppProjectExecution = { appId, projectId, started: false, startError: '执行请求已准备；若上次启动中断，请在原项目中继续。' };
      this.db.run('INSERT INTO data_app_project_operations VALUES (?, ?, ?, ?)', [appId, requestId, fingerprint, JSON.stringify(result)]); this.flush();
      try {
        // Replace the single task's brief instead of accumulating stale Schema and all past HTML prompts.
        const task = project.tasks.find(item => item.status !== 'superseded');
        if (project.kind !== 'conversation') {
          if (!task) throw new Error('项目没有可执行任务。');
          await this.projects.replanProject(projectId, { tasks: [{ id: task.id, title: task.title, objective: prompt, employeeId: task.employeeId, skillIds: task.skillIds, permissionTier: task.permissionTier, contract: task.contract }], note: '使用最新数据说明继续应用工作' });
        }
        await this.projects.dispatchInstruction(projectId, { employeeId: project.defaultEmployeeId || task!.employeeId, content: idea });
        result.started = true; delete result.startError;
      } catch (cause) { result.startError = cause instanceof Error ? cause.message : '启动失败，请在原项目中继续。'; }
      this.db.run('UPDATE data_app_project_operations SET result_json = ? WHERE app_id = ? AND request_id = ?', [JSON.stringify(result), appId, requestId]); this.flush();
      return result;
    });
  }
}
