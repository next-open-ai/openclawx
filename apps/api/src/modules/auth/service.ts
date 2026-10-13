import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { requireSystemAdmin } from './ownership.js';

export interface LocalUserRecord {
  id: string;
  orgId: string;
  username: string;
  displayName: string;
  passwordHash: string;
  role: 'admin' | 'member';
  disabled?: boolean;
  lastLoginAt?: number;
  createdAt: number;
  updatedAt: number;
}

interface SessionRecord {
  id: string;
  token: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent?: string;
  clientType?: string;
}

export interface AuthPrincipal {
  userId: string;
  orgId: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthPrincipal;
  }
}

const SESSION_HEADER = 'x-workmate-session';
const DEFAULT_ORG_ID = 'local-org';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function dataDir() {
  return process.env.WORKMATE_DATA_DIR || path.join(os.homedir(), '.workmate');
}

function authFile() {
  return path.join(dataDir(), 'auth.local.json');
}

function ensureDir() {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
}

function normalizeSessions(sessions: SessionRecord[] | undefined) {
  const now = Date.now();
  return Array.isArray(sessions)
    ? sessions
      .map((session) => ({
        id: typeof session.id === 'string' && session.id ? session.id : randomUUID(),
        token: String(session.token || ''),
        userId: String(session.userId || ''),
        createdAt: Number(session.createdAt) || now,
        lastSeenAt: Number(session.lastSeenAt) || Number(session.createdAt) || now,
        expiresAt: Number(session.expiresAt) || (now + SESSION_TTL_MS),
        ...(typeof session.userAgent === 'string' && session.userAgent.trim() ? { userAgent: session.userAgent.trim().slice(0, 240) } : {}),
        ...(typeof session.clientType === 'string' && session.clientType.trim() ? { clientType: session.clientType.trim().slice(0, 64) } : {}),
      }))
      .filter((session) => session.token && session.userId)
    : [];
}

function readStore(): { users: LocalUserRecord[]; sessions: SessionRecord[] } {
  ensureDir();
  if (!fs.existsSync(authFile())) return { users: [], sessions: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile(), 'utf8')) as { users?: LocalUserRecord[]; sessions?: SessionRecord[] };
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: normalizeSessions(parsed.sessions),
    };
  } catch {
    return { users: [], sessions: [] };
  }
}

function writeStore(value: { users: LocalUserRecord[]; sessions: SessionRecord[] }) {
  ensureDir();
  fs.writeFileSync(authFile(), JSON.stringify(value, null, 2), { mode: 0o600 });
}

function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}

function sanitizeUser(user: LocalUserRecord) {
  return {
    id: user.id,
    orgId: user.orgId,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    disabled: Boolean(user.disabled),
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function sanitizeSession(session: SessionRecord, currentSessionId?: string) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    userAgent: session.userAgent || '',
    clientType: session.clientType || 'unknown',
    current: currentSessionId === session.id,
  };
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

function verifyPassword(password: string, encoded: string) {
  const [salt, digest] = encoded.split(':');
  if (!salt || !digest) return false;
  const next = scryptSync(password, salt, 64);
  const prior = Buffer.from(digest, 'hex');
  return prior.length === next.length && timingSafeEqual(prior, next);
}

function detectClientType(request: FastifyRequest) {
  const userAgent = String(request.headers['user-agent'] || '').toLowerCase();
  if (!userAgent) return 'unknown';
  if (userAgent.includes('electron')) return 'desktop';
  if (userAgent.includes('mobile')) return 'mobile';
  return 'web';
}

function createSession(store: { users: LocalUserRecord[]; sessions: SessionRecord[] }, userId: string, request?: FastifyRequest) {
  const now = Date.now();
  const token = randomBytes(24).toString('hex');
  store.sessions = store.sessions.filter((item) => item.expiresAt > now);
  const userAgent = String(request?.headers['user-agent'] || '').trim().slice(0, 240);
  const session: SessionRecord = {
    id: randomUUID(),
    token,
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + SESSION_TTL_MS,
    ...(userAgent ? { userAgent } : {}),
    clientType: request ? detectClientType(request) : 'unknown',
  };
  store.sessions.push(session);
  return session;
}

function currentPrincipal(request: FastifyRequest): AuthPrincipal {
  if (!request.auth) throw new Error('Authentication required.');
  return request.auth;
}

export function authGuard(): preHandlerHookHandler {
  return async (request, reply) => {
    try {
      request.auth = authenticateRequest(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(401).send({ message });
    }
  };
}

export function authenticateRequest(request: FastifyRequest): AuthPrincipal {
  const internalExpected = String(process.env.WORKMATE_INTERNAL_TOKEN || '').trim();
  const internalProvided = String(request.headers['x-workmate-internal'] || '').trim();
  if (internalExpected && internalProvided) {
    const expectedBuf = Buffer.from(internalExpected);
    const providedBuf = Buffer.from(internalProvided);
    if (expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf)) {
      return {
        userId: 'internal-desktop',
        orgId: DEFAULT_ORG_ID,
        username: 'desktop',
        displayName: 'Desktop',
        role: 'admin',
        sessionId: 'internal',
      };
    }
  }
  const queryToken = request.query && typeof request.query === 'object'
    ? String((request.query as Record<string, unknown>).sessionToken ?? '').trim()
    : '';
  const token = String(request.headers[SESSION_HEADER] || queryToken).trim();
  if (!token) throw new Error('Authentication required.');
  const store = readStore();
  const now = Date.now();
  const session = store.sessions.find((item) => item.token === token && item.expiresAt > now);
  if (!session) throw new Error('Session is invalid or expired.');
  session.lastSeenAt = now;
  writeStore(store);
  const user = store.users.find((item) => item.id === session.userId && !item.disabled);
  if (!user) throw new Error('User is unavailable.');
  return {
    userId: user.id,
    orgId: user.orgId,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    sessionId: session.id,
  };
}

export function requireAuth(request: FastifyRequest) {
  return currentPrincipal(request);
}

/** Trusted background run identity; never resolves an HTTP/model-supplied token. */
export function activeDataRunOwner(userId: string, orgId: string): { userId: string; orgId: string } | null {
  const user = readStore().users.find(item => item.id === userId && item.orgId === orgId && !item.disabled);
  return user ? { userId: user.id, orgId: user.orgId } : null;
}

export function requireAdmin(request: FastifyRequest) {
  const auth = currentPrincipal(request);
  requireSystemAdmin(auth);
  return auth;
}

export function localUserAuthService() {
  return {
    bootstrapStatus() {
      const store = readStore();
      return { needsSetup: store.users.length === 0, orgId: DEFAULT_ORG_ID };
    },
    createInitialAdmin(input: { orgId?: string; username: string; displayName: string; password: string }, request?: FastifyRequest) {
      const store = readStore();
      if (store.users.length > 0) throw new Error('Initial admin already exists.');
      const now = Date.now();
      const user: LocalUserRecord = {
        id: randomUUID(),
        orgId: input.orgId?.trim() || DEFAULT_ORG_ID,
        username: normalizeUsername(input.username),
        displayName: input.displayName.trim() || input.username.trim(),
        passwordHash: hashPassword(input.password),
        role: 'admin',
        lastLoginAt: now,
        createdAt: now,
        updatedAt: now,
      };
      if (!user.username) throw new Error('username is required.');
      if (!input.password || input.password.length < 6) throw new Error('password must be at least 6 characters.');
      store.users.push(user);
      const session = createSession(store, user.id, request);
      writeStore(store);
      return { token: session.token, user: sanitizeUser(user) };
    },
    login(input: { username: string; password: string }, request?: FastifyRequest) {
      const store = readStore();
      const user = store.users.find((item) => item.username === normalizeUsername(input.username));
      if (!user || user.disabled || !verifyPassword(input.password, user.passwordHash)) {
        throw new Error('用户名或密码错误。');
      }
      user.lastLoginAt = Date.now();
      user.updatedAt = Date.now();
      const session = createSession(store, user.id, request);
      writeStore(store);
      return { token: session.token, user: sanitizeUser(user) };
    },
    logout(token: string) {
      const store = readStore();
      store.sessions = store.sessions.filter((item) => item.token !== token);
      writeStore(store);
      return { ok: true };
    },
    currentUser(token: string) {
      const store = readStore();
      const now = Date.now();
      const session = store.sessions.find((item) => item.token === token && item.expiresAt > now);
      if (!session) return null;
      const user = store.users.find((item) => item.id === session.userId && !item.disabled);
      return user ? sanitizeUser(user) : null;
    },
    updateProfile(userId: string, patch: { displayName?: string }) {
      const store = readStore();
      const user = store.users.find((item) => item.id === userId);
      if (!user) throw new Error('User not found.');
      if (patch.displayName !== undefined) user.displayName = patch.displayName.trim() || user.displayName;
      user.updatedAt = Date.now();
      writeStore(store);
      return sanitizeUser(user);
    },
    changePassword(input: { userId: string; oldPassword: string; newPassword: string; currentSessionId: string; revokeOtherSessions?: boolean }) {
      const store = readStore();
      const user = store.users.find((item) => item.id === input.userId);
      if (!user) throw new Error('User not found.');
      if (!verifyPassword(input.oldPassword, user.passwordHash)) throw new Error('当前密码错误。');
      if (!input.newPassword || input.newPassword.length < 6) throw new Error('password must be at least 6 characters.');
      user.passwordHash = hashPassword(input.newPassword);
      user.updatedAt = Date.now();
      let revokedOtherSessions = 0;
      if (input.revokeOtherSessions !== false) {
        const nextSessions = store.sessions.filter((item) => item.userId !== input.userId || item.id === input.currentSessionId);
        revokedOtherSessions = store.sessions.length - nextSessions.length;
        store.sessions = nextSessions;
      }
      writeStore(store);
      return { ok: true, revokedOtherSessions };
    },
    listSessions(userId: string, currentSessionId: string) {
      const store = readStore();
      const now = Date.now();
      store.sessions = store.sessions.filter((item) => item.expiresAt > now);
      writeStore(store);
      return {
        currentSessionId,
        sessions: store.sessions
          .filter((item) => item.userId === userId)
          .sort((left, right) => {
            if (left.id === currentSessionId) return -1;
            if (right.id === currentSessionId) return 1;
            return right.lastSeenAt - left.lastSeenAt;
          })
          .map((item) => sanitizeSession(item, currentSessionId)),
      };
    },
    revokeSession(userId: string, sessionId: string, currentSessionId: string) {
      const store = readStore();
      const nextSessions = store.sessions.filter((item) => !(item.userId === userId && item.id === sessionId));
      const revoked = nextSessions.length !== store.sessions.length;
      store.sessions = nextSessions;
      writeStore(store);
      return { ok: true, revokedCurrent: revoked && sessionId === currentSessionId };
    },
    revokeOtherSessions(userId: string, currentSessionId: string) {
      const store = readStore();
      const nextSessions = store.sessions.filter((item) => item.userId !== userId || item.id === currentSessionId);
      const revokedCount = store.sessions.length - nextSessions.length;
      store.sessions = nextSessions;
      writeStore(store);
      return { ok: true, revokedCount };
    },
    listUsers() {
      return readStore().users.map(sanitizeUser).sort((a, b) => a.createdAt - b.createdAt);
    },
    createUser(input: { orgId?: string; username: string; displayName: string; password: string; role?: 'admin' | 'member' }) {
      const store = readStore();
      const username = normalizeUsername(input.username);
      if (!username) throw new Error('username is required.');
      if (store.users.some((item) => item.username === username)) throw new Error('username already exists.');
      if (!input.password || input.password.length < 6) throw new Error('password must be at least 6 characters.');
      const now = Date.now();
      const user: LocalUserRecord = {
        id: randomUUID(),
        orgId: input.orgId?.trim() || DEFAULT_ORG_ID,
        username,
        displayName: input.displayName.trim() || input.username.trim(),
        passwordHash: hashPassword(input.password),
        role: input.role === 'admin' ? 'admin' : 'member',
        createdAt: now,
        updatedAt: now,
      };
      store.users.push(user);
      writeStore(store);
      return sanitizeUser(user);
    },
    updateUser(userId: string, patch: { displayName?: string; password?: string; role?: 'admin' | 'member'; disabled?: boolean }) {
      const store = readStore();
      const user = store.users.find((item) => item.id === userId);
      if (!user) throw new Error('User not found.');
      if (patch.displayName !== undefined) user.displayName = patch.displayName.trim() || user.displayName;
      if (patch.password !== undefined) {
        if (patch.password.length < 6) throw new Error('password must be at least 6 characters.');
        user.passwordHash = hashPassword(patch.password);
      }
      if (patch.role) user.role = patch.role;
      if (patch.disabled !== undefined) user.disabled = Boolean(patch.disabled);
      user.updatedAt = Date.now();
      writeStore(store);
      return sanitizeUser(user);
    },
    deleteUser(userId: string) {
      const store = readStore();
      const nextUsers = store.users.filter((item) => item.id !== userId);
      if (nextUsers.length === store.users.length) return { ok: true };
      if (nextUsers.length === 0) throw new Error('Cannot delete the last user.');
      store.users = nextUsers;
      store.sessions = store.sessions.filter((item) => item.userId !== userId);
      writeStore(store);
      return { ok: true };
    },
  };
}

export function authTokenOf(request: FastifyRequest) {
  const queryToken = request.query && typeof request.query === 'object'
    ? String((request.query as Record<string, unknown>).sessionToken ?? '').trim()
    : '';
  return String(request.headers[SESSION_HEADER] || queryToken).trim();
}

export function sendAuthError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(400).send({ message });
}
