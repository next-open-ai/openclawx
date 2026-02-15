import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Cron } from 'croner';
import { DatabaseService } from '../database/database.service.js';
import { AgentsService } from '../agents/agents.service.js';
import { ConfigService } from '../config/config.service.js';
import { UsageService } from '../usage/usage.service.js';

export type ScheduleType = 'once' | 'cron';

export interface RepeatRule {
    type: 'daily' | 'weekdays' | 'weekends' | 'weekly' | 'monthly';
    time: string;
    days?: number[];
    dayOfMonth?: number;
}

export interface ScheduledTask {
    id: string;
    workspace: string;
    message: string;
    scheduleType: ScheduleType;
    runAt?: number;
    cronExpr?: string;
    repeatRuleJson?: string;
    enabled: boolean;
    lastRunAt?: number;
    createdAt: number;
    updatedAt: number;
}

export type TaskExecutionStatus = 'success' | 'failed';

export interface TaskExecution {
    id: string;
    taskId: string;
    ranAt: number;
    status: TaskExecutionStatus;
    sessionId?: string;
    userMessage: string;
    assistantContent?: string;
    errorMessage?: string;
    createdAt: number;
}

interface ExecutionRow {
    id: string;
    task_id: string;
    ran_at: number;
    status: string;
    session_id: string | null;
    user_message: string;
    assistant_content: string | null;
    error_message: string | null;
    created_at: number;
}

interface TaskRow {
    id: string;
    workspace: string;
    message: string;
    schedule_type: string;
    run_at: number | null;
    cron_expr: string | null;
    repeat_rule_json: string | null;
    enabled: number;
    last_run_at: number | null;
    created_at: number;
    updated_at: number;
}

/** 将 repeatRule 转为 cron 表达式 */
export function repeatRuleToCron(rule: RepeatRule): string {
    const [h, m] = rule.time.split(':').map(Number);
    const minute = m ?? 0;
    const hour = h ?? 9;
    const timePart = `${minute} ${hour} * *`;
    switch (rule.type) {
        case 'daily':
            return `${minute} ${hour} * * *`;
        case 'weekdays':
            return `${minute} ${hour} * * 1-5`;
        case 'weekends':
            return `${minute} ${hour} * * 0,6`;
        case 'weekly':
            if (rule.days?.length) {
                return `${minute} ${hour} * * ${rule.days.sort((a, b) => a - b).join(',')}`;
            }
            return `${minute} ${hour} * * *`;
        case 'monthly': {
            const day = Math.min(rule.dayOfMonth ?? 1, 31);
            return `${minute} ${hour} ${day} * *`;
        }
        default:
            return `${minute} ${hour} * * *`;
    }
}

@Injectable()
export class TasksService implements OnModuleInit, OnModuleDestroy {
    private tickTimer: ReturnType<typeof setInterval> | null = null;
    private readonly TICK_MS = 60 * 1000;
    /** 正在执行中的 task id，避免同一任务在两次 tick 中并发执行 */
    private runningTaskIds = new Set<string>();

    constructor(
        private readonly db: DatabaseService,
        private readonly agentsService: AgentsService,
        private readonly configService: ConfigService,
        private readonly usageService: UsageService,
    ) {}

    onModuleInit(): void {
        this.tickTimer = setInterval(() => this.tick(), this.TICK_MS);
    }

    onModuleDestroy(): void {
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
    }

    private rowToTask(r: TaskRow): ScheduledTask {
        return {
            id: r.id,
            workspace: r.workspace,
            message: r.message,
            scheduleType: r.schedule_type as ScheduleType,
            runAt: r.run_at ?? undefined,
            cronExpr: r.cron_expr ?? undefined,
            repeatRuleJson: r.repeat_rule_json ?? undefined,
            enabled: r.enabled === 1,
            lastRunAt: r.last_run_at ?? undefined,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        };
    }

    list(): ScheduledTask[] {
        const rows = this.db.all<TaskRow>(
            'SELECT * FROM scheduled_tasks ORDER BY created_at DESC',
        );
        return rows.map((r) => this.rowToTask(r));
    }

    get(id: string): ScheduledTask | null {
        const r = this.db.get<TaskRow>('SELECT * FROM scheduled_tasks WHERE id = ?', [id]);
        return r ? this.rowToTask(r) : null;
    }

    private rowToExecution(r: ExecutionRow): TaskExecution {
        return {
            id: r.id,
            taskId: r.task_id,
            ranAt: r.ran_at,
            status: r.status as TaskExecutionStatus,
            sessionId: r.session_id ?? undefined,
            userMessage: r.user_message,
            assistantContent: r.assistant_content ?? undefined,
            errorMessage: r.error_message ?? undefined,
            createdAt: r.created_at,
        };
    }

    addExecution(params: {
        taskId: string;
        ranAt: number;
        status: TaskExecutionStatus;
        sessionId?: string;
        userMessage: string;
        assistantContent?: string;
        errorMessage?: string;
    }): TaskExecution {
        const id = randomUUID();
        const now = Date.now();
        this.db.run(
            `INSERT INTO scheduled_task_executions (id, task_id, ran_at, status, session_id, user_message, assistant_content, error_message, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                params.taskId,
                params.ranAt,
                params.status,
                params.sessionId ?? null,
                params.userMessage,
                params.assistantContent ?? null,
                params.errorMessage ?? null,
                now,
            ],
        );
        return this.getExecution(id)!;
    }

    listExecutions(taskId: string): TaskExecution[] {
        const rows = this.db.all<ExecutionRow>(
            'SELECT * FROM scheduled_task_executions WHERE task_id = ? ORDER BY ran_at DESC',
            [taskId],
        );
        return rows.map((r) => this.rowToExecution(r));
    }

    getExecution(id: string): TaskExecution | null {
        const r = this.db.get<ExecutionRow>('SELECT * FROM scheduled_task_executions WHERE id = ?', [id]);
        return r ? this.rowToExecution(r) : null;
    }

    /** 删除指定任务的全部执行记录，返回删除条数 */
    deleteExecutionsByTaskId(taskId: string): number {
        const result = this.db.run('DELETE FROM scheduled_task_executions WHERE task_id = ?', [taskId]);
        return result.changes;
    }

    create(params: {
        workspace: string;
        message: string;
        scheduleType: ScheduleType;
        runAt?: number;
        cronExpr?: string;
        repeatRule?: RepeatRule;
    }): ScheduledTask {
        const id = randomUUID();
        const now = Date.now();
        let cronExpr = params.cronExpr ?? null;
        let runAt = params.runAt ?? null;
        if (params.scheduleType === 'cron' && params.repeatRule && !cronExpr) {
            cronExpr = repeatRuleToCron(params.repeatRule);
        }
        const repeatRuleJson = params.repeatRule
            ? JSON.stringify(params.repeatRule)
            : null;
        this.db.run(
            `INSERT INTO scheduled_tasks (id, workspace, message, schedule_type, run_at, cron_expr, repeat_rule_json, enabled, last_run_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
            [
                id,
                params.workspace,
                params.message,
                params.scheduleType,
                runAt,
                cronExpr,
                repeatRuleJson,
                now,
                now,
            ],
        );
        const task = this.get(id)!;
        return task;
    }

    update(
        id: string,
        updates: Partial<Pick<ScheduledTask, 'message' | 'enabled' | 'scheduleType' | 'runAt' | 'cronExpr' | 'repeatRuleJson'>>,
    ): ScheduledTask | null {
        const task = this.get(id);
        if (!task) return null;
        const now = Date.now();
        const message = updates.message ?? task.message;
        const enabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : (task.enabled ? 1 : 0);
        const scheduleType = (updates.scheduleType ?? task.scheduleType) as ScheduleType;
        const runAt =
            scheduleType === 'once'
                ? (updates.runAt ?? task.runAt ?? null)
                : null;
        const cronExpr =
            scheduleType === 'cron'
                ? (updates.cronExpr ?? task.cronExpr ?? null)
                : null;
        const repeatRuleJson =
            scheduleType === 'cron'
                ? (updates.repeatRuleJson ?? task.repeatRuleJson ?? null)
                : null;
        this.db.run(
            `UPDATE scheduled_tasks SET message = ?, enabled = ?, schedule_type = ?, run_at = ?, cron_expr = ?, repeat_rule_json = ?, updated_at = ? WHERE id = ?`,
            [message, enabled, scheduleType, runAt, cronExpr, repeatRuleJson, now, id],
        );
        return this.get(id);
    }

    delete(id: string): boolean {
        const result = this.db.run('DELETE FROM scheduled_tasks WHERE id = ?', [id]);
        return result.changes > 0;
    }

    /** 获取当前应执行的任务 */
    getDueTasks(at: Date): ScheduledTask[] {
        const atMs = at.getTime();
        const rows = this.db.all<TaskRow>(
            'SELECT * FROM scheduled_tasks WHERE enabled = 1',
        );
        const due: ScheduledTask[] = [];
        for (const r of rows) {
            const task = this.rowToTask(r);
            if (task.scheduleType === 'once') {
                // 单次：到点且尚未执行过（markRunStarted 会设 last_run_at，避免重复触发）
                if (task.runAt != null && task.runAt <= atMs && task.lastRunAt == null) {
                    due.push(task);
                }
            } else if (task.cronExpr) {
                try {
                    const cron = new Cron(task.cronExpr);
                    const ref = new Date(atMs - 2 * this.TICK_MS);
                    const next = cron.nextRun(ref);
                    const nextMs = next?.getTime();
                    // 仅当「本周期」尚未执行过才加入；且要求触发点已到（nextMs <= atMs），避免把下一分钟算进当前
                    const notYetRunForThisOccurrence =
                        task.lastRunAt == null || (nextMs != null && task.lastRunAt < nextMs);
                    const scheduledTimeHasPassed = nextMs != null && nextMs <= atMs;
                    const inCurrentTickWindow = nextMs != null && nextMs >= atMs - this.TICK_MS;
                    if (scheduledTimeHasPassed && inCurrentTickWindow && notYetRunForThisOccurrence) {
                        due.push(task);
                    }
                } catch {
                    // invalid cron, skip
                }
            }
        }
        return due;
    }

    /** 仅更新 last_run_at，不关单次任务。用于「开始执行」时立即占位，避免下一分钟 tick 重复触发同一任务。 */
    markRunStarted(id: string): void {
        const now = Date.now();
        this.db.run(
            'UPDATE scheduled_tasks SET last_run_at = ?, updated_at = ? WHERE id = ?',
            [now, now, id],
        );
    }

    markRan(id: string): void {
        const now = Date.now();
        const task = this.get(id);
        if (!task) return;
        if (task.scheduleType === 'once') {
            this.db.run(
                'UPDATE scheduled_tasks SET last_run_at = ?, enabled = 0, updated_at = ? WHERE id = ?',
                [now, now, id],
            );
        } else {
            this.db.run(
                'UPDATE scheduled_tasks SET last_run_at = ?, updated_at = ? WHERE id = ?',
                [now, now, id],
            );
        }
    }

    /** 每分钟触发：拉取到点任务，创建会话、写用户消息、请求 Gateway 执行，写执行记录，再 markRan */
    private async tick(): Promise<void> {
        const now = new Date();
        const nowMs = now.getTime();
        const due = this.getDueTasks(now);
        if (due.length === 0) return;
        const config = await this.configService.getConfig();
        const gatewayBase = config.gatewayUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
        for (const task of due) {
            if (this.runningTaskIds.has(task.id)) continue;
            this.runningTaskIds.add(task.id);
            const fixedSessionId = `scheduled-${task.id}`;
            // 立即更新 last_run_at，避免执行期间下一分钟 tick 再次把本任务判为 due 导致重复请求
            this.markRunStarted(task.id);
            try {
                const session = await this.agentsService.getOrCreateSession(fixedSessionId, {
                    agentId: task.workspace,
                    workspace: task.workspace,
                    title: `定时: ${task.message.slice(0, 30)}${task.message.length > 30 ? '…' : ''}`,
                    type: 'scheduled',
                });
                this.agentsService.appendMessage(session.id, 'user', task.message);
                // Agent 可能执行很久（如浏览器操作），需放宽超时，否则 undici 会报 HeadersTimeoutError
                const runTimeoutMs = 10 * 60 * 1000; // 10 分钟
                const res = await fetch(`${gatewayBase}/run-scheduled-task`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: fixedSessionId,
                        message: task.message,
                        agentId: session.agentId ?? task.workspace,
                        workspace: task.workspace,
                        taskId: task.id,
                        backendBaseUrl: `http://localhost:${process.env.PORT || 38081}`,
                    }),
                    signal: AbortSignal.timeout(runTimeoutMs),
                });
                const body = await res.json().catch(() => ({}));
                const assistantContent = body.assistantContent ?? '';
                const ok = res.ok && body.success !== false;
                if (ok && body.usage && (body.usage.promptTokens > 0 || body.usage.completionTokens > 0)) {
                    this.usageService.recordUsage({
                        sessionId: fixedSessionId,
                        source: 'scheduled_task',
                        taskId: task.id,
                        promptTokens: body.usage.promptTokens ?? 0,
                        completionTokens: body.usage.completionTokens ?? 0,
                    });
                }
                const execution = this.addExecution({
                    taskId: task.id,
                    ranAt: nowMs,
                    status: ok ? 'success' : 'failed',
                    sessionId: fixedSessionId,
                    userMessage: task.message,
                    assistantContent: ok ? assistantContent : undefined,
                    errorMessage: ok ? undefined : (body.error || `HTTP ${res.status}`),
                });
                if (ok) {
                    console.log(`[Tasks] 任务执行完成: ${task.id} (执行记录 ${execution.id})`);
                    this.markRan(task.id);
                } else {
                    console.error(`[Tasks] run-scheduled-task failed for ${task.id}: ${body.error || res.status}`);
                }
            } catch (e: any) {
                const errMsg = e?.message ?? String(e);
                this.addExecution({
                    taskId: task.id,
                    ranAt: nowMs,
                    status: 'failed',
                    sessionId: fixedSessionId,
                    userMessage: task.message,
                    errorMessage: errMsg,
                });
                console.error(`[Tasks] tick task ${task.id} error:`, e);
            } finally {
                this.runningTaskIds.delete(task.id);
            }
        }
    }
}
