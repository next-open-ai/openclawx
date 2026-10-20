import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { DecisionRuntimeConfig } from '@openclawx/contracts';
import { Type, defineAgentTool } from './pi-tools.js';

export type DecisionQuestion =
  | { type: 'choice'; instructions: string; options: string[] }
  | { type: 'score'; instructions: string; min?: number; max?: number }
  | { type: 'noul'; instructions: string };

export type DecisionResult = { ok: boolean; answers?: Record<string, unknown>; raw?: unknown; latencyMs: number; bypassed?: boolean; error?: string };

const SIDE_EFFECT_TOOL = /bash|write|delete|remove|commit|publish|send|email|message|execute|install|update|create|approve|payment|refund|database|sql/i;
const SECRET_KEY = /api.?key|token|secret|password|authorization|cookie|credential/i;
let circuitOpenUntil = 0;

function safeState(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (typeof value === 'string') return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeState(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 40).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : safeState(item, depth + 1)]));
}

function message(error: unknown) {
  const value = error as { message?: unknown; cause?: { code?: unknown; message?: unknown } };
  return [value?.message, value?.cause?.code, value?.cause?.message].filter(Boolean).map(String).join(' / ') || String(error);
}

export async function evaluateDecision(config: DecisionRuntimeConfig, state: unknown, questions: Record<string, DecisionQuestion>, signal?: AbortSignal): Promise<DecisionResult> {
  const started = Date.now();
  if (!config.enabled || config.mode === 'off') return { ok: true, bypassed: true, latencyMs: 0 };
  if (Date.now() < circuitOpenUntil) return { ok: config.failurePolicy === 'allow', bypassed: true, latencyMs: 0, error: 'Decision provider circuit is temporarily open.' };
  try {
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const response = await fetch(config.baseUrl, {
      method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ model: config.model, state, questions }),
    });
    const text = await response.text();
    let raw: any; try { raw = JSON.parse(text); } catch { raw = null; }
    if (!response.ok) throw new Error(`Decision provider HTTP ${response.status}: ${String(raw?.error?.message || raw?.message || text).slice(0, 500)}`);
    const answers = raw?.answers ?? raw?.results ?? raw?.decisions;
    if (!answers || typeof answers !== 'object') throw new Error('Decision provider returned no typed answers.');
    return { ok: true, answers, raw, latencyMs: Date.now() - started };
  } catch (error) {
    if (!signal?.aborted) circuitOpenUntil = Date.now() + 30_000;
    return { ok: config.failurePolicy === 'allow', bypassed: config.failurePolicy === 'allow', error: message(error), latencyMs: Date.now() - started };
  }
}

function answerValue(answer: unknown) {
  if (!answer || typeof answer !== 'object') return answer;
  const row = answer as Record<string, unknown>;
  return row.value ?? row.choice ?? row.answer ?? row.label;
}

export function createDecisionAgentTool(config?: DecisionRuntimeConfig): AgentTool[] {
  if (!config?.enabled || config.mode === 'off' || !config.agentTool) return [];
  return [defineAgentTool({
    name: 'decision_evaluate', label: '智能决策',
    description: 'Ask the configured bounded decision model to classify, score, or check a supplied state. Use only for finite choices and probabilistic judgments; it does not generate content or execute actions.',
    parameters: Type.Object({ state: Type.Any(), questions: Type.Record(Type.String(), Type.Any()) }),
    execute: async ({ state, questions }, { signal }) => evaluateDecision(config, state, questions as Record<string, DecisionQuestion>, signal),
  })];
}

export function guardAgentTools(tools: AgentTool[], config?: DecisionRuntimeConfig): AgentTool[] {
  if (!config?.enabled || config.mode === 'off' || !config.guardTools) return tools;
  return tools.map((tool) => {
    if (tool.name === 'decision_evaluate' || !SIDE_EFFECT_TOOL.test(tool.name)) return tool;
    return { ...tool, execute: async (callId: string, params: unknown, signal?: AbortSignal, onUpdate?: (value: unknown) => void) => {
      const decision = await evaluateDecision(config, { tool: tool.name, arguments: safeState(params) }, {
        risk: { type: 'choice', instructions: 'Classify the operation risk.', options: ['low', 'medium', 'high'] },
        allow: { type: 'noul', instructions: 'Should this operation proceed without additional human approval?' },
      }, signal);
      const risk = answerValue(decision.answers?.risk);
      const allow = answerValue(decision.answers?.allow);
      if (!decision.ok || (config.mode === 'enforce' && (risk === 'high' || allow === false))) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: decision.error || 'Decision guard blocked this tool call.', decision }) }], details: { ok: false, error: decision.error || 'Decision guard blocked this tool call.', decision } };
      }
      return tool.execute(callId, params as never, signal, onUpdate as never);
    } } as AgentTool;
  });
}
