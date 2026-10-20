import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deleteAudioInput, readDocument, supportsDocumentReading, storeAudioInput } from '@openclawx/agent-core';
import { ChatFileAttachmentSchema, ChatFilesSchema, type ChatFileAttachment } from '@openclawx/contracts';

const GLOBAL_LIMIT = 2 * 1024 * 1024 * 1024;
const SESSION_LIMIT = 200 * 1024 * 1024;
const SESSION_COUNT_LIMIT = 50;
const CONTEXT_LIMIT = 36_000;
const MIME_BY_EXT: Record<string, { kind: ChatFileAttachment['kind']; max: number; mime: string }> = {
  '.pdf': { kind: 'document', max: 20 * 1024 * 1024, mime: 'application/pdf' },
  '.docx': { kind: 'document', max: 10 * 1024 * 1024, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.pptx': { kind: 'document', max: 25 * 1024 * 1024, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  '.ppsx': { kind: 'document', max: 25 * 1024 * 1024, mime: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow' },
  '.md': { kind: 'document', max: 2 * 1024 * 1024, mime: 'text/markdown' },
  '.txt': { kind: 'document', max: 2 * 1024 * 1024, mime: 'text/plain' },
  '.html': { kind: 'document', max: 2 * 1024 * 1024, mime: 'text/html' },
  '.htm': { kind: 'document', max: 2 * 1024 * 1024, mime: 'text/html' },
  '.xlsx': { kind: 'spreadsheet', max: 10 * 1024 * 1024, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.xls': { kind: 'spreadsheet', max: 10 * 1024 * 1024, mime: 'application/vnd.ms-excel' },
  '.csv': { kind: 'spreadsheet', max: 10 * 1024 * 1024, mime: 'text/csv' },
  '.mp3': { kind: 'audio', max: 25 * 1024 * 1024, mime: 'audio/mpeg' },
  '.wav': { kind: 'audio', max: 25 * 1024 * 1024, mime: 'audio/wav' },
  '.m4a': { kind: 'audio', max: 25 * 1024 * 1024, mime: 'audio/mp4' },
  '.aac': { kind: 'audio', max: 25 * 1024 * 1024, mime: 'audio/aac' },
  '.flac': { kind: 'audio', max: 25 * 1024 * 1024, mime: 'audio/flac' },
  '.ogg': { kind: 'audio', max: 25 * 1024 * 1024, mime: 'audio/ogg' },
  '.opus': { kind: 'audio', max: 25 * 1024 * 1024, mime: 'audio/ogg' },
  '.webm': { kind: 'audio', max: 25 * 1024 * 1024, mime: 'audio/webm' },
};

function root() { return path.join(process.env.OPENCLAWX_DATA_DIR || path.join(os.homedir(), '.openclawx'), 'chat-attachments'); }
function safeSegment(value: string) { return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120); }
function safeName(value: string) { return path.basename(value).replace(/[\\/\x00-\x1f]/g, '_').slice(0, 180) || 'attachment'; }
function folder(sessionId: string, id: string) { return path.join(root(), safeSegment(sessionId), safeSegment(id)); }
async function dirSize(dir: string): Promise<{ bytes: number; count: number }> {
  let bytes = 0; let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { const nested = await dirSize(full); bytes += nested.bytes; count += nested.count; }
    else if (entry.name === 'meta.json') count += 1;
    else bytes += (await stat(full).catch(() => ({ size: 0 }))).size;
  }
  return { bytes, count };
}


async function parse(bytes: Buffer, name: string, kind: ChatFileAttachment['kind']) {
  if (kind === 'audio') {
    const uploaded = await storeAudioInput({ name, base64: bytes.toString('base64') });
    return { context: `录音附件：${name}\n请调用 model_transcribe_audio，path=${uploaded.reference}，outputFormat=text。`, summary: '已就绪 · 将使用语音识别模型处理' };
  }
  const result=await readDocument({fileName:name,bytes,allowEnhanced:true,maxChars:/\.(pptx|ppsx)$/i.test(name)?500000:CONTEXT_LIMIT});
  if(!result.ok)throw new Error(result.message);
  return{context:result.text,summary:`${result.info.parser} · 已提取 ${result.text.length.toLocaleString()} 个字符${result.info.truncated?' · 内容有截断':''}`};
}

function assertFileSignature(bytes: Buffer, ext: string) {
  const ascii = bytes.subarray(0, 12).toString('ascii');
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const ole = bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (ext === '.pdf' && !ascii.startsWith('%PDF-')) throw new Error('文件内容不是有效的 PDF。');
  if ((ext === '.docx' || ext === '.xlsx' || ext === '.pptx' || ext === '.ppsx') && !zip) throw new Error('文件内容与扩展名不匹配。');
  if (ext === '.xls' && !ole) throw new Error('文件内容不是有效的 XLS 工作簿。');
  if ((ext === '.md' || ext === '.txt' || ext === '.html' || ext === '.htm' || ext === '.csv') && bytes.subarray(0, 1024).includes(0)) throw new Error('文本文件包含二进制内容。');
  if (ext === '.wav' && !(ascii.startsWith('RIFF') && ascii.includes('WAVE'))) throw new Error('文件内容不是有效的 WAV 音频。');
  if (ext === '.flac' && !ascii.startsWith('fLaC')) throw new Error('文件内容不是有效的 FLAC 音频。');
  if ((ext === '.ogg' || ext === '.opus') && !ascii.startsWith('OggS')) throw new Error('文件内容不是有效的 OGG/Opus 音频。');
  if (ext === '.mp3' && !(ascii.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) throw new Error('文件内容不是有效的 MP3 音频。');
  if (ext === '.m4a' && bytes.subarray(4, 8).toString('ascii') !== 'ftyp') throw new Error('文件内容不是有效的 M4A 音频。');
  if (ext === '.aac' && !(bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0)) throw new Error('文件内容不是有效的 AAC 音频。');
  if (ext === '.webm' && !bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) throw new Error('文件内容不是有效的 WebM 音频。');
}

export async function saveChatFile(sessionId: string, input: { name: string; bytes: Buffer; deferPdfParsing?:boolean;deferDocumentParsing?:boolean }): Promise<{ attachment: ChatFileAttachment; warning?: string }> {
  await cleanupChatAttachments().catch(() => undefined);
  const name = safeName(input.name);
  const rule = MIME_BY_EXT[path.extname(name).toLowerCase()];
  if (!rule) throw new Error('支持 PDF、DOCX、PPTX、PPSX、XLSX、XLS、CSV、HTML、Markdown 和 TXT。');
  const bytes = input.bytes;
  if (!bytes.length || bytes.length > rule.max) throw new Error(`${path.extname(name).toUpperCase()} 文件大小不符合限制。`);
  assertFileSignature(bytes, path.extname(name).toLowerCase());
  const [sessionUsage, globalUsage] = await Promise.all([dirSize(path.join(root(), safeSegment(sessionId))), dirSize(root())]);
  if (sessionUsage.count >= SESSION_COUNT_LIMIT || sessionUsage.bytes + bytes.length > SESSION_LIMIT) throw new Error('当前对话的临时附件已达上限，请删除旧附件或新建对话。');
  if (globalUsage.bytes + bytes.length > GLOBAL_LIMIT) throw new Error('临时附件空间已满，请在设置中清理后重试。');
  const parsed = ((input.deferDocumentParsing&&supportsDocumentReading(name))||(input.deferPdfParsing&&path.extname(name).toLowerCase()==='.pdf'))
    ? {context:'原始文档待员工使用统一读取工具或已授权Skill处理；没有可用正文，不得从历史摘要推断文件内容。',summary:'原始文档已就绪 · 等待员工处理'}
    : await parse(bytes, name, rule.kind);
  const id = randomUUID(); const dir = folder(sessionId, id); const createdAt = Date.now();
  const attachment = ChatFileAttachmentSchema.parse({ id, name, mimeType: rule.mime, size: bytes.length, kind: rule.kind, status: 'ready', summary: parsed.summary, createdAt });
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(path.join(dir, 'original'), bytes, { mode: 0o600 }),
    writeFile(path.join(dir, 'context.txt'), parsed.context, { mode: 0o600 }),
    writeFile(path.join(dir, 'meta.json'), JSON.stringify(attachment), { mode: 0o600 }),
  ]);
  return { attachment, ...(globalUsage.bytes + bytes.length >= GLOBAL_LIMIT * .8 ? { warning: '临时附件空间使用已超过 80%，建议及时清理。' } : {}) };
}

function relevantContext(source: string, query: string) {
  if (source.length <= 12_000) return source;
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 24);
  const chunks = Array.from({ length: Math.ceil(source.length / 2_400) }, (_, index) => source.slice(index * 2_400, index * 2_400 + 2_800));
  const ranked = chunks.map((text, index) => ({ text, index, score: terms.reduce((sum, term) => sum + (text.toLowerCase().split(term).length - 1), 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 6).sort((a, b) => a.index - b.index);
  return ranked.map((item) => item.text).join('\n\n[…相关片段…]\n\n').slice(0, 16_000);
}

function relevantPresentationContext(source: string, query: string) {
  const header = source.split(/(?=\n## 第 \d+ 页：)/)[0].trim();
  const pages = source.match(/## 第 \d+ 页：[\s\S]*?(?=\n## 第 \d+ 页：|$)/g) ?? [];
  if (source.length <= 16_000 || !pages.length) return source.slice(0, 16_000);
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 24);
  const selected = pages.map((text, index) => ({
    text, index,
    score: terms.reduce((sum, term) => sum + (text.toLowerCase().split(term).length - 1), 0),
  })).sort((left, right) => right.score - left.score || left.index - right.index).slice(0, 10).sort((left, right) => left.index - right.index);
  return [header, ...selected.map((item) => item.text.trim())].join('\n\n').slice(0, 20_000);
}

export async function resolveChatFiles(sessionId: string, raw: unknown, query = '') {
  const files = ChatFilesSchema.parse(raw ?? []);
  if (files.filter((item) => ['.pptx', '.ppsx'].includes(path.extname(item.name).toLowerCase())).length > 3) throw new Error('单次消息最多支持 3 个演示文稿。');
  let total = 0; const verified: ChatFileAttachment[] = []; const contexts: string[] = [];
  for (const item of files) {
    const dir = folder(sessionId, item.id);
    const actual = ChatFileAttachmentSchema.parse(JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')));
    if (actual.name !== item.name || actual.size !== item.size) throw new Error('附件元数据不匹配，请重新上传。');
    total += actual.size; verified.push(actual);
    const source = await readFile(path.join(dir, 'context.txt'), 'utf8');
    const extension = path.extname(actual.name).toLowerCase();
    const selectedContext = extension === '.pptx' || extension === '.ppsx'
      ? relevantPresentationContext(source, query)
      : actual.kind === 'document' ? relevantContext(source, query) : source;
    contexts.push(`\n<attachment name=${JSON.stringify(actual.name)} kind=${JSON.stringify(actual.kind)}>\n${selectedContext}\n</attachment>`);
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ committedAt: Date.now() }), { mode: 0o600 });
  }
  if (total > 50 * 1024 * 1024) throw new Error('单次消息附件总大小不能超过 50 MB。');
  return { attachments: verified, context: contexts.join('\n').slice(0, 40_000) };
}

async function removeAttachmentFolder(dir: string) {
  const context = await readFile(path.join(dir, 'context.txt'), 'utf8').catch(() => '');
  const reference = context.match(/audio-upload:[a-f0-9-]{36}\.[a-z0-9]+/)?.[0];
  if (reference) await deleteAudioInput(reference).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}
export async function deleteChatFile(sessionId: string, id: string) { await removeAttachmentFolder(folder(sessionId, id)); }
export async function readChatFile(sessionId: string, id: string) {
  const dir = folder(sessionId, id);
  const attachment = ChatFileAttachmentSchema.parse(JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')));
  return { attachment, bytes: await readFile(path.join(dir, 'original')) };
}
export async function deleteChatFiles(sessionId: string) {
  const dir = path.join(root(), safeSegment(sessionId));
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await removeAttachmentFolder(path.join(dir, entry.name));
  await rm(dir, { recursive: true, force: true });
}
export async function chatAttachmentStats() { const usage = await dirSize(root()); return { ...usage, limitBytes: GLOBAL_LIMIT, warning: usage.bytes >= GLOBAL_LIMIT * .8 }; }

export async function cleanupChatAttachments(input: { dryRun?: boolean } = {}) {
  const now = Date.now(); const candidates: Array<{ dir: string; bytes: number }> = [];
  for (const session of await readdir(root(), { withFileTypes: true }).catch(() => [])) {
    if (!session.isDirectory()) continue;
    for (const entry of await readdir(path.join(root(), session.name), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root(), session.name, entry.name);
      const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8').catch(() => '{}')) as { createdAt?: number };
      const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8').catch(() => '{}')) as { committedAt?: number };
      const cutoff = state.committedAt ? 30 * 86_400_000 : 24 * 3_600_000;
      if (now - Number(state.committedAt || meta.createdAt || now) < cutoff) continue;
      candidates.push({ dir, bytes: (await dirSize(dir)).bytes });
    }
  }
  if (!input.dryRun) await Promise.all(candidates.map((item) => removeAttachmentFolder(item.dir)));
  return { count: candidates.length, bytes: candidates.reduce((sum, item) => sum + item.bytes, 0), dryRun: Boolean(input.dryRun) };
}
