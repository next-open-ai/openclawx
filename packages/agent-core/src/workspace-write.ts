/**
 * Workspace large-file write helpers (format-agnostic).
 * See docs/architecture/workspace-file-io.md and FW-V2.
 */
import { randomUUID } from 'node:crypto';
import type {WorkspaceWriteState,WorkspaceWriteError} from '@openclawx/contracts';

export const MAX_FILE_BYTES = 96_000;
/** Soft cap for a single `content` field — keep one-shot JSON small enough to survive tool encoding. */
export const MAX_WRITE_CONTENT = 32_000;
export const MAX_WRITE_CHUNK = 16_000;
export const MAX_WRITE_CHUNKS = 16;
/** Staged append pieces stay small so tool-call JSON stays reliable. */
export const MAX_STAGED_APPEND_CHARS = 16_000;
export const MAX_STAGED_SESSIONS = 8;
export const STAGED_SESSION_TTL_MS = 30 * 60_000;

/**
 * UTF-8 is the default for text files.
 * `base64` is an escape hatch only (binary-ish payloads / JSON-escape failures) — not the preferred path.
 */
export type WriteEncoding = 'utf8' | 'base64';

export type StagedWriteSession = {
  id: string;
  path: string;
  /** Disk mode used on finish. Staged assembly itself is always in-memory join → one write. */
  mode: 'replace' | 'append';
  deliverable?: boolean;
  /** Contiguous 1-based pieces in arrival order. */
  parts: string[];
  /** Next required seq (1-based). */
  nextSeq: number;
  /** Optional declared total; changed only by explicit status correction or reset. */
  totalParts?: number;
  bytes: number;
  createdAt: number;
  scope: string;
  committing?: boolean;
};

const sessions = new Map<string, StagedWriteSession>();

function purgeExpiredSessions(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (!session.committing && now - session.createdAt > STAGED_SESSION_TTL_MS) sessions.delete(id);
  }
}

export function decodeWritePayload(raw: string, encoding: WriteEncoding = 'utf8'): string {
  if (encoding !== 'base64') return raw;
  try {
    return Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8');
  } catch {
    throw new Error('Invalid base64 payload. Prefer encoding="utf8". Use base64 only as an escape hatch.');
  }
}

export function resolveWriteBody(input: {
  content?: string;
  chunks?: string[];
  encoding?: WriteEncoding;
}): { ok: true; body: string } | { ok: false; error: string } {
  const encoding = input.encoding === 'base64' ? 'base64' : 'utf8';
  try {
    if(input.content!==undefined&&input.chunks!==undefined)return {ok:false,error:'Pass content OR chunks, not both.'};
    if(typeof input.content==='string'&&input.content.length>MAX_WRITE_CONTENT)return {ok:false,error:`Content exceeds ${MAX_WRITE_CONTENT} chars. Use staged pieces; no shell merge required.`};
    if(input.chunks!==undefined&&(!Array.isArray(input.chunks)||input.chunks.length>MAX_WRITE_CHUNKS||input.chunks.some(part=>typeof part!=='string'||part.length>MAX_WRITE_CHUNK)))return {ok:false,error:`chunks must contain at most ${MAX_WRITE_CHUNKS} strings of ≤${MAX_WRITE_CHUNK} chars.`};
    if (typeof input.content === 'string' && input.content.length) {
      const body=decodeWritePayload(input.content,encoding);
      return Buffer.byteLength(body)>MAX_FILE_BYTES?{ok:false,error:`File exceeds ${MAX_FILE_BYTES} UTF-8 bytes. Reduce content; staging cannot bypass this limit.`}:{ok:true,body};
    }
    if (Array.isArray(input.chunks) && input.chunks.length) {
      const joined = input.chunks
        .filter((part): part is string => typeof part === 'string')
        .map((part) => decodeWritePayload(part, encoding))
        .join('');
      if (!joined) {
        return {
          ok: false,
          error: 'Write body is empty. Pass content (string) or chunks (string[]). Historical path-only stubs are NOT a write format.',
        };
      }
      return Buffer.byteLength(joined)>MAX_FILE_BYTES?{ok:false,error:`File exceeds ${MAX_FILE_BYTES} UTF-8 bytes. Reduce content.`}:{ok:true,body:joined};
    }
    return {
      ok: false,
      error: 'Write body is empty. Pass content (string) or chunks (string[]). Do not omit the body — path-only entries in history mean a prior write already succeeded on disk.',
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function startStagedWrite(input: {
  path: string;
  mode?: 'replace' | 'append';
  deliverable?: boolean;
  totalParts?: number;
  scope?: string;
}): StagedWriteSession {
  purgeExpiredSessions();
  const scope=input.scope??'';
  if(input.totalParts!==undefined&&(!Number.isInteger(input.totalParts)||input.totalParts<1||input.totalParts>64))throw new Error('totalParts must be an integer from 1 to 64, or omitted.');
  if([...sessions.values()].filter(item=>item.scope===scope).length>=MAX_STAGED_SESSIONS||sessions.size>=128)throw new Error('Too many active staged writes. Finish existing writes before starting more.');
  const totalParts =
    typeof input.totalParts === 'number' && Number.isInteger(input.totalParts) && input.totalParts > 0
      ? input.totalParts
      : undefined;
  const session: StagedWriteSession = {
    id: randomUUID(),
    path: input.path,
    mode: input.mode === 'append' ? 'append' : 'replace',
    deliverable: input.deliverable,
    parts: [],
    nextSeq: 1,
    totalParts,
    bytes: 0,
    createdAt: Date.now(),
    scope,
  };
  sessions.set(session.id, session);
  return session;
}

function assertPositiveInt(name: string, value: unknown): number | { ok: false; error: string } {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return { ok: false, error: `${name} must be a positive integer (1-based).` };
  }
  return value;
}

function writeState(session:StagedWriteSession):WorkspaceWriteState {
  return {writeId:session.id,path:session.path,mode:session.mode,state:session.committing?'committing':'assembling',nextSeq:session.nextSeq,parts:session.parts.length,totalBytes:session.bytes,totalParts:session.totalParts,maxAppendChars:MAX_STAGED_APPEND_CHARS};
}
function writeError(code:string,error:string,session?:StagedWriteSession):WorkspaceWriteError {
  return {ok:false,code,error,retryable:code!=='UNKNOWN_WRITE',...(session?{state:writeState(session)}:{})};
}
export function statusStagedWrite(writeId:string,scope='',totalParts?:number|null):{ok:true;state:WorkspaceWriteState}|WorkspaceWriteError {
  purgeExpiredSessions();const session=sessions.get(writeId);
  if(!session||session.scope!==scope)return writeError('UNKNOWN_WRITE','Unknown or expired writeId for this run. Start a new write.');
  if(totalParts!==undefined){
    if(session.committing)return writeError('WRITE_BUSY','Commit in progress; wait before changing assembly.',session);
    if(totalParts!==null&&(!Number.isInteger(totalParts)||totalParts<Math.max(1,session.parts.length)||totalParts>64))return writeError('INVALID_TOTAL','totalParts must be null or an integer ≥ accepted parts and ≤64.',session);
    session.totalParts=totalParts??undefined;
  }
  return {ok:true,state:writeState(session)};
}

export function appendStagedWrite(
  writeId: string,
  text: string,
  opts: { seq: number; total?: number; reset?: boolean;scope?:string },
): {
  ok: true;
  session: StagedWriteSession;
  appended: number;
  reset?: boolean;
  duplicate?:boolean;
} | WorkspaceWriteError {
  purgeExpiredSessions();
  const session = sessions.get(writeId);
  if (!session||session.scope!==(opts.scope??'')) return writeError('UNKNOWN_WRITE','Unknown or expired writeId for this run. Call start_workspace_write first.');
  if(session.committing)return writeError('WRITE_BUSY','Commit in progress; do not append or reset.',session);
  if (typeof text !== 'string' || !text.length) {
    return writeError('EMPTY_BODY','append_workspace_write requires non-empty text. Recommended piece size ≤8000 chars.',session);
  }
  if (text.length > MAX_STAGED_APPEND_CHARS) {
    return writeError('PIECE_TOO_LARGE',`Append piece too large (${text.length} chars). Split into ≤${MAX_STAGED_APPEND_CHARS} char pieces; accepted pieces are retained.`,session);
  }

  const seqCheck = assertPositiveInt('seq', opts.seq);
  if (typeof seqCheck !== 'number'||seqCheck>64) return writeError('INVALID_SEQ','seq must be an integer from 1 to 64.',session);
  if(!opts.reset&&seqCheck<session.nextSeq){
    if(session.parts[seqCheck-1]===text&&(opts.total===undefined||opts.total===session.totalParts))return {ok:true,session,appended:0,duplicate:true};
    return writeError('SEQ_CONFLICT','This seq already contains different content. Accepted pieces retained; query workspace_write_status before explicit reset.',session);
  }
  if(opts.total!==undefined&&(!Number.isInteger(opts.total)||opts.total<1||opts.total>64))return writeError('INVALID_TOTAL','total must be an integer from 1 to 64.',session);
  const proposedTotal=opts.reset?opts.total:opts.total??session.totalParts;
  if(proposedTotal!==undefined&&seqCheck>proposedTotal)return writeError('TOTAL_EXCEEDED',`seq=${seqCheck} exceeds declared total=${proposedTotal}. Call workspace_write_status({writeId,totalParts:null}) to remove the declaration without losing pieces.`,session);
  const proposedBytes=(opts.reset?0:session.bytes)+Buffer.byteLength(text);
  if(proposedBytes>MAX_FILE_BYTES)return writeError('FILE_TOO_LARGE',`Staged write exceeds ${MAX_FILE_BYTES} UTF-8 bytes. Reduce content.`,session);

  if (opts.reset) {
    if (seqCheck !== 1) {
      return writeError('INVALID_RESET','reset=true requires seq=1; accepted pieces retained.',session);
    }
    session.parts = [];
    session.nextSeq = 1;
    session.bytes = 0;
    session.totalParts = undefined;
  }

  if (seqCheck !== session.nextSeq) {
    return writeError('OUT_OF_ORDER',`Out-of-order piece: expected seq=${session.nextSeq}, got seq=${seqCheck}. Use nextSeq from workspace_write_status; do not restart.`,session);
  }

  if (typeof opts.total === 'number') {
    const totalCheck = assertPositiveInt('total', opts.total);
    if (typeof totalCheck !== 'number') return writeError('INVALID_TOTAL',totalCheck.error,session);
    if (session.totalParts !== undefined && session.totalParts !== totalCheck) {
      return writeError('TOTAL_MISMATCH',`total mismatch: session expects ${session.totalParts} parts, got total=${totalCheck}. Use workspace_write_status({writeId,totalParts:${totalCheck}}) to update explicitly without losing pieces.`,session);
    }
    session.totalParts = totalCheck;
  }

  const nextBytes = session.bytes + Buffer.byteLength(text);

  session.parts.push(text);
  session.bytes = nextBytes;
  session.nextSeq = seqCheck + 1;
  session.createdAt=Date.now();
  return { ok: true, session, appended: Buffer.byteLength(text), ...(opts.reset ? { reset: true } : {}) };
}

export function takeStagedWrite(writeId: string,scope=''): {
  ok: true;
  session: StagedWriteSession;
  body: string;
} | { ok: false; error: string } {
  purgeExpiredSessions();
  const session = sessions.get(writeId);
  if (!session||session.scope!==scope) return { ok: false, error: `Unknown writeId "${writeId}". Call start_workspace_write first.` };
  if(session.committing)return {ok:false,error:'Commit in progress.'};
  if (!session.parts.length) {
    return { ok: false, error: 'Staged write has no pieces. Call append_workspace_write at least once before finish.' };
  }
  if (session.totalParts !== undefined && session.parts.length !== session.totalParts) {
    return {
      ok: false,
      error: `Incomplete staged write: have ${session.parts.length}/${session.totalParts} parts (next expected seq=${session.nextSeq}).`,
    };
  }
  const body = session.parts.join('');
  sessions.delete(writeId);
  return { ok: true, session, body };
}

export function peekStagedWrite(writeId: string,scope=''): StagedWriteSession | undefined {
  purgeExpiredSessions();
  const session=sessions.get(writeId);return session?.scope===scope?session:undefined;
}

export function beginStagedCommit(writeId:string,scope=''):{ok:true;session:StagedWriteSession;body:string}|WorkspaceWriteError {
  const state=statusStagedWrite(writeId,scope);
  if(!state.ok)return state;
  const session=sessions.get(writeId)!;
  if(session.committing)return writeError('WRITE_BUSY','Commit in progress; retry finish afterward.',session);
  if(!session.parts.length)return writeError('EMPTY_BODY','No accepted pieces. Append text before finish.',session);
  if(session.totalParts!==undefined&&session.parts.length!==session.totalParts)return writeError('INCOMPLETE_WRITE',`Incomplete staged write: have ${session.parts.length}/${session.totalParts} parts. Continue at nextSeq or explicitly correct totalParts with workspace_write_status.`,session);
  session.committing=true;return {ok:true,session,body:session.parts.join('')};
}
export function settleStagedCommit(writeId:string,scope:string,succeeded:boolean) {
  const session=sessions.get(writeId);if(!session||session.scope!==scope||!session.committing)return;
  if(succeeded)sessions.delete(writeId);else{session.committing=false;session.createdAt=Date.now();}
}

const targetWrites=new Map<string,Promise<void>>();
/** Serialize size checks and persistence across tool instances targeting the same file. */
export async function withWorkspaceWriteLock<T>(target:string,write:()=>Promise<T>):Promise<T> {
  const previous=targetWrites.get(target)??Promise.resolve();
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  const tail=previous.then(()=>pending);targetWrites.set(target,tail);
  await previous;
  try{return await write();}finally{release();if(targetWrites.get(target)===tail)targetWrites.delete(target);}
}

/** Test helper */
export function resetStagedWritesForTests() {
  sessions.clear();
}
