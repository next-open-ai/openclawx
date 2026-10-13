import type { ModelConfig } from '@workmate/contracts';
import { Type } from '@sinclair/typebox';
import { defineAgentTool, type AgentTool } from '../pi-tools.js';
import { currentExperienceContext,withExperienceContext } from './context.js';
import { loadExperience, saveExperience } from './service.js';
import { EXPERIENCE_LIMITS, formatExperienceCard } from './types.js';

/**
 * Native experience tools. Agent ID and trusted user context are captured by the host.
 */
export function createExperienceTools(input: {
  agentId: string;
  model?: ModelConfig;
  enabled?: boolean;
  minScore?: number;
}): AgentTool[] {
  const agentId = String(input.agentId || '').trim();
  const ctx=currentExperienceContext();
  if (!agentId || input.enabled === false || ctx===null || ctx?.settings.enabled===false) return [];

  const minScore = input.minScore ?? EXPERIENCE_LIMITS.minScore;

  return [
    defineAgentTool({
      name: 'save_experience',
      description:
        'Save a short reusable experience to the local shared experience pool after a meaningful complex task '
        + '(successful approach, hard-won pitfall, or durable project convention). '
        + 'User and agent provenance are recorded by the host. Keep fields concise. Never include credentials, private business data or raw chat logs. Skip trivial one-shot answers.',
      parameters: Type.Object({
        title: Type.String({ minLength: 2, maxLength: EXPERIENCE_LIMITS.title }),
        situation: Type.String({ minLength: 8, maxLength: EXPERIENCE_LIMITS.situation, description: 'When this experience applies.' }),
        action: Type.String({ minLength: 8, maxLength: EXPERIENCE_LIMITS.action, description: 'What worked / recommended steps.' }),
        pitfall: Type.Optional(Type.String({ maxLength: EXPERIENCE_LIMITS.pitfall, description: 'What to avoid.' })),
        whenNot: Type.Optional(Type.String({ maxLength: EXPERIENCE_LIMITS.whenNot, description: 'When NOT to apply this.' })),
        tags: Type.Optional(Type.Array(Type.String({ maxLength: EXPERIENCE_LIMITS.tagLen }), { maxItems: EXPERIENCE_LIMITS.tags })),
      }),
      execute: async ({ title, situation, action, pitfall, whenNot, tags }) => {
        try {
          const saved = await withExperienceContext(ctx,()=>saveExperience({
            agentId,
            title,
            situation,
            action,
            pitfall,
            whenNot,
            tags,
            model: input.model,
          }));
          return {
            ok: true,
            id: saved.id,
            merged: saved.merged,
            backend: saved.backend,
            title: saved.title,
            mirrorSaved:saved.mirrorSaved,
            mirrorState:saved.mirrorState,
            syncState:saved.syncState,
          };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : 'Failed to save experience.',
          };
        }
      },
    }),
    defineAgentTool({
      name: 'load_experience',
      description:
        'Load shared experiences across users and agents. Local text matching is immediate; completed knowledge semantic cache may enrich results. '
        + 'The backend states text versus semantic; never claim text matching is vector retrieval. '
        + 'Use when starting or pivoting a complex task that may match prior work.',
      parameters: Type.Object({
        query: Type.String({ minLength: 2, maxLength: 400 }),
        topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
      }),
      execute: async ({ query, topK }) => {
        try {
          const loaded = await withExperienceContext(ctx,()=>loadExperience({
            agentId,
            query,
            topK,
            minScore,
            model: input.model,
          }));
          return {
            ok: true,
            count: loaded.count,
            minScore: loaded.minScore,
            backend: loaded.backend,
            results: loaded.results.map((item) => ({
              id: item.id,
              score: item.score,
              card: formatExperienceCard(item),
              tags: item.tags,
            })),
          };
        } catch (error) {
          return {
            ok: false,
            count: 0,
            results: [],
            message: error instanceof Error ? error.message : 'Failed to load experience.',
          };
        }
      },
    }),
  ];
}
