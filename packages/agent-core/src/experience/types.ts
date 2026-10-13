/** Shared local-first experience cards; author provenance is retained for future scope policies. */

export type ExperienceRecord = {
  id: string;
  agentId: string;
  userId?: string;
  orgId?: string;
  syncState?: 'skipped'|'queued'|'submitted'|'synced'|'failed';
  syncTarget?: string;
  revision?: string;
  /** Short title for browsing / logging. */
  title: string;
  /** When this experience applies. */
  situation: string;
  /** What worked / recommended approach. */
  action: string;
  /** Pitfalls to avoid. */
  pitfall: string;
  /** When NOT to apply this experience. */
  whenNot: string;
  tags: string[];
  /** Embedding text (situation + action + pitfall). */
  embedText: string;
  vector: number[];
  quality: number;
  hitCount: number;
  createdAt: number;
  updatedAt: number;
};

export type ExperienceHit = {
  id: string;
  title: string;
  situation: string;
  action: string;
  pitfall: string;
  whenNot: string;
  tags: string[];
  score: number;
};

export const EXPERIENCE_LIMITS = {
  title: 80,
  situation: 220,
  action: 420,
  pitfall: 220,
  whenNot: 160,
  tags: 6,
  tagLen: 24,
  /** Only inject / return hits at or above this cosine-like score. */
  minScore: 0.82,
  /** Near-duplicate merge threshold on embed text. */
  dedupeScore: 0.92,
  maxPerAgent: 400,
} as const;

export function formatExperienceCard(item: Pick<ExperienceRecord | ExperienceHit, 'title' | 'situation' | 'action' | 'pitfall' | 'whenNot'>) {
  const lines = [
    `Title: ${item.title}`,
    `Situation: ${item.situation}`,
    `Action: ${item.action}`,
  ];
  if (item.pitfall.trim()) lines.push(`Pitfall: ${item.pitfall}`);
  if (item.whenNot.trim()) lines.push(`When not: ${item.whenNot}`);
  return lines.join('\n');
}

export function buildEmbedText(input: {
  title: string;
  situation: string;
  action: string;
  pitfall?: string;
  whenNot?: string;
  tags?: string[];
}) {
  return [
    input.title,
    input.situation,
    input.action,
    input.pitfall || '',
    input.whenNot || '',
    (input.tags || []).join(' '),
  ].filter(Boolean).join('\n').trim();
}
