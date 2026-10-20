import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { storeAudioInput, materializeAudioInput } from '../audio-input.js';

test('audio uploads validate input, materialize privately and reject expiry/path escapes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openclawx-audio-input-'));
  const previous = process.env.OPENCLAWX_DATA_DIR;
  process.env.OPENCLAWX_DATA_DIR = root;
  try {
    await assert.rejects(storeAudioInput({ name: 'bad.txt', base64: 'YXVkaW8=' }), /格式/);
    await assert.rejects(storeAudioInput({ name: 'bad.mp3', base64: '!!!!' }));
    const upload = await storeAudioInput({ name: '会议.mp3', base64: 'YXVkaW8=' });
    const workspace = path.join(root, 'run');
    const relative = await materializeAudioInput(upload.reference, workspace);
    assert.equal((await readFile(path.join(workspace, relative))).toString(), 'audio');
    await assert.rejects(materializeAudioInput('audio-upload:../../outside.mp3', workspace));
    const source = path.join(root, 'audio-inputs', upload.reference.slice(13));
    const past = new Date(Date.now() - 2 * 86_400_000);
    await utimes(source, past, past);
    await assert.rejects(materializeAudioInput(upload.reference, workspace), /过期/);
    const id = '00000000-0000-0000-0000-000000000000.mp3';
    await writeFile(path.join(root, 'outside.mp3'), 'private');
    await symlink(path.join(root, 'outside.mp3'), path.join(root, 'audio-inputs', id));
    await assert.rejects(materializeAudioInput(`audio-upload:${id}`, workspace), /escapes/);
  } finally {
    if (previous === undefined) delete process.env.OPENCLAWX_DATA_DIR; else process.env.OPENCLAWX_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
