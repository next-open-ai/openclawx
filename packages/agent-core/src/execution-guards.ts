import type { AgentTool } from '@mariozechner/pi-agent-core';

export function combinedExecutionSignal(external: AbortSignal, internal?: AbortSignal): AbortSignal {
  return internal ? AbortSignal.any([external, internal]) : external;
}

/** Admission happens before tool code, including tools that ignore AbortSignal. */
export function guardToolBudget(tools: AgentTool[], limit: number, onExceeded: () => void): AgentTool[] {
  let admitted = 0;
  let exceeded = false;
  return tools.map((tool) => ({ ...tool, execute: async (id, args, signal, update) => {
    signal?.throwIfAborted();
    if (admitted >= limit) {
      if (!exceeded) { exceeded = true; onExceeded(); }
      throw new Error(`Tool execution budget exceeded (${limit}).`);
    }
    admitted += 1;
    return tool.execute(id, args, signal, update);
  } }));
}

export const MATERIAL_TASK_CONTRACT = [
  'Material-driven workflow: use the supplied inputs, project files, upstream results and explicitly authorized data tools only.',
  'Do not search the user home directory, unrelated projects or other local disks to fill missing business data. Do not substitute quotes, budgets or proposals for actual revenue.',
  'If required data is absent after reading the supplied material, stop exploring. State the exact missing data and provide only the analysis/framework supported by the evidence. Ask the user to supply the missing source; never invent amounts or claim a financial analysis is complete.',
  'A useful, truthful missing-data explanation is a valid node response. Do not force a PDF or repeated shell probing when the evidence cannot support the requested report.',
  'Use load_skill, read_skill_file and run_skill_script for authorized Skill resources outside the project; their existing approval rules still apply. Do not use native read/bash to bypass that boundary.',
].join('\n');


export function toolFailureText(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return typeof result === 'string' ? result : undefined;
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  return content?.filter((item) => item.type === 'text' && item.text).map((item) => item.text).join('\n') || undefined;
}
