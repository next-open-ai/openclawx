import { getStoredSessionToken } from './auth';

const queries = new Set(['/api/data/gateway/options','/api/data/gateway/query','/api/data/gateway/units','/api/skills/list']);
/** No bearer or arbitrary URL is ever passed into a generated frame. */
export async function parameterDataRequest(path: unknown, query: unknown) {
  if (typeof path !== 'string' || !queries.has(path)) throw new Error('只允许查询已登记的数据或技能目录接口');
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).length>16) throw new Error('查询参数格式无效');
  const search = new URLSearchParams();
  for (const [key,value] of Object.entries(query)) {
    if (!['string','number','boolean'].includes(typeof value) || String(value).length>2000) throw new Error('查询参数只能包含有限的基本值');
    search.set(key,String(value));
  }
  const token = getStoredSessionToken();
  const base = window.location.protocol === 'file:' ? 'http://127.0.0.1:47832' : '';
  const response = await fetch(`${base}${path}?${search}`,{headers:token?{authorization:`Bearer ${token}`}:{},signal:AbortSignal.timeout(12_000)});
  const data = await response.json(); if (!response.ok) throw new Error(data.message||'数据查询失败'); return data;
}
