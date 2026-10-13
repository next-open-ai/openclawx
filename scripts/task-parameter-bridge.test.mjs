import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source=await fs.readFile(new URL('../apps/renderer/src/services/task-parameter-bridge.ts',import.meta.url),'utf8');
const compiled=ts.transpile(source.replace("import { getStoredSessionToken } from './auth';","const getStoredSessionToken = () => 'synthetic-session';"),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022});
const {parameterDataRequest}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
test('TP-T3: frame query uses exact catalogued GET endpoints, current host identity, bounded simple values',async()=>{
 const oldFetch=globalThis.fetch, oldWindow=globalThis.window;let calls=0;
 globalThis.window={location:{protocol:'http:'}};
 globalThis.fetch=async(url,init)=>{calls++;assert.equal(url,'/api/data/gateway/options?sourceId=source&tableId=table&search=A%26B');assert.equal(init.headers.authorization,'Bearer synthetic-session');assert.equal(init.method,undefined);return {ok:true,json:async()=>({items:[{value:'1',label:'real'}]})};};
 try{
  assert.deepEqual(await parameterDataRequest('/api/data/gateway/options',{sourceId:'source',tableId:'table',search:'A&B'}),{items:[{value:'1',label:'real'}]});
  for(const url of ['https://evil.test','/api/auth/me','/api/data/gateway/options?sourceId=x','/api/data/gateway/options/../query','/api/v1/applications'])await assert.rejects(parameterDataRequest(url,{}),/只允许/);
  await assert.rejects(parameterDataRequest('/api/data/gateway/query',{bad:{nested:'value'}}),/基本值/);
  assert.equal(calls,1);
  globalThis.fetch=async(url,init)=>{assert.equal(url,'/api/skills/list?');assert.equal(init.headers.authorization,'Bearer synthetic-session');return {ok:true,json:async()=>({skills:[{id:'a',name:'技能一',description:''}]})};};
  assert.equal((await parameterDataRequest('/api/skills/list',{})).skills[0].id,'a');
  await assert.rejects(parameterDataRequest('/api/skills/list/../file',{}),/只允许/);
  globalThis.fetch=async()=>({ok:false,json:async()=>({message:'无权访问数据'})});
  await assert.rejects(parameterDataRequest('/api/data/gateway/query',{}),/无权访问/);
 }finally{globalThis.fetch=oldFetch;globalThis.window=oldWindow;}
});
