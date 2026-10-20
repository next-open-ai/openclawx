/**
 * Session rolling memory helpers.
 *
 * Transcript (`ChatSession.messages`) is the source of truth. `session.memory`
 * is a derived rolling summary with a watermark (`coveredUntilId`).
 *
 * @module @openclawx/orchestrator/session-memory
 */

import {
  SESSION_MEMORY_BUDGET_CHARS,
  SESSION_MEMORY_KEEP_RECENT,
  sessionSummaryMessagePair,
  summarizeSessionMemory,
} from '@openclawx/agent-core';
import type { ModelConfig } from '@openclawx/contracts';
import type { ChatMessage, ChatSession, SessionMemory } from './types.js';

export type ModelTurn = import('@openclawx/contracts').ChatModelMessage;

/** Canonical non-empty messages in conversation order. */
export function canonicalTurns(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => !message.superseded && message.content.trim().length > 0);
}

/** Messages strictly after the watermark (or all if watermark missing). */
export function uncoveredMessages(messages: ChatMessage[], coveredUntilId?: string): ChatMessage[] {
  const turns = canonicalTurns(messages);
  if (!coveredUntilId) return turns;
  const index = turns.findIndex((message) => message.id === coveredUntilId);
  if (index < 0) return turns;
  return turns.slice(index + 1);
}

export function estimateSessionMemoryChars(summary: string, uncovered: ChatMessage[]): number {
  const body = uncovered.map((message) => message.content).join('\n');
  return (summary?.length || 0) + body.length;
}

export function shouldRollSessionMemory(input: {
  summary: string;
  uncovered: ChatMessage[];
  force?: boolean;
  budgetChars?: number;
  keepRecent?: number;
}): boolean {
  const keepRecent = input.keepRecent ?? SESSION_MEMORY_KEEP_RECENT;
  const budget = input.budgetChars ?? SESSION_MEMORY_BUDGET_CHARS;
  const { summary, uncovered } = input;
  if (uncovered.length <= keepRecent && estimateSessionMemoryChars(summary, uncovered) < budget) {
    return false;
  }
  if (input.force) return uncovered.length > keepRecent;
  return estimateSessionMemoryChars(summary, uncovered) >= budget;
}

/**
 * Assemble model-facing history: optional summary pair + uncovered (or full) turns.
 * Excludes the in-flight empty assistant placeholder for `turnId` when provided.
 */
export function buildSessionModelMessages(
  session: ChatSession,
  options: { turnId?: string } = {},
): ModelTurn[] {
  const visible = canonicalTurns(session.messages).filter((message) => {
    if (!options.turnId) return true;
    if (message.turnId !== options.turnId) return true;
    return message.role === 'user';
  });

  const memory = session.memory;
  // Bounded original-image window, independent of the text summary watermark.
  const recentImageIds = new Set(visible.flatMap((message) => message.attachments ?? []).slice(-4).map((image) => image.id));
  const toTurn = (message: ChatMessage): ModelTurn => ({
    role: message.role, content: message.content + (message.attachmentContext ? `\n\n${message.attachmentContext}` : '') + (message.attachments?.some((image) => !recentImageIds.has(image.id))
      ? '\n[部分早期图片已超出最近4张原图窗口，若需检查其细节，请用户重新上传，不得仅凭之前描述声称看到了原图。]' : ''),
    ...(message.attachments?.length ? { attachments: message.attachments.filter((image) => recentImageIds.has(image.id)) } : {}),
  });
  const summary = memory?.summary?.trim() || '';
  if (!summary || !memory?.coveredUntilId) {
    return visible.map(toTurn);
  }

  const uncovered = uncoveredMessages(visible, memory.coveredUntilId);
  const pinned = visible.filter((message) => !uncovered.includes(message) && message.attachments?.some((image) => recentImageIds.has(image.id)));
  return [
    ...sessionSummaryMessagePair(summary),
    ...pinned.map(toTurn),
    ...uncovered.map(toTurn),
  ];
}

export type RollSessionMemoryResult = {
  memory: SessionMemory;
  rolled: boolean;
};

/**
 * Roll older uncovered turns into `session.memory.summary` when over budget
 * (or when `force` and there is excess beyond the recent window).
 */
export async function rollSessionMemory(input: {
  session: ChatSession;
  model: ModelConfig;
  force?: boolean;
  summarize?: typeof summarizeSessionMemory;
}): Promise<RollSessionMemoryResult> {
  const summarize = input.summarize ?? summarizeSessionMemory;
  const previous = input.session.memory;
  const summary = previous?.summary?.trim() || '';
  const uncovered = uncoveredMessages(input.session.messages, previous?.coveredUntilId);

  if (!shouldRollSessionMemory({ summary, uncovered, force: input.force })) {
    const memory: SessionMemory = previous
      ? { ...previous, dirty: uncovered.length > 0, updatedAt: previous.updatedAt }
      : { summary: '', coveredUntilId: '', updatedAt: Date.now(), dirty: uncovered.length > 0 };
    return { memory, rolled: false };
  }

  const keepRecent = SESSION_MEMORY_KEEP_RECENT;
  let older = uncovered.slice(0, Math.max(0, uncovered.length - keepRecent));
  if (!older.length && uncovered.length > 1) {
    older = uncovered.slice(0, Math.ceil(uncovered.length / 2));
  }
  if (!older.length) {
    return {
      memory: previous ?? { summary: '', coveredUntilId: '', updatedAt: Date.now(), dirty: false },
      rolled: false,
    };
  }

  const nextSummary = await summarize({
    model: input.model,
    previousSummary: summary || undefined,
    turns: older.map((message) => ({ role: message.role, content: message.content })),
  });
  if (!nextSummary?.trim()) {
    return {
      memory: {
        summary,
        coveredUntilId: previous?.coveredUntilId || '',
        updatedAt: previous?.updatedAt || Date.now(),
        dirty: true,
      },
      rolled: false,
    };
  }

  const coveredUntilId = older[older.length - 1]!.id;
  const remaining = uncoveredMessages(input.session.messages, coveredUntilId);
  return {
    memory: {
      summary: nextSummary.trim(),
      coveredUntilId,
      updatedAt: Date.now(),
      dirty: remaining.length > 0,
    },
    rolled: true,
  };
}
