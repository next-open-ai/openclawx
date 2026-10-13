import type { ProjectMessage } from './types.js';
import type { RunTextDeltaPosition } from '@workmate/contracts';
import type { RunActivity, RunApproval, RunRecord, RunStatus } from './types.js';

/**
 * Unified orchestration event pushed over the in-process hub to watchers
 * (SSE for desktop UI and, later, the channel/relay gateways).
 */

export type OrcEvent =
  /* runs */
  | { type: 'run.started'; runId: string; sessionId: string; kind: 'chat' | 'project-task'; taskId?: string; attemptNo: number; engine?: 'pi' | 'agentscope' | 'dsh' }
  | { type: 'run.engine'; runId: string; sessionId: string; engine: 'pi' | 'agentscope' | 'dsh' }
  | ({ type: 'run.reasoning.delta'; runId: string; sessionId: string; text: string } & RunTextDeltaPosition)
  | ({ type: 'run.delta'; runId: string; sessionId: string; text: string } & RunTextDeltaPosition)
  | { type: 'run.activity'; runId: string; activity: RunActivity }
  | { type: 'run.approval'; runId: string; approval: RunApproval }
  | { type: 'run.artifact'; runId: string; artifact: { path: string } }
  | { type: 'project.file.published'; runId: string; path: string; projectPath: string; projectId?: string }
  | { type: 'run.sources'; runId: string; sources: RunRecord['sources'] }
  | { type: 'run.usage'; runId: string; sessionId: string; usage: NonNullable<RunRecord['usage']>; model?: RunRecord['model'] }
  | { type: 'run.settled'; runId: string; sessionId: string; status: RunStatus; error?: string; failure?: import('@workmate/contracts').RunFailure }
  /* chat sessions */
  | { type: 'session.updated'; sessionId: string }
  | { type: 'session.deleted'; sessionId: string }
  /* projects */
  | { type: 'project.updated'; projectId: string }
  | { type: 'project.task'; projectId: string; taskId: string; status: string; runId?: string }
  | { type: 'project.message'; projectId: string; message: ProjectMessage };

export type OrcTopic = `run:${string}` | `session:${string}` | `project:${string}` | 'approvals';
