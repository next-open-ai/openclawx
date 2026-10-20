import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDingTalkMessage } from '../adapters/dingtalk.js';

test('DingTalk text messages normalize into the shared channel contract', async () => {
  const acknowledgements: Array<[string, unknown]> = [];
  const message = parseDingTalkMessage({
    headers: { messageId: 'message-1' },
    data: JSON.stringify({
      conversationId: 'conversation-1',
      msgtype: 'text',
      text: { content: '  hello openclawx  ' },
      senderStaffId: 'staff-1',
      senderNick: 'Alice',
      sessionWebhook: 'https://example.invalid/webhook',
    }),
  }, (id, result) => acknowledgements.push([id, result]));

  assert.ok(message);
  assert.equal(message.channelId, 'dingtalk');
  assert.equal(message.threadId, 'conversation-1');
  assert.equal(message.userId, 'staff-1');
  assert.equal(message.messageText, 'hello openclawx');
  await message.ack?.({ ok: true });
  assert.deepEqual(acknowledgements, [['message-1', { ok: true }]]);
});

test('DingTalk ignores unsupported and empty messages', () => {
  assert.equal(parseDingTalkMessage({ data: JSON.stringify({ conversationId: 'c', msgtype: 'image' }) }), null);
  assert.equal(parseDingTalkMessage({ data: JSON.stringify({ conversationId: 'c', msgtype: 'text', text: { content: ' ' } }) }), null);
});
