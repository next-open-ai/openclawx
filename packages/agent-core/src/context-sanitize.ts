import type { AgentMessage } from '@mariozechner/pi-agent-core';

/**
 * Per-turn context hygiene (see docs/architecture/context-hygiene.md).
 * Runs inside Agent.transformContext before the next LLM call.
 */

const WRITE_TOOLS = new Set(['write_workspace_file']);
const READ_TOOLS = new Set(['read_workspace_file', 'read_skill_file', 'fetch_skill_url']);
const SCRIPT_TOOLS = new Set([
  'run_workspace_script',
  'run_skill_script',
  'install_python_dependency',
  'render_pdf_report',
]);

/** Generic tool-result text cap after hygiene. */
export const MAX_TOOL_RESULT_CHARS = 2_500;
/** Read / fetch body cap. */
export const MAX_READ_RESULT_CHARS = 2_000;
/** Script stdout/stderr head + tail kept in the wrapped envelope. */
export const MAX_SCRIPT_HEAD_CHARS = 900;
export const MAX_SCRIPT_TAIL_CHARS = 400;

export interface ContextAnchors {
  goal: string;
  writtenPaths: string[];
  errors: string[];
}

function byteHint(value: unknown) {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (Array.isArray(value)) {
    return value.reduce((sum: number, item) => sum + (typeof item === 'string' ? Buffer.byteLength(item) : 0), 0);
  }
  return 0;
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const item = block as { type?: string; text?: string; thinking?: string };
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Drop thinking/reasoning blocks from assistant messages (keep text + toolCall). */
export function stripThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || (message as { role?: string }).role !== 'assistant') {
      return message;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    const next = content.filter((block) => {
      if (!block || typeof block !== 'object') return true;
      const type = (block as { type?: string }).type;
      return type !== 'thinking';
    });
    if (next.length === content.length) return message;
    return { ...(message as object), content: next } as AgentMessage;
  });
}

/**
 * Replace write_workspace_file bodies with path-only stubs.
 * Never use `_omittedBody` — models treat that as a transport failure.
 */
export function stubWriteArgs(args: Record<string, unknown>): Record<string, unknown> {
  const path = typeof args.path === 'string' ? args.path : '(unknown)';
  const mode = args.mode === 'append' ? 'append' : 'replace';
  const bytes = byteHint(args.content) + byteHint(args.chunks);
  return {
    path,
    mode,
    deliverable: args.deliverable,
    status: 'written',
    bytes,
    contextPolicy: 'path-only',
    hint: 'On-disk write succeeded. File body is intentionally absent from model context — do NOT treat as a failed write; do NOT rewrite unless you need to change this file.',
  };
}

function stubWritePayloads(messages: AgentMessage[]): AgentMessage[] {
  const successful = new Set(messages.filter(message => {
    if (!message || typeof message !== 'object' || message.role !== 'toolResult' || message.isError || !WRITE_TOOLS.has(message.toolName)) return false;
    return tryParseJsonObject(messageText(message))?.ok === true;
  }).map(message => (message as { toolCallId: string }).toolCallId));
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || (message as { role?: string }).role !== 'assistant') {
      return message;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    let changed = false;
    const nextContent = content.map((block) => {
      if (!block || typeof block !== 'object') return block;
      const item = block as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
      if (item.type !== 'toolCall' || !item.name || !item.arguments || typeof item.arguments !== 'object') return block;
      const args = item.arguments;

      if (WRITE_TOOLS.has(item.name) && item.id && successful.has(item.id)) {
        const hasBody = (typeof args.content === 'string' && args.content.length > 0)
          || (Array.isArray(args.chunks) && args.chunks.some((c) => typeof c === 'string' && c.length > 0));
        if (!hasBody && (args.contextPolicy === 'path-only' || args.status === 'written')) return block;
        if (!hasBody) return block;
        changed = true;
        return { ...item, arguments: stubWriteArgs(args) };
      }

      return block;
    });
    return changed ? { ...(message as object), content: nextContent } as AgentMessage : message;
  });
}

function clipHeadTail(text: string, head = MAX_SCRIPT_HEAD_CHARS, tail = MAX_SCRIPT_TAIL_CHARS) {
  if (text.length <= head + tail + 40) return text;
  return `${text.slice(0, head)}\n…[${text.length - head - tail} chars omitted]…\n${text.slice(-tail)}`;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Wrap script/command tool results so the model can label them without eating the window. */
export function formatCommandResultEnvelope(toolName: string, text: string): string {
  const parsed = tryParseJsonObject(text);
  const ok = parsed && typeof parsed.ok === 'boolean' ? parsed.ok : undefined;
  const exitCode = parsed && 'exitCode' in parsed ? parsed.exitCode : undefined;
  const stdout = parsed && typeof parsed.stdout === 'string' ? parsed.stdout : '';
  const stderr = parsed && typeof parsed.stderr === 'string' ? parsed.stderr : '';
  const error = parsed && typeof parsed.error === 'string' ? parsed.error : '';
  const artifacts = parsed && Array.isArray(parsed.artifacts)
    ? parsed.artifacts.filter((item): item is string => typeof item === 'string').slice(0, 12)
    : [];
  const path = parsed && typeof parsed.path === 'string' ? parsed.path : '';

  const lines = [
    '[command-result]',
    `tool: ${toolName}`,
  ];
  if (ok !== undefined) lines.push(`ok: ${ok}`);
  if (exitCode !== undefined && exitCode !== null) lines.push(`exitCode: ${String(exitCode)}`);
  if (path) lines.push(`path: ${path}`);
  if (artifacts.length) lines.push(`artifacts: ${artifacts.join(', ')}`);
  if (error) {
    lines.push('--- error ---');
    lines.push(clipHeadTail(error, 600, 200));
  }
  if (stdout) {
    lines.push('--- stdout ---');
    lines.push(clipHeadTail(stdout));
  }
  if (stderr) {
    lines.push('--- stderr ---');
    lines.push(clipHeadTail(stderr));
  }
  if (!stdout && !stderr && !error && parsed) {
    // Structured but not a classic script payload — keep a short JSON digest.
    const digest = JSON.stringify({
      ok: parsed.ok,
      exitCode: parsed.exitCode,
      path: parsed.path,
      package: parsed.package,
      message: typeof parsed.message === 'string' ? parsed.message.slice(0, 200) : undefined,
    });
    lines.push('--- digest ---');
    lines.push(digest);
  } else if (!parsed) {
    lines.push('--- output ---');
    lines.push(clipHeadTail(text));
  }
  lines.push('[/command-result]');
  return lines.join('\n');
}

function truncateToolResultText(text: string, limit: number) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars — do not re-dump full contents into the next tool call]`;
}

function wrapAndTruncateToolResults(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || (message as { role?: string }).role !== 'toolResult') {
      return message;
    }
    const toolName = String((message as { toolName?: string }).toolName || '');
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    let changed = false;
    const nextContent = content.map((block) => {
      if (!block || typeof block !== 'object') return block;
      const item = block as { type?: string; text?: string };
      if (item.type !== 'text' || typeof item.text !== 'string') return block;
      let text = item.text;

      if (text.includes('[command-result]')) {
        // Already hygienized in a prior turn.
        const next = truncateToolResultText(text, MAX_TOOL_RESULT_CHARS + 800);
        if (next !== text) {
          changed = true;
          return { ...item, text: next };
        }
        return block;
      }

      const looksLikeCommandPayload = SCRIPT_TOOLS.has(toolName)
        || (/\b"stdout"\s*:/.test(text) && /\b"stderr"\s*:/.test(text));

      if (looksLikeCommandPayload) {
        text = formatCommandResultEnvelope(toolName || 'command', text);
      } else if (WRITE_TOOLS.has(toolName)) {
        const parsed = tryParseJsonObject(text);
        if (parsed && typeof parsed.path === 'string') {
          text = JSON.stringify({
            ok: parsed.ok !== false,
            path: parsed.path,
            bytes: parsed.bytes,
            totalBytes: parsed.totalBytes,
            mode: parsed.mode,
            deliverable: parsed.deliverable,
            contextPolicy: 'path-only',
          });
        }
      } else if (toolName==='search_work_results'||toolName==='read_work_result'||toolName==='read_document') {
        // Preserve IDs and valid JSON. Cutting raw JSON would make a found file unusable.
        if(text.length>32_000){
          try{
            const value=JSON.parse(text);if(toolName==='read_document'&&value.info)value.info.truncated=true;else value.truncated=true;
            if(Array.isArray(value.items))value.items=value.items.slice(0,10);
            if(typeof value.text==='string')value.text=value.text.slice(0,8000);
            text=JSON.stringify(value);
            while(text.length>32_000&&value.text?.length){value.text=value.text.slice(0,Math.floor(value.text.length/2));text=JSON.stringify(value);}
            if(text.length>32_000)text=JSON.stringify({ok:false,code:'WORK_RESULT_TOO_LARGE',spokenSummary:'成果结果过大，请缩小查询范围。'});
          }catch{text=JSON.stringify({ok:false,code:'WORK_INVALID_RESULT',spokenSummary:'成果结果无法解析，请重试。'});}
        }
      } else if (['data_get_schema', 'data_list_objects', 'data_query', 'data_app_register_query', 'data_app_register_sql', 'data_app_test_query', 'data_app_propose_schema','data_save_query_asset','data_list_query_assets','data_run_query_asset'].includes(toolName)) {
        text = truncateToolResultText(text, 16_000);
      } else if (READ_TOOLS.has(toolName)) {
        text = truncateToolResultText(text, MAX_READ_RESULT_CHARS);
      } else {
        text = truncateToolResultText(text, MAX_TOOL_RESULT_CHARS);
      }

      if (text === item.text) return block;
      changed = true;
      return { ...item, text };
    });
    return changed ? { ...(message as object), content: nextContent } as AgentMessage : message;
  });
}

/** Deterministic facts preserved across compaction (not subject to LLM loss). */
export function extractContextAnchors(messages: AgentMessage[]): ContextAnchors {
  const writtenPaths = new Set<string>();
  const errors: string[] = [];
  let goal = '';

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = (message as { role?: string }).role;

    if (role === 'user' && !goal) {
      const text = messageText(message).trim();
      if (text && !text.startsWith('[OpenClawX context summary]')) {
        goal = text.length > 800 ? `${text.slice(0, 800)}…` : text;
      }
    }

    if (role === 'toolResult') {
      const toolName = String((message as { toolName?: string }).toolName || '');
      const isError = Boolean((message as { isError?: boolean }).isError);
      const text = messageText(message);
      const parsed = tryParseJsonObject(text);
      if (!isError && parsed?.ok === true && (WRITE_TOOLS.has(toolName) || toolName === 'finish_workspace_write' || toolName === 'finish_artifact_source_write') && typeof parsed.path === 'string') {
        writtenPaths.add(parsed.path);
      }
      if (!isError && parsed?.ok === true && Array.isArray(parsed.artifacts)) {
        for (const artifact of parsed.artifacts) {
          if (typeof artifact === 'string' && artifact) writtenPaths.add(artifact);
        }
      }
      if (isError || (parsed && parsed.ok === false)) {
        const err = parsed && typeof parsed.error === 'string'
          ? parsed.error
          : text.slice(0, 240);
        if (err) errors.push(`${toolName || 'tool'}: ${err}`.slice(0, 280));
      }
    }
  }

  return {
    goal,
    writtenPaths: [...writtenPaths].slice(-40),
    errors: errors.slice(-12),
  };
}

export function formatAnchorsBlock(anchors: ContextAnchors): string {
  const lines = ['[context-anchors]'];
  if (anchors.goal) {
    lines.push('goal:');
    lines.push(anchors.goal);
  }
  if (anchors.writtenPaths.length) {
    lines.push(`writtenPaths: ${anchors.writtenPaths.join(', ')}`);
  }
  if (anchors.errors.length) {
    lines.push('recentErrors:');
    for (const err of anchors.errors) lines.push(`- ${err}`);
  }
  lines.push('[/context-anchors]');
  return lines.join('\n');
}

/**
 * Full per-turn hygiene: strip thinking, path-only writes, wrap/truncate tool results.
 * Returns sanitized messages (anchors can be extracted separately for compaction).
 */
export function sanitizeToolPayloadsInMessages(messages: AgentMessage[]): AgentMessage[] {
  return wrapAndTruncateToolResults(stubWritePayloads(stripThinkingBlocks(messages)));
}

/** @deprecated Alias — prefer sanitizeToolPayloadsInMessages / prepare name in callers. */
export const hygienizeAgentMessages = sanitizeToolPayloadsInMessages;
