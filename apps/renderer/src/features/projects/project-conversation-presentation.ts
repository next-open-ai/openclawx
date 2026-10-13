import type { ProjectMessage, ProjectTask } from '../../app/projects.js';

// Presentation only: retain the original thread for history and auditing.
const redundantNotices = new Set([
  '项目已就绪。发送问题开始工作，成果将保存在当前项目目录。',
  '已收到补充问题，正在原项目中继续处理。',
]);

export function visibleProjectMessages(messages: ProjectMessage[], conversation: boolean): ProjectMessage[] {
  if (!conversation) return messages;
  return messages.filter(message => message.role !== 'system' ||
    message.approvals?.length || message.activities?.length || message.assets?.length ||
    !redundantNotices.has(message.content));
}

export function projectMessageAuthor(role: ProjectMessage['role'], conversation: boolean): string | undefined {
  return role === 'user' ? '你' : role === 'system' ? conversation ? '系统' : '调度器' : undefined;
}

export function turnIssue(task: ProjectTask | undefined, content = ''): string {
  if (!task || !['failed', 'cancelled'].includes(task.status)) return '';
  const error = task.error || task.transcript?.error || (task.status === 'cancelled'
    ? '本轮已停止，已有成果保留。' : '本轮未完成，请查看运行诊断或重试。');
  return content.includes(error) ? '' : error;
}

export function conversationProgress(task: ProjectTask | undefined, awaitingApproval: boolean): string {
  if (awaitingApproval) return '等待你的批准';
  return task?.status === 'queued' ? '正在排队…' : '正在处理…';
}
