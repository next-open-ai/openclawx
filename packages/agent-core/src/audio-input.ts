import { mkdir, writeFile, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AudioUploadSchema, AUDIO_UPLOAD_EXTENSIONS, AUDIO_UPLOAD_MAX_BYTES } from '@openclawx/contracts';

function inputRoot() {
  return path.join(process.env.OPENCLAWX_DATA_DIR || path.join(os.homedir(), '.openclawx'), 'audio-inputs');
}

/** The random reference is a capability: do not log or expose it outside its conversation. */
export async function storeAudioInput(value: unknown) {
  const input = AudioUploadSchema.parse(value);
  const extension = path.extname(input.name).slice(1).toLowerCase();
  if (!(AUDIO_UPLOAD_EXTENSIONS as readonly string[]).includes(extension)) throw new Error('不支持此录音格式，请使用 MP3、WAV、M4A 等音频文件。');
  const bytes = Buffer.from(input.base64, 'base64');
  if (!bytes.length || bytes.length > AUDIO_UPLOAD_MAX_BYTES) throw new Error('录音文件必须非空且不超过25 MB。');
  const id = `${randomUUID()}.${extension}`;
  await mkdir(inputRoot(), { recursive: true, mode: 0o700 });
  await writeFile(path.join(inputRoot(), id), bytes, { mode: 0o600, flag: 'wx' });
  return { reference: `audio-upload:${id}`, name: path.basename(input.name), size: bytes.length };
}

export async function materializeAudioInput(reference: string, workspaceRoot: string) {
  const id = reference.slice('audio-upload:'.length);
  if (!reference.startsWith('audio-upload:') || !/^[a-f0-9-]{36}\.[a-z0-9]+$/.test(id)) throw new Error('Invalid audio upload reference.');
  const [root, source] = await Promise.all([realpath(inputRoot()), realpath(path.join(inputRoot(), id))]);
  if (path.dirname(source) !== root) throw new Error('Audio upload escapes the input directory.');
  const info = await stat(source);
  if (!info.isFile() || info.size <= 0 || info.size > AUDIO_UPLOAD_MAX_BYTES) throw new Error('Invalid uploaded audio file.');
  if (Date.now() - info.mtimeMs > 86_400_000) throw new Error('录音附件已过期，请重新上传。');
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const relative = `asr-input-${randomUUID()}${path.extname(id)}`;
  await writeFile(path.join(workspaceRoot, relative), await readFile(source), { mode: 0o600, flag: 'wx' });
  return relative;
}

export async function deleteAudioInput(reference: string) {
  const id = reference.slice('audio-upload:'.length);
  if (!reference.startsWith('audio-upload:') || !/^[a-f0-9-]{36}\.[a-z0-9]+$/.test(id)) return;
  await rm(path.join(inputRoot(), id), { force: true });
}
