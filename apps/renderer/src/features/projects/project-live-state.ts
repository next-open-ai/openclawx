import type { ProjectMessage } from '../../app/projects.js';
import type { ProjectTaskTranscript } from '../../app/workspace.js';
import type { ServerProject, OrcEvent, OrchSubscribeOptions } from '../../services/orchestration.js';

/** Server snapshots own membership; only the current running attempt may retain uncheckpointed UI data. */
export function mergeProjectMessages(server: ServerProject, previous: ProjectMessage[] = []): ProjectMessage[] {
  const known = new Map(previous.map(message => [message.id, message]));
  const messages: ProjectMessage[] = server.messages.map(message => ({
    ...known.get(message.id), ...message,
    runId: message.runId ?? known.get(message.id)?.runId ?? server.activeRunId,
    assets: known.get(message.id)?.assets ?? [],
    activities: known.get(message.id)?.activities ?? [],
  }));
  const ids = new Set(messages.map(message => message.id));
  const liveRuns = new Set(server.tasks.filter(task => task.status === 'running').map(task => task.runId));
  if (server.status === 'running') for (const message of previous) {
    if (message.role === 'assistant' && liveRuns.has(message.id) && !ids.has(message.id)) messages.push(message);
  }
  return messages.sort((a, b) => a.createdAt - b.createdAt);
}

/** A polling checkpoint may lag SSE, but terminal records are always authoritative. */
export function mergeLiveTranscript(incoming: ProjectTaskTranscript, previous: ProjectTaskTranscript | undefined, running: boolean): ProjectTaskTranscript {
  if (!running || !previous || incoming.runId !== previous.runId) return incoming;
  const text = (next: string, old: string) => old.startsWith(next) ? old : next;
  const activities = incoming.activities.map(activity => ({ ...activity }));
  for (const old of previous.activities) {
    const index = activities.findIndex(activity => old.invocationId
      ? activity.invocationId === old.invocationId
      : !activity.invocationId && activity.toolName === old.toolName && activity.startedAt === old.startedAt);
    if (index < 0) activities.push(old);
    else if (old.status !== 'running' && activities[index].status === 'running') activities[index] = old;
  }
  return { ...incoming, assistantContent: text(incoming.assistantContent, previous.assistantContent),
    reasoningContent: text(incoming.reasoningContent ?? '', previous.reasoningContent ?? ''), activities };
}

type Subscribe = (id: string, listener: (event: OrcEvent) => void, options: OrchSubscribeOptions) => () => void;

export function appendProjectDelta(current: string, delta: string, offset?: number): string {
  if (offset == null || !Number.isInteger(offset) || offset < 0) return current + delta;
  if (offset > current.length) return current; // A missed prefix is recovered by the next checkpoint.
  const covered = current.length - offset;
  return covered >= delta.length ? current : current + delta.slice(covered);
}
export interface ProjectStream { ready: Promise<void>; activate(): void; stop(): void }

/** Subscribe before admission, buffer until the accepted server snapshot is adopted. Never block on SSE. */
export function openProjectStream(id: string, subscribe: Subscribe, onEvent: (event: OrcEvent) => void, timeoutMs = 1500): ProjectStream {
  let active = false; let stopped = false; const pending: OrcEvent[] = [];
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const timer = setTimeout(resolveReady, timeoutMs);
  const settle = () => { clearTimeout(timer); resolveReady(); };
  const unsubscribe = subscribe(id, event => {
    if (stopped) return;
    if (active) onEvent(event);
    else { pending.push(event); if (pending.length > 256) pending.shift(); }
  }, { onStatus: () => settle() });
  return { ready,
    activate() { if (stopped) return; active = true; for (const event of pending.splice(0)) onEvent(event); },
    stop() { stopped = true; pending.length = 0; settle(); unsubscribe(); },
  };
}
