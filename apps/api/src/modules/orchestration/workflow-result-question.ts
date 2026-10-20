import { workflowResultReferenceSchema } from '@openclawx/contracts';
import type { Orchestrator } from '@openclawx/orchestrator';
import type { AuthPrincipal } from '../auth/service.js';
import { WorkflowRuns } from './workflow-runs.js';

/** The caller supplies only a reference. Evidence and read-only policy are server-owned. */
export async function resolveWorkflowResultQuestion(orch: Orchestrator, owner: AuthPrincipal, sessionId: string, body: { workflowResult?: unknown; attachments?: unknown[]; fileAttachments?: unknown[] }) {
  if (body.workflowResult === undefined) return {};
  const reference = workflowResultReferenceSchema.safeParse(body.workflowResult);
  if (!reference.success || body.attachments?.length || body.fileAttachments?.length) throw new Error('WORKFLOW_RESULT_INVALID');
  return {
    workflowResult: reference.data,
    attachmentContext: await new WorkflowRuns(orch).questionContext(owner, sessionId, reference.data),
    responseMode: 'text-only' as const,
    rejectIfActive: true,
  };
}
