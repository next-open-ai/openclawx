import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ModelConfig } from '@openclawx/contracts';
import { embedOpenAiCompatible } from '../embedding-http.js';

type EmbedConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export function resolveExperienceEmbed(model?: ModelConfig): EmbedConfig | null {
  // Prefer dedicated embedding connection fields (global vector model in Settings).
  const embeddingModel = String(model?.embeddingModel || '').trim();
  const baseUrl = String(model?.embeddingBaseUrl || model?.baseUrl || '').replace(/\/$/, '');
  const apiKey = String(model?.embeddingApiKey || model?.apiKey || '');
  if (!baseUrl || !embeddingModel) return null;
  const provider = String(model?.provider || '');
  // When embedding uses its own key/url, treat missing key like ollama only if
  // the chat provider is ollama and we fell back to chat credentials.
  const usingChatCreds = !model?.embeddingBaseUrl && !model?.embeddingApiKey;
  if (usingChatCreds && provider !== 'ollama' && provider !== 'openai-compatible' && !apiKey.trim()) return null;
  if (!usingChatCreds && !apiKey.trim() && !/ollama/i.test(baseUrl) && provider !== 'openai-compatible') return null;
  return { baseUrl, apiKey: apiKey.trim(), model: embeddingModel };
}

export async function embedExperienceTexts(config: EmbedConfig, inputs: string[]): Promise<number[][]> {
  const result = await embedOpenAiCompatible(config, inputs);
  return result.vectors;
}

export function cosine(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readJsonFile<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(file: string, value: unknown) {
  ensureDir(path.dirname(file));
  writeFileSync(file, JSON.stringify(value, null, 0), 'utf8');
}
