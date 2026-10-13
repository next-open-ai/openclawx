import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertResourcePath } from './resource-access.js';

/** Host-side transport for a large, single-file deliverable. */
export const ARTIFACT_SOURCE_MAX_BYTES = 2_500_000;
export const ARTIFACT_SOURCE_MAX_CHUNK_CHARS = 6_000;
const ARTIFACT_SOURCE_TTL_MS = 30 * 60_000;

type Session = {
  id: string;
  root: string;
  relativePath: string;
  totalParts: number;
  nextSeq: number;
  bytes: number;
  parts: string[];
  createdAt: number;
};

const sessions = new Map<string, Session>();

function safeArtifactPath(value: string, requireOutput: boolean) {
  const relative = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = relative.split('/');
  if (!relative || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Large artifact writes require a safe path inside the workspace.');
  }
  if (requireOutput && !relative.startsWith('output/')) {
    throw new Error('Conversation artifact writes are restricted to a safe file under output/.');
  }
  return relative;
}

function purgeExpired(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (now - session.createdAt > ARTIFACT_SOURCE_TTL_MS) sessions.delete(id);
  }
}

export function startArtifactSourceWrite(input: { workspaceRoot: string; path: string; totalParts: number; requireOutput?: boolean }) {
  purgeExpired();
  if (!Number.isInteger(input.totalParts) || input.totalParts < 1 || input.totalParts > 512) {
    throw new Error('totalParts must be an integer between 1 and 512.');
  }
  const session: Session = {
    id: randomUUID(), root: path.resolve(input.workspaceRoot), relativePath: safeArtifactPath(input.path, input.requireOutput !== false),
    totalParts: input.totalParts, nextSeq: 1, bytes: 0, parts: [], createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

export function appendArtifactSourceWrite(input: { writeId: string; seq: number; content: string }) {
  purgeExpired();
  const session = sessions.get(input.writeId);
  if (!session) throw new Error('Unknown or expired artifact write. Start it again.');
  if (!Number.isInteger(input.seq) || input.seq !== session.nextSeq) throw new Error(`Out-of-order artifact piece: expected seq=${session.nextSeq}.`);
  if (typeof input.content !== 'string' || !input.content.length) throw new Error('Artifact piece content is required.');
  if (input.content.length > ARTIFACT_SOURCE_MAX_CHUNK_CHARS) throw new Error(`Artifact piece is too large. Keep each piece at or below ${ARTIFACT_SOURCE_MAX_CHUNK_CHARS} characters.`);
  const nextBytes = session.bytes + Buffer.byteLength(input.content, 'utf8');
  if (nextBytes > ARTIFACT_SOURCE_MAX_BYTES) throw new Error(`Artifact exceeds the ${ARTIFACT_SOURCE_MAX_BYTES} byte limit.`);
  session.parts.push(input.content);
  session.bytes = nextBytes;
  session.nextSeq += 1;
  return session;
}

export async function finishArtifactSourceWrite(writeId: string) {
  purgeExpired();
  const session = sessions.get(writeId);
  if (!session) throw new Error('Unknown or expired artifact write. Start it again.');
  if (session.parts.length !== session.totalParts) throw new Error(`Incomplete artifact write: received ${session.parts.length}/${session.totalParts} parts.`);
  const body = session.parts.join('');
  const target = path.resolve(session.root, session.relativePath);
  const relative = path.relative(session.root, target).split(path.sep).join('/');
  if (relative !== session.relativePath || relative.startsWith('../')) throw new Error('Artifact target is outside the workspace.');
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${session.id}.tmp`);
  await assertResourcePath(session.root, target);
  await assertResourcePath(session.root, temporary);
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(temporary, body, 'utf8');
    await rename(temporary, target);
    const info = await stat(target);
    return { path: session.relativePath, bytes: info.size, sha256: createHash('sha256').update(body, 'utf8').digest('hex') };
  } finally {
    await unlink(temporary).catch(() => undefined);
    sessions.delete(writeId);
  }
}
