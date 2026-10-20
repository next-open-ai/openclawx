import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeJsonLine, parseCozeSseData } from '../code-execution-backends.js';
import { getExecutionBackend } from '../execution-backend.js';
import '../execution-backends.js';

test('OpenCode and Claude Code register as native execution backends', () => {
  assert.equal(getExecutionBackend('opencode')?.capabilities.coding, true);
  assert.equal(getExecutionBackend('claude-code')?.capabilities.processIsolated, true);
  assert.equal(getExecutionBackend('coze-workflow')?.label, 'Coze Workflow Integration');
});

test('Coze workflow SSE exposes answer text and filters protocol markers', () => {
  assert.equal(parseCozeSseData(JSON.stringify({ data: { content: 'answer' } })), 'answer');
  assert.equal(parseCozeSseData(JSON.stringify({ msg_type: 'generate_answer_finish', data: { content: 'internal' } })), '');
  assert.equal(parseCozeSseData('[DONE]'), '');
});

test('Claude Code stream-json assistant and result events are normalized', () => {
  assert.equal(parseClaudeJsonLine(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Read' }] },
  })), 'hello');
  assert.equal(parseClaudeJsonLine(JSON.stringify({ type: 'result', result: 'done' })), 'done');
  assert.equal(parseClaudeJsonLine('not-json'), '');
});
