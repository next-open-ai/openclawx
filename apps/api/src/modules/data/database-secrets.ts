import { randomUUID } from 'node:crypto';
import { databaseCredentialBridgeSchema } from '@workmate/contracts';
import { withKeyLock } from '@workmate/orchestrator';

type Bridge = { port: number; token: string };
let bridge: Bridge | undefined;
export function configureDatabaseCredentialBridge(raw: unknown) { bridge = databaseCredentialBridgeSchema.parse(raw); }

// Never persist decrypted database credentials in API/domain storage.
const sessionSecrets = new Map<string, string>();
const pending = new Map<string, { resolve: (value: string | undefined) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
process.on('message', (value: unknown) => {
  const m = value as { type?: string; id?: string; password?: string; error?: string } | null;
  if (m?.type !== 'workmate:database-secret:response' || !m.id) return;
  const request = pending.get(m.id);
  if (!request) return;
  pending.delete(m.id); clearTimeout(request.timer);
  if (m.error) request.reject(new Error('桌面安全凭据存储不可用，请解锁系统钥匙串后重试。'));
  else request.resolve(m.password);
});
export const databaseCredentialPersistence = () => process.send || bridge || process.env.WORKMATE_REQUIRE_DESKTOP_CREDENTIALS === '1' ? 'desktop' as const : 'session' as const;
export async function databaseSecret(key: string, password?: string): Promise<string | undefined> {
  return withKeyLock(`database-secret:${key}`, () => accessDatabaseSecret(key, password));
}
async function accessDatabaseSecret(key: string, password?: string): Promise<string | undefined> {
  if (bridge && !process.send) {
    const current = bridge;
    const request = async (value?: string) => {
      try {
        const response = await fetch(`http://127.0.0.1:${current.port}/credential`, {
          method: 'POST', headers: { authorization: `Bearer ${current.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ key, operation: value === undefined ? 'read' : 'write', ...(value === undefined ? {} : { password: value }) }),
          signal: AbortSignal.timeout(5000), redirect: 'error',
        });
        if (!response.ok) throw new Error();
        const body = await response.json() as { ok?: boolean; password?: unknown };
        if (body.ok !== true || (body.password !== undefined && (typeof body.password !== 'string' || body.password.length > 4096)) || (value !== undefined && body.password !== value)) throw new Error();
        return body.password as string | undefined;
      } catch { throw new Error('桌面安全凭据存储不可用，请保持桌面应用开启并解锁系统钥匙串后重试。'); }
    };
    // Migrate an extant session-only password on first access; never overwrite a persisted one.
    if (password !== undefined) { const result = await request(password); sessionSecrets.delete(key); return result; }
    const saved = await request();
    if (saved !== undefined) { sessionSecrets.delete(key); return saved; }
    const transient = sessionSecrets.get(key);
    if (transient !== undefined) { const result = await request(transient); sessionSecrets.delete(key); return result; }
    return undefined;
  }
  if (!process.send) {
    if (process.env.WORKMATE_REQUIRE_DESKTOP_CREDENTIALS === '1') throw new Error('桌面安全凭据通道尚未就绪，请等待桌面启动；如持续失败，请完整重启开发服务。');
    if (password !== undefined) sessionSecrets.set(key, password);
    return sessionSecrets.get(key);
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('桌面安全凭据存储响应超时。')); }, 5000);
    pending.set(id, { resolve, reject, timer });
    process.send!({ type: 'workmate:database-secret', id, key, operation: password === undefined ? 'read' : 'write', ...(password === undefined ? {} : { password }) }, error => {
      if (!error) return;
      clearTimeout(timer); pending.delete(id); reject(new Error('无法访问桌面安全凭据存储。'));
    });
  });
}
