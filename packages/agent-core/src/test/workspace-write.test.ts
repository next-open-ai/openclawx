import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeToolPayloadsInMessages } from '../context-sanitize.js';
import {
  MAX_STAGED_APPEND_CHARS,
  appendStagedWrite,
  resetStagedWritesForTests,
  resolveWriteBody,
  startStagedWrite,
  takeStagedWrite,
} from '../workspace-write.js';

test('resolveWriteBody accepts utf8 content', () => {
  const result = resolveWriteBody({ content: '<html>ok</html>' });
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.body, /<html>/);
});

test('resolveWriteBody decodes base64 escape hatch', () => {
  const raw = Buffer.from('hello-鸭', 'utf8').toString('base64');
  const result = resolveWriteBody({ content: raw, encoding: 'base64' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.body, 'hello-鸭');
});

test('resolveWriteBody joins string chunks', () => {
  const result = resolveWriteBody({ chunks: ['a', 'b', 'c'] });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.body, 'abc');
});

test('resolveWriteBody rejects empty writes with clear guidance', () => {
  const result = resolveWriteBody({});
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /path-only/i);
});

test('staged write start/append/finish assembles body in seq order', () => {
  resetStagedWritesForTests();
  const session = startStagedWrite({ path: 'output/index.html', deliverable: true, totalParts: 2 });
  const a = appendStagedWrite(session.id, '<!DOCTYPE html>', { seq: 1, total: 2 });
  assert.equal(a.ok, true);
  const b = appendStagedWrite(session.id, '<body>hi</body>', { seq: 2 });
  assert.equal(b.ok, true);
  const done = takeStagedWrite(session.id);
  assert.equal(done.ok, true);
  if (done.ok) {
    assert.equal(done.body, '<!DOCTYPE html><body>hi</body>');
    assert.equal(done.session.path, 'output/index.html');
  }
  assert.equal(takeStagedWrite(session.id).ok, false);
});

test('TP-T5: staged source survives per-turn hygiene and finishes without restarting or exceeding budget', () => {
  resetStagedWritesForTests();
  const pieces = ['/* styles */\n', ':root{--primary:#4665df}\n', 'body{color:var(--primary)}\n', '@media(max-width:640px){body{margin:0}}'];
  const session = startStagedWrite({ path: 'output/styles.css', totalParts: pieces.length });
  const history: any[] = [];
  for (let index = 0; index < pieces.length; index++) {
    const args = { writeId: session.id, seq: index + 1, text: pieces[index] };
    const accepted = appendStagedWrite(args.writeId, args.text!, { seq: args.seq });
    assert.equal(accepted.ok, true);
    history.push({ role: 'assistant', content: [{ type: 'toolCall', id: String(index), name: 'append_workspace_write', arguments: args }] },
      { role: 'toolResult', toolCallId: String(index), toolName: 'append_workspace_write', isError: false,
        content: [{ type: 'text', text: JSON.stringify({ ok: true, nextSeq: index + 2 }) }] });
    const clean = sanitizeToolPayloadsInMessages(history);
    // A model copying the previous call as a schema reference must still see text.
    assert.deepEqual((clean.at(-2) as any).content[0].arguments, args);
  }
  const done = takeStagedWrite(session.id);
  assert.equal(done.ok, true);
  if (done.ok) assert.equal(done.body, pieces.join(''));
  assert.equal(history.length / 2 + 2, 6, 'one start + four appends + one finish, no retries');
});

test('staged append rejects out-of-order seq', () => {
  resetStagedWritesForTests();
  const session = startStagedWrite({ path: 'output/x.md' });
  assert.equal(appendStagedWrite(session.id, 'a', { seq: 1 }).ok, true);
  const bad = appendStagedWrite(session.id, 'c', { seq: 3 });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /Out-of-order/);
});

test('staged append reset=true clears prior pieces', () => {
  resetStagedWritesForTests();
  const session = startStagedWrite({ path: 'output/x.css' });
  assert.equal(appendStagedWrite(session.id, '.junk{}', { seq: 1 }).ok, true);
  const restarted = appendStagedWrite(session.id, 'body{color:red}', { seq: 1, reset: true, total: 1 });
  assert.equal(restarted.ok, true);
  if (restarted.ok) assert.equal(restarted.reset, true);
  const done = takeStagedWrite(session.id);
  assert.equal(done.ok, true);
  if (done.ok) {
    assert.equal(done.body, 'body{color:red}');
    assert.equal(done.body.includes('.junk'), false);
  }
});

test('finish rejects incomplete totalParts', () => {
  resetStagedWritesForTests();
  const session = startStagedWrite({ path: 'output/x.py', totalParts: 3 });
  assert.equal(appendStagedWrite(session.id, 'a', { seq: 1 }).ok, true);
  assert.equal(appendStagedWrite(session.id, 'b', { seq: 2 }).ok, true);
  const done = takeStagedWrite(session.id);
  assert.equal(done.ok, false);
  if (!done.ok) assert.match(done.error, /Incomplete/);
});

test('staged append rejects oversized piece', () => {
  resetStagedWritesForTests();
  const session = startStagedWrite({ path: 'output/x.html' });
  const result = appendStagedWrite(session.id, 'x'.repeat(MAX_STAGED_APPEND_CHARS + 1), { seq: 1 });
  assert.equal(result.ok, false);
});
