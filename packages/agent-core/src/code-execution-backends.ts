import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AgentEvent } from '@openclawx/contracts';
import type { ExecutionBackendStreamInput } from './execution-backend.js';

function setting(name: string): string {
  return String(process.env[name] || '').trim();
}

function promptFor(input: ExecutionBackendStreamInput): string {
  const prompt = input.messages.filter((message) => message.role === 'user').at(-1)?.content.trim();
  if (!prompt) throw new Error('Question is empty');
  return prompt;
}

function extractOpenCodeText(value: unknown): string {
  const body = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const data = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown>;
  const parts = data.parts as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(parts)) {
    return parts
      .filter((part) => !part.type || part.type === 'text')
      .map((part) => String(part.text || part.content || ''))
      .join('');
  }
  return typeof data.text === 'string' ? data.text : typeof data.content === 'string' ? data.content : '';
}

export function parseCozeSseData(data: string): string {
  const source = data.trim();
  if (!source || source === '[DONE]') return '';
  try {
    const event = JSON.parse(source) as Record<string, unknown>;
    const messageType = String(event.msg_type || '').toLowerCase();
    if (messageType === 'empty result' || messageType === 'generate_answer_finish') return '';
    const payload = (event.data && typeof event.data === 'object' ? event.data : event) as Record<string, unknown>;
    const text = typeof payload.content === 'string'
      ? payload.content
      : typeof payload.delta === 'string'
        ? payload.delta
        : '';
    return text.trim().startsWith('{') && text.includes('generate_answer_finish') ? '' : text;
  } catch {
    return '';
  }
}

export async function* streamCozeWorkflow(input: ExecutionBackendStreamInput): AsyncGenerator<AgentEvent> {
  const runId = input.runId || randomUUID();
  yield { type: 'run.started', runId, engine: 'coze-workflow' };
  const connectionId = input.profile.id.startsWith('integration:coze:') ? input.profile.id.slice('integration:coze:'.length) : 'default';
  const prefix = `OPENCLAWX_COZE_${connectionId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_`;
  const botId = setting(`${prefix}BOT_ID`) || setting('OPENCLAWX_COZE_BOT_ID');
  const apiKey = setting(`${prefix}API_KEY`) || setting('OPENCLAWX_COZE_API_KEY');
  if (!botId || !apiKey) throw new Error('Coze workflow node requires OPENCLAWX_COZE_BOT_ID and OPENCLAWX_COZE_API_KEY');
  const region = (setting(`${prefix}REGION`) || setting('OPENCLAWX_COZE_REGION')) === 'cn' ? 'cn' : 'com';
  const baseUrl = setting(`${prefix}BASE_URL`) || setting('OPENCLAWX_COZE_BASE_URL') || `https://api.coze.${region}`;
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v3/chat?bot_id=${encodeURIComponent(botId)}`, {
    method: 'POST', signal: input.abortSignal,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      bot_id: botId, user_id: input.profile.id, conversation_id: input.conversationId,
      stream: true, auto_save_history: true,
      additional_messages: [{ role: 'user', content: promptFor(input), content_type: 'text' }],
    }),
  });
  if (!response.ok) throw new Error(`Coze API failed (${response.status})`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Coze response stream is unavailable');
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.replace(/\r\n/g, '\n').split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const text = parseCozeSseData(line.slice(5));
      if (text) yield { type: 'message.delta', runId, text };
    }
  }
  yield { type: 'run.completed', runId };
}

const openCodeSessions = new Map<string, string>();

export async function* streamOpenCode(input: ExecutionBackendStreamInput): AsyncGenerator<AgentEvent> {
  const runId = input.runId || randomUUID();
  yield { type: 'run.started', runId, engine: 'opencode' };
  const baseUrl = (setting('OPENCLAWX_OPENCODE_BASE_URL') || 'http://127.0.0.1:4096').replace(/\/$/, '');
  const username = setting('OPENCLAWX_OPENCODE_USERNAME') || 'opencode';
  const password = setting('OPENCLAWX_OPENCODE_PASSWORD');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (password) headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const sessionKey = input.conversationId || input.profile.id;
  let sessionId = openCodeSessions.get(sessionKey);
  if (!sessionId) {
    const created = await fetch(`${baseUrl}/session`, { method: 'POST', headers, body: '{}', signal: input.abortSignal });
    if (!created.ok) throw new Error(`OpenCode session creation failed (${created.status})`);
    const result = await created.json() as Record<string, unknown>;
    sessionId = String(result.id || (result.data as Record<string, unknown> | undefined)?.id || '');
    if (!sessionId) throw new Error('OpenCode session response did not include an id');
    openCodeSessions.set(sessionKey, sessionId);
  }
  const model = setting('OPENCLAWX_OPENCODE_MODEL');
  const [providerID, ...modelParts] = model.split('/');
  const response = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message`, {
    method: 'POST', headers, signal: input.abortSignal,
    body: JSON.stringify({
      parts: [{ type: 'text', text: promptFor(input) }],
      ...(model && modelParts.length ? { model: { providerID, modelID: modelParts.join('/') } } : {}),
    }),
  });
  if (!response.ok) throw new Error(`OpenCode message failed (${response.status})`);
  const text = extractOpenCodeText(await response.json());
  if (!text) throw new Error('OpenCode returned an empty response');
  yield { type: 'message.delta', runId, text };
  yield { type: 'run.completed', runId };
}

export function parseClaudeJsonLine(line: string): string {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === 'result' && typeof event.result === 'string') return event.result;
    const message = event.message as Record<string, unknown> | undefined;
    const content = message?.content as Array<Record<string, unknown>> | undefined;
    return Array.isArray(content)
      ? content.filter((block) => block.type === 'text').map((block) => String(block.text || '')).join('')
      : '';
  } catch {
    return '';
  }
}

export async function* streamClaudeCode(input: ExecutionBackendStreamInput): AsyncGenerator<AgentEvent> {
  const runId = input.runId || randomUUID();
  yield { type: 'run.started', runId, engine: 'claude-code' };
  const binary = setting('OPENCLAWX_CLAUDE_CODE_BIN') || 'claude';
  const cwd = setting('OPENCLAWX_CLAUDE_CODE_CWD') || input.projectWorkspacePath || process.cwd();
  const child = spawn(binary, ['-p', promptFor(input), '--output-format', 'stream-json', '--verbose'], {
    cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const cancel = () => child.kill('SIGTERM');
  input.abortSignal?.addEventListener('abort', cancel, { once: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
  let buffer = '';
  for await (const chunk of child.stdout) {
    buffer += String(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const text = parseClaudeJsonLine(line);
      if (text) yield { type: 'message.delta', runId, text };
    }
  }
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  input.abortSignal?.removeEventListener('abort', cancel);
  if (input.abortSignal?.aborted) throw input.abortSignal.reason || new Error('Claude Code was cancelled');
  if (code !== 0) throw new Error(`Claude Code exited with ${code}: ${stderr.trim() || 'unknown error'}`);
  yield { type: 'run.completed', runId };
}
