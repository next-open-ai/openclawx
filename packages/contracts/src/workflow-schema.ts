import { z } from 'zod';

const text = z.string().trim().min(1);
export const workflowNodeSchema = z.object({
  id: z.string().uuid(),
  title: text.max(120),
  employeeId: text.max(120),
  objective: text.max(12000),
  dependsOn: z.array(z.string().uuid()).max(30).default([]),
  acceptance: z.string().trim().max(4000).default(''),
});
export const workflowDefinitionSchema = z.object({
  id: z.string().uuid(),
  name: text.max(120),
  description: z.string().trim().max(4000).default(''),
  nodes: z.array(workflowNodeSchema).min(1).max(30),
}).superRefine((value, context) => {
  const nodes = new Map(value.nodes.map(node => [node.id, node]));
  if (nodes.size !== value.nodes.length) context.addIssue({ code: 'custom', message: '步骤 ID 不能重复', path: ['nodes'] });
  const visited = new Set<string>(); const active = new Set<string>();
  function visit(id: string): boolean {
    if (active.has(id)) return false;
    if (visited.has(id)) return true;
    const node = nodes.get(id);
    if (!node) return false;
    active.add(id);
    for (const dependency of node.dependsOn) if (!visit(dependency)) return false;
    active.delete(id); visited.add(id); return true;
  }
  if (value.nodes.some(node => !visit(node.id))) context.addIssue({ code: 'custom', message: '步骤依赖不存在或形成循环，请调整依赖', path: ['nodes'] });
});
export const algorithmDefinitionSchema = z.object({
  id: z.string().uuid(),
  name: text.max(120),
  description: text.max(4000),
  skillId: text.max(200),
  version: text.max(80).default('1.0.0'),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type AlgorithmDefinition = z.infer<typeof algorithmDefinitionSchema>;

export const workflowUploadParamsSchema = z.object({ id: z.string().uuid(), requestId: z.string().uuid() });
export const workflowInvocationInputSchema = z.object({
  requestId: z.string().uuid(), input: z.string().trim().max(12000).default(''),
  fileIds: z.array(z.string().uuid()).max(10).default([]).refine(ids => new Set(ids).size === ids.length, '附件不能重复'),
}).strict();
export const workflowInvocationResultSchema = z.object({ projectId: z.string().uuid() });
export const workflowInvocationSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat'), sessionId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('project'), projectId: z.string().uuid() }).strict(),
]);
export type WorkflowInvocationSource = z.infer<typeof workflowInvocationSourceSchema>;
export const workflowExecutionInputSchema = z.object({
  requestId: z.string().uuid(), input: z.string().trim().max(12000).default(''), workspacePath: text.max(4096),
  fileIds: z.array(z.string().uuid()).max(10).default([]).refine(ids => new Set(ids).size === ids.length, '附件不能重复'),
  source: workflowInvocationSourceSchema.optional(),
});
export const workflowExecutionSummarySchema = z.object({
  id: z.string().uuid(), workflowId: z.string().uuid(), workflowName: z.string(),
  projectId: z.string().uuid(), input: z.string(), createdAt: z.number(),
  documents: z.array(z.object({ name: z.string(), path: z.string() })).default([]),
  status: z.enum(['draft', 'running', 'waiting-approval', 'completed', 'failed', 'cancelled', 'unavailable']),
  elapsedMs: z.number(), completedTasks: z.number(), totalTasks: z.number(), attemptCount: z.number(), error: z.string().optional(),
  artifacts: z.array(z.object({ path: z.string(), runId: z.string().uuid().optional(), assetId: z.string().optional(), assetName: z.string().optional(), assetSizeBytes: z.number().optional(), partial: z.boolean() })),
  resultText: z.string().max(6000).optional(),
});
export type WorkflowInvocationInput = z.infer<typeof workflowInvocationInputSchema>;
export type WorkflowInvocationResult = z.infer<typeof workflowInvocationResultSchema>;
export type WorkflowExecutionInput = z.infer<typeof workflowExecutionInputSchema>;
export type WorkflowExecutionSummary = z.infer<typeof workflowExecutionSummarySchema>;

export const workflowResultReferenceSchema = z.object({
  invocationId: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const workflowResultEvidenceSchema = z.object({
  reference: workflowResultReferenceSchema, projectId: z.string().uuid(), workflowName: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled']), capturedAt: z.number(),
  text: z.string().max(24000), truncated: z.boolean(),
  files: z.array(z.object({ name: z.string(), path: z.string(), partial: z.boolean() })).max(50),
});
export type WorkflowResultReference = z.infer<typeof workflowResultReferenceSchema>;
export type WorkflowResultEvidence = z.infer<typeof workflowResultEvidenceSchema>;
