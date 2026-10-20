import { workflowDefinitionSchema, type WorkflowDefinition } from '@workmate/contracts';
import type { ProjectDraftResult } from '../../app/project-planning';

/** A planner draft has index-based edges. Validate them before mapping to durable IDs. */
export function workflowFromPlan(
  base: Pick<WorkflowDefinition, 'id' | 'name' | 'description'>,
  tasks: ProjectDraftResult['tasks'],
  employeeIds: string[],
): WorkflowDefinition {
  const ids = tasks.map(() => crypto.randomUUID());
  const nodes = tasks.map((task, taskIndex) => {
    if (!employeeIds.includes(task.employeeId)) throw new Error('规划包含未选择的员工，请重新规划或手动调整');
    if ((task.dependsOn ?? []).some(index => !Number.isInteger(index) || index < 0 || index >= tasks.length)) throw new Error('规划中的步骤依赖无效');
    return {
      id: ids[taskIndex], title: task.title, employeeId: task.employeeId,
      objective: task.objective, dependsOn: (task.dependsOn ?? []).map(index => ids[index]),
      acceptance: [task.contract?.acceptance, task.contract?.outputs?.length ? `交付物：${task.contract.outputs.join('、')}` : ''].filter(Boolean).join('\n'),
    };
  });
  return workflowDefinitionSchema.parse({ ...base, nodes });
}

/** Materialize a fresh project graph, never retain reactive definition references or grant skills. */
export function materializeWorkflow(definition: WorkflowDefinition, employeeIds: string[], input: string) {
  const validated = workflowDefinitionSchema.parse(definition);
  if (validated.nodes.some(node => !node.integration && !employeeIds.includes(node.employeeId))) throw new Error('工作流包含已移除的员工，请先编辑');
  const ids = new Map(validated.nodes.map(node => [node.id, crypto.randomUUID()]));
  return {
    name: validated.name,
    goal: `${validated.description || validated.name}\n本次要求：${input.trim() || '按工作流定义执行'}`,
    mode: 'dag' as const,
    tasks: validated.nodes.map(node => ({
      id: ids.get(node.id)!, title: node.title, employeeId: node.employeeId,
      objective: `${node.objective}\n\n本次运行的补充业务要求：\n${input.trim() || '无'}`,
      skillIds: [] as string[], dependsOn: node.dependsOn.map(id => ids.get(id)!),
      ...(node.acceptance ? { contract: { acceptance: node.acceptance } } : {}),
    })),
  };
}
