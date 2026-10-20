import path from 'node:path';
import os from 'node:os';

/** Root for agent experience stores (independent from knowledge bases). */
export function experienceRoot() {
  const fromEnv = process.env.OPENCLAWX_EXPERIENCE_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const knowledge = process.env.OPENCLAWX_KNOWLEDGE_DIR?.trim();
  if (knowledge) return path.resolve(path.dirname(knowledge), 'experience');
  return path.join(os.homedir(), '.openclawx', 'experience');
}

export function experienceDirForAgent(agentId: string) {
  const safe = String(agentId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 120) || 'unknown';
  return path.join(experienceRoot(), safe);
}
