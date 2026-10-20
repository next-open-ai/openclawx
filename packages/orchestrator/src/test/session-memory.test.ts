import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSessionModelMessages,
  estimateSessionMemoryChars,
  rollSessionMemory,
  shouldRollSessionMemory,
  uncoveredMessages,
} from '../session-memory.js';
import type { ChatSession } from '../types.js';
import { runContext } from './fake.js';

function sessionWith(messages: ChatSession['messages'], memory?: ChatSession['memory']): ChatSession {
  const now = Date.now();
  return {
    id: 's1',
    kind: 'chat',
    title: 't',
    employeeId: 'general',
    messages,
    memory,
    grantsSession: {},
    grantsAlways: {},
    createdAt: now,
    updatedAt: now,
  };
}

test('VIS-T2 original images survive summary watermark with bounded latest-four window', () => {
  const messages: ChatSession['messages'] = Array.from({ length: 6 }, (_, index) => ({
    id: `m${index}`, role: 'user', content: `图${index}`, createdAt: index,
    attachments: [{ id: `00000000-0000-4000-8000-00000000000${index}`, name: `${index}.png`, mimeType: 'image/png', size: 68 }],
  }));
  messages.push({ id: 'followup', role: 'user', content: '再看看原图', createdAt: 7 });
  const session = sessionWith(messages, { summary: '之前讨论图片', coveredUntilId: 'm5', updatedAt: 1, dirty: false });
  const result = buildSessionModelMessages(session);
  assert.deepEqual(result.flatMap((message) => message.attachments ?? []).map((image) => image.name), ['2.png', '3.png', '4.png', '5.png']);
  assert.equal(result.at(-1)?.content, '再看看原图');
  assert.equal(JSON.stringify(session.messages), JSON.stringify(messages));
});

test('uncoveredMessages slices after watermark', () => {
  const messages = [
    { id: 'm1', role: 'user' as const, content: 'a', createdAt: 1 },
    { id: 'm2', role: 'assistant' as const, content: 'b', createdAt: 2 },
    { id: 'm3', role: 'user' as const, content: 'c', createdAt: 3 },
  ];
  assert.deepEqual(uncoveredMessages(messages, 'm1').map((m) => m.id), ['m2', 'm3']);
  assert.deepEqual(uncoveredMessages(messages, 'missing').map((m) => m.id), ['m1', 'm2', 'm3']);
});

test('buildSessionModelMessages injects summary pair + uncovered only', () => {
  const session = sessionWith(
    [
      { id: 'm1', role: 'user', content: 'old user', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'old assistant', createdAt: 2 },
      { id: 'm3', role: 'user', content: 'new user', createdAt: 3 },
      { id: 'm4', role: 'assistant', content: 'new assistant', createdAt: 4 },
    ],
    {
      summary: 'Prior goals: ship memory',
      coveredUntilId: 'm2',
      updatedAt: 1,
      dirty: false,
    },
  );
  const modelMessages = buildSessionModelMessages(session);
  assert.equal(modelMessages[0]?.role, 'user');
  assert.match(modelMessages[0]?.content || '', /OpenClawX context summary/);
  assert.match(modelMessages[0]?.content || '', /Prior goals/);
  assert.equal(modelMessages[1]?.role, 'assistant');
  assert.deepEqual(
    modelMessages.slice(2).map((m) => m.content),
    ['new user', 'new assistant'],
  );
});

test('ATT-TEST-3 adds bounded extracted attachment context only to model messages', () => {
  const attachmentContext = '<attachment name="brief.md" kind="document">\n# Brief\nRevenue increased.\n</attachment>';
  const session = sessionWith([{
    id: 'file-turn', role: 'user', content: '请总结附件', createdAt: 1,
    fileAttachments: [{
      id: '00000000-0000-4000-8000-000000000001', name: 'brief.md', mimeType: 'text/markdown',
      size: 32, kind: 'document', status: 'ready', summary: '已读取 32 个字符', createdAt: 1,
    }],
    attachmentContext,
  }]);
  const result = buildSessionModelMessages(session);
  assert.match(result[0]?.content || '', /Revenue increased/);
  assert.equal(session.messages[0]?.content, '请总结附件');
  assert.equal(session.messages[0]?.fileAttachments?.[0]?.name, 'brief.md');
});

test('shouldRollSessionMemory respects budget and force window', () => {
  const short = [{ id: 'a', role: 'user' as const, content: 'hi', createdAt: 1 }];
  assert.equal(shouldRollSessionMemory({ summary: '', uncovered: short }), false);
  const bulky = Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: 'x'.repeat(2_000),
    createdAt: i,
  }));
  assert.equal(shouldRollSessionMemory({ summary: '', uncovered: bulky }), true);
  assert.equal(shouldRollSessionMemory({ summary: '', uncovered: bulky.slice(0, 10), force: true }), true);
  assert.equal(estimateSessionMemoryChars('', bulky) > 24_000, true);
});

test('rollSessionMemory advances watermark with injected summarizer', async () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({
    id: `m${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `turn-${i} ${'body '.repeat(40)}`,
    createdAt: i,
  }));
  const session = sessionWith(messages);
  const { memory, rolled } = await rollSessionMemory({
    session,
    model: runContext().model,
    force: true,
    summarize: async () => 'Rolled brief about prior turns.',
  });
  assert.equal(rolled, true);
  assert.equal(memory.summary, 'Rolled brief about prior turns.');
  assert.ok(memory.coveredUntilId);
  const remaining = uncoveredMessages(messages, memory.coveredUntilId);
  assert.ok(remaining.length <= 8);
  assert.ok(remaining.length > 0);
});
