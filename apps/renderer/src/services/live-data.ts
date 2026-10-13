import type { SavedDatabaseConnection, LiveDataObjectInfo } from '@workmate/contracts';
export type { SavedDatabaseConnection, LiveDataObjectInfo };
export async function liveDataRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const base = location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const timeout = AbortSignal.timeout(100_000);
  const response = await fetch(`${base}/api/data${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || '数据操作失败，请重试。');
  return result;
}
