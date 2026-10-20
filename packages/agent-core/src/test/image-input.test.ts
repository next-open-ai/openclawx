import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, symlink, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatModelMessageSchema, ChatImagesSchema } from '@openclawx/contracts';
import { saveChatImage, readChatImage, deleteChatImages, assertVisionSupported, resolveChatImages } from '../image-input.js';
import { toPiModel } from '../pi-model.js';
import { toPiHistoryMessages } from '../pi-runtime.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
test('VIS-T1/T2 scoped images, validation, durable references and Pi multimodal history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-vision-'));
  const previous = process.env.OPENCLAWX_DATA_DIR;
  process.env.OPENCLAWX_DATA_DIR = root;
  try {
    await assert.rejects(saveChatImage('../outside', { name: 'x.png', dataBase64: png }), /SCOPE/);
    await assert.rejects(saveChatImage('s1', { name: 'x.png', dataBase64: Buffer.from('<svg/>').toString('base64') }), /FORMAT/);
    await assert.rejects(saveChatImage('s1', { name: 'x.png', dataBase64: 'A'.repeat(14 * 1024 * 1024) }), /SIZE/);
    const image = await saveChatImage('s1', { name: '../../截图.png', dataBase64: png });
    assert.equal(image.mimeType, 'image/png');
    assert.ok(!image.name.includes('/'));
    assert.equal((await readChatImage('s1', image.id)).bytes.toString('base64'), png);
    await assert.rejects(readChatImage('s2', image.id), /UNAVAILABLE/);
    await assert.rejects(readChatImage('s1', '../a'), /REFERENCE/);
    const message = { role: 'user' as const, content: '图片是什么？', attachments: [image] };
    assert.ok(!JSON.stringify(message).includes(png));
    assert.equal(ChatModelMessageSchema.safeParse({ ...message, role: 'assistant' }).success, false);
    assert.equal(ChatImagesSchema.safeParse(Array(5).fill(image)).success, false);
    assert.throws(() => assertVisionSupported([message], false, 'pi'), /MODEL_UNSUPPORTED/);
    assert.throws(() => assertVisionSupported([message], true, 'dsh'), /ENGINE_UNSUPPORTED/);
    assert.throws(() => assertVisionSupported([message], true, 'agentscope'), /ENGINE_UNSUPPORTED/);
    assert.doesNotThrow(() => assertVisionSupported([{ role: 'user', content: 'text' }], false, 'dsh'));
    const model = { provider: 'openai-compatible' as const, chatModel: 'vision-test', apiKey: 'test', supportsVision: true };
    assert.deepEqual(toPiModel(model).input, ['text', 'image']);
    const history = await toPiHistoryMessages([message, { role: 'assistant', content: '回答' }], model, 's1');
    assert.deepEqual((history[0] as { content: unknown[] }).content[1], { type: 'image', data: png, mimeType: 'image/png' });
    assert.equal((await resolveChatImages(message, 's1'))[0].data, png);
    await assert.rejects(resolveChatImages(message), /SCOPE/);
    const file = path.join(root, 'image-inputs', 's1', `${image.id}.bin`);
    await rm(file); await symlink(path.join(root, 'image-inputs', 's1', `${image.id}.json`), file);
    await assert.rejects(readChatImage('s1', image.id), /UNAVAILABLE/);
    await deleteChatImages('s1');
    assert.deepEqual(await readdir(path.join(root, 'image-inputs')), []);
  } finally {
    if (previous === undefined) delete process.env.OPENCLAWX_DATA_DIR; else process.env.OPENCLAWX_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
