import type { UnifiedMessage } from '@openclawx/channel';
import { isAllowed, type GatewayConfig, type ThreadState } from './config.js';
import { OrchestratorClient } from './orch.js';

/**
 * Gateway runtime: maps a channel thread to an orchestrator chat session and
 * schedules normal chats + projects via /api/orch. Commands surface projects
 * (list/start/cancel/status) and approval decisions textually.
 */
export class GatewayRuntime {
  readonly client: OrchestratorClient;
  private readonly threads = new Map<string, ThreadState>();
  private readonly defaultEmployeeId: string;
  private readonly config: GatewayConfig;

  constructor(config: GatewayConfig) {
    this.config = config;
    this.defaultEmployeeId = config.defaultEmployeeId ?? 'general';
    this.client = new OrchestratorClient(config.apiBaseUrl ?? 'http://127.0.0.1:47832/api/orch');
  }

  async isAuthorized(message: UnifiedMessage): Promise<boolean> {
    return isAllowed(message, this.config);
  }

  async notifyUnregistered(): Promise<void> {
    /* no reply possible — nothing registered on that channel id */
  }

  async *process(message: UnifiedMessage): AsyncGenerator<string, void, undefined> {
    const text = message.messageText.trim();
    const threadKey = `${message.channelId}:${message.threadId}`;
    if (text.startsWith('/')) {
      yield* this.handleCommand(threadKey, message, text);
      return;
    }
    const thread = await this.ensureThread(threadKey);
    yield* this.chatReply(thread, text);
  }

  /* ------------------------------------------------------------------ *
   * Threads / sessions
   * ------------------------------------------------------------------ */

  private async ensureThread(threadKey: string, employeeId?: string): Promise<ThreadState> {
    const existing = this.threads.get(threadKey);
    if (existing) {
      if (employeeId && existing.employeeId !== employeeId) existing.employeeId = employeeId;
      return existing;
    }
    const effective = employeeId ?? this.defaultEmployeeId;
    const session = await this.client.createSession({ title: threadKey, employeeId: effective });
    const state: ThreadState = { sessionId: session.id, employeeId: effective };
    this.threads.set(threadKey, state);
    return state;
  }

  /* ------------------------------------------------------------------ *
   * Commands
   * ------------------------------------------------------------------ */

  private async *handleCommand(threadKey: string, message: UnifiedMessage, raw: string): AsyncGenerator<string, void, undefined> {
    const [command, ...args] = raw.slice(1).split(/\s+/).filter(Boolean);
    const arg = args.join(' ').trim();
    try {
      switch (command) {
        case 'help':
          yield this.helpText();
          return;
        case 'employee': {
          const employeeId = arg || this.defaultEmployeeId;
          await this.ensureThread(threadKey, employeeId);
          yield `已将本会话员工切换为 ${employeeId}。`;
          return;
        }
        case 'chat': {
          const thread = await this.ensureThread(threadKey);
          const content = arg || '继续';
          yield* this.chatReply(thread, content);
          return;
        }
        case 'approve':
        case 'deny': {
          const thread = this.threads.get(threadKey);
          if (!thread?.sessionId) {
            yield '没有进行中的审批（本会话尚未开始服务端会话）。';
            return;
          }
          const approvalId = arg;
          if (!approvalId) {
            yield '用法：/approve <审批ID>（或 /deny <审批ID>）。可用 /pending 查看。';
            return;
          }
          const before = await this.currentAssistant(thread.sessionId);
          await this.client.resolveApproval(thread.sessionId, approvalId, command === 'approve');
          if (command === 'approve') {
            const resumed = await this.awaitResumeText(thread.sessionId, before).catch(() => null);
            yield resumed ? `已允许审批 ${approvalId}，续跑结果：\n${resumed}` : `已允许审批 ${approvalId}，正在续跑…`;
          } else {
            yield `已拒绝审批 ${approvalId}。`;
          }
          return;
        }
        case 'pending': {
          const thread = this.threads.get(threadKey);
          if (!thread?.sessionId) {
            yield '本会话暂无服务端会话。';
            return;
          }
          const pending = await this.client.pendingApprovals(thread.sessionId);
          const lines = pending.flatMap((run) => run.approvals.map((a) => `- ${a.id}  [${a.capability}] ${a.summary}`));
          yield lines.length ? `待审批：\n${lines.join('\n')}` : '无待审批。';
          return;
        }
        case 'projects': {
          const projects = await this.client.listProjects();
          if (!projects.length) {
            yield '暂无项目。';
            return;
          }
          const lines = projects
            .filter((project) => project.status !== 'draft')
            .slice(0, 20)
            .map((project) => `- ${project.name} [${project.status}] id=${project.id}`);
          yield `项目（非草稿）：\n${lines.join('\n')}`;
          return;
        }
        case 'project': {
          const [sub, ...rest] = args;
          const target = rest.join(' ').trim();
          if (!sub) {
            yield this.helpText();
            return;
          }
          const id = target || sub;
          const project = await this.client.getProject(id);
          if (!project) {
            yield `找不到项目：${id}。`;
            return;
          }
          if (sub === 'start') {
            await this.client.confirmProject(id);
            yield `已启动项目「${project.name}」（服务端调度）。可用 /project ${project.id} 查看进度。`;
            return;
          }
          if (sub === 'cancel') {
            await this.client.cancelProject(id);
            yield `已取消项目「${project.name}」。`;
            return;
          }
          // status view
          const tasks = project.tasks.map((task) => `  ${task.status === 'completed' ? '✅' : task.status === 'running' ? '⏳' : task.status === 'failed' ? '❌' : '⬜'} ${task.title} [${task.status}]`).join('\n');
          const lines = [`项目：${project.name}`, `目标：${project.goal}`, `状态：${project.status}（${project.mode}）`, tasks || '  (无任务)', project.summary ? `汇总：${project.summary.slice(0, 300)}` : ''].filter(Boolean);
          yield lines.join('\n');
          return;
        }
        default:
          yield this.helpText();
      }
    } catch (error) {
      yield `命令执行失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /* ------------------------------------------------------------------ *
   * Chat runs (streamed from the session event stream)
   * ------------------------------------------------------------------ */

  private async *chatReply(thread: ThreadState, content: string): AsyncGenerator<string, void, undefined> {
    const sessionId = thread.sessionId;
    if (!sessionId) {
      yield '会话尚未初始化。';
      return;
    }
    const { runId } = await this.client.sendMessage(sessionId, content);
    // v1: deterministic terminal polling (SSE live deltas arrive in a later
    // iteration). Runs settle server-side; fetch final state afterwards.
    const settled = await this.waitRunSettled(sessionId, runId);
    if (!settled) {
      yield '（运行超时，未收到服务端终态）';
      return;
    }
    const session = await this.client.getSession(sessionId);
    const last = session?.messages.filter((m) => !m.superseded && m.role === 'assistant').at(-1);
    if (last?.content) yield last.content;
    const pending = await this.client.pendingApprovals(sessionId).catch(() => []);
    const open = pending.flatMap((run) => run.approvals.filter((a) => a.status === 'pending'));
    if (open.length) {
      const lines = open.map((a) => `⏸ [${a.id}] ${a.capability}: ${a.summary}`).join('\n');
      yield `\n\n${lines}\n回复 /approve <ID> 允许，/deny <ID> 拒绝，/pending 查看。`;
    }
    if (!last?.content) yield '（本轮未返回文本。）';
  }

  private async waitRunSettled(sessionId: string, runId: string): Promise<boolean> {
    const deadline = Date.now() + 3 * 60_000;
    while (Date.now() < deadline) {
      const runs = await this.client.getSessionRuns(sessionId).catch(() => []);
      const run = runs.find((item) => item.id === runId);
      if (run && run.status !== 'running') return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  private async currentAssistant(sessionId: string): Promise<string> {
    const session = await this.client.getSession(sessionId);
    return session?.messages.filter((m) => !m.superseded && m.role === 'assistant').at(-1)?.content ?? '';
  }

  /** After an approval is allowed the server re-runs the turn; wait for text. */
  private async awaitResumeText(sessionId: string, beforeContent: string): Promise<string | null> {
    const deadline = Date.now() + 2 * 60_000;
    while (Date.now() < deadline) {
      const pending = await this.client.pendingApprovals(sessionId).catch(() => []);
      const stillOpen = pending.some((run) => run.approvals.some((a) => a.status === 'pending'));
      const content = await this.currentAssistant(sessionId);
      if (!stillOpen && content !== beforeContent && content.trim()) return content;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return null;
  }

  private helpText(): string {
    return [
      '可用指令：',
      '/chat <内容> — 交给当前员工（普通对话）',
      '/employee <id> — 切换本会话员工',
      '/pending /approve <审批ID> /deny <审批ID> — 审批',
      '/projects — 项目列表',
      '/project <id> — 项目状态',
      '/project start <id> — 启动项目（服务端调度）',
      '/project cancel <id> — 取消运行',
      '/help — 帮助',
    ].join('\n');
  }
}
