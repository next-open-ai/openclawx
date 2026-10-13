import type { ModelConfig } from '@workmate/contracts';
import {currentExperienceContext} from './context.js';

/** Optional knowledge enrichment uses only the host's config-stage availability state.
 * Local save/load remain enabled independently; no network health probing here.
 */

export type ExperienceRecallReadyReason = 'ok' | 'knowledge-unavailable';

export type ExperienceRecallReadiness = {
  ok: boolean;
  reason: ExperienceRecallReadyReason;
};

/** Sync read of the trusted runtime gate; model credentials do not imply availability. */
export function getExperienceRecallReadiness(input: {
  model?: ModelConfig;
}): ExperienceRecallReadiness {
  if (!currentExperienceContext()?.settings.available || !currentExperienceContext()?.target) {
    return { ok: false, reason: 'knowledge-unavailable' };
  }
  return { ok: true, reason: 'ok' };
}

/** @deprecated no-op kept for call-site compatibility after saves */
export function invalidateExperienceRecallReadiness(_agentId?: string) {
  /* readiness is supplied by host configuration; nothing to probe */
}

/** @deprecated no-op — circuit breaker removed in favor of global config gate */
export function noteExperienceEmbedSuccess(_embedKey?: string) {
  /* intentionally empty */
}

/** @deprecated no-op — circuit breaker removed in favor of global config gate */
export function noteExperienceEmbedFailure(_embedKey?: string) {
  /* intentionally empty */
}

/** @deprecated no-op kept for tests */
export function resetExperienceRecallReadinessState() {
  /* intentionally empty */
}
