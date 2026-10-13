import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../apps/renderer/package.json', import.meta.url));
const ts = require('typescript');
const file = readFileSync(new URL('../apps/renderer/src/features/projects/ProjectApplicationButton.vue', import.meta.url), 'utf8');
const handler = file.slice(file.indexOf('async function receive('), file.indexOf('const busy ='));
const messages = [], calls = [];
const child = { postMessage: message => messages.push(message) };
let action = 'insert', approved = true, canWrite = true, confirms = 0;
const info = () => ({ appId:'app', canWrite, writeEnabled:canWrite, operations:[{operationId:'edit',kind:'sql',action,approved,revision:'a'.repeat(64)}] });
const dataApp = { value:info() };
const context = {
  generation:0, inflight:0, dialog:{value:{open:true}}, frame:{value:{contentWindow:child}}, dataApp,
  window:{confirm:()=>{confirms++;return false;}},
  refreshDataApp:async()=>{dataApp.value=info();},
  liveDataRequest:async(path, method, body)=>{calls.push({path,method,body});return path.endsWith('/operations')?info():{affectedRows:1};},
};
vm.createContext(context);
vm.runInContext(ts.transpileModule(handler,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
const send = (type='workmate.app.mutate',source=child)=>context.receive({source,data:{id:1,type,operationId:'edit',parameters:{id:1}}});
await send(); action='update'; await send();
assert.equal(confirms,0); assert.equal(calls.filter(c=>c.path.endsWith('/mutate')).length,2);
assert.equal(calls[0].body.confirmed,undefined);
action='delete'; await send(); assert.equal(confirms,0); assert.equal(messages.at(-1).ok,true);
action='update'; approved=false; await send(); assert.equal(messages.at(-1).ok,false);
approved=true; canWrite=false; await send(); assert.equal(messages.at(-1).ok,false);
await send('workmate.app.access'); assert.equal(messages.at(-1).data.canWrite,false);
const count=calls.length; await send('workmate.app.access',{}); assert.equal(calls.length,count);
assert.equal(calls.filter(c=>c.path.endsWith('/mutate')).length,3);
console.log('MDA-T18 PASS: actual preview handler direct insert/update/delete, approval/object denial and scoped access query.');
const trialHandler = file.slice(file.indexOf('async function trialSql('), file.indexOf('const status ='));
Object.assign(context,{busy:{value:false},error:{value:''},notice:{value:''},trialParameters:{value:{edit:'{"id":1}'}}});
vm.runInContext(ts.transpileModule(trialHandler,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
const beforeTrial=calls.length;
await context.trialSql(info().operations[0]); assert.equal(calls.length,beforeTrial); // Cancelled explicit consent.
context.window.confirm=()=>true;
await context.trialSql(info().operations[0]);
const trialCall=calls.at(-1); assert.match(trialCall.path,/sql-trial$/); assert.equal(trialCall.body.testDatabaseConfirmed,true); assert.equal(trialCall.body.acknowledgeSideEffects,true); assert.match(context.notice.value,/回滚/);
context.trialParameters.value.edit='invalid'; await context.trialSql(info().operations[0]); assert.equal(calls.at(-1),trialCall); assert.ok(context.error.value); assert.equal(context.busy.value,false);
console.log('MDA-T20 PASS: actual trial UI explicit consent, parameters, success status and invalid JSON recovery.');
const schemaCalls=[];
let consent=false, result={state:'applied'}, fail=false;
const schemaContext={generation:0,busy:{value:false},error:{value:''},notice:{value:''},dataApp:{value:{appId:'app',canApprove:true,schemaCreation:{enabled:false}}},window:{confirm:()=>consent},refreshDataApp:async()=>{},liveDataRequest:async(path,method,body)=>{schemaCalls.push({path,method,body});if(fail)throw Error('连接中断，请核对');return result;}};
vm.createContext(schemaContext);
schemaContext.Error=Error; // Match the browser's single realm for injected transport failures.
vm.runInContext(ts.transpileModule(file.slice(file.indexOf('async function schemaAccess('),file.indexOf('async function trialSql(')),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,schemaContext);
const plan={id:'plan',revision:'b'.repeat(64),tables:['notes'],description:'业务记录'};
await schemaContext.schemaAccess();await schemaContext.executeSchema(plan);assert.equal(schemaCalls.length,0);
consent=true;await schemaContext.schemaAccess();assert.equal(schemaCalls[0].method,'PATCH');assert.equal(schemaCalls[0].body.enabled,true);
await schemaContext.executeSchema(plan);assert.equal(schemaCalls[1].body.revision,plan.revision);assert.equal(schemaCalls[1].body.includeInObject,true);assert.match(schemaContext.notice.value,/已创建/);
result={state:'partial',error:'已完成1条，需核对'};await schemaContext.executeSchema(plan);assert.match(schemaContext.error.value,/需核对/);assert.equal(schemaContext.notice.value,'');
fail=true;await schemaContext.executeSchema(plan);assert.match(schemaContext.error.value,/连接中断/);assert.equal(schemaContext.busy.value,false);
schemaContext.dataApp.value.canApprove=false;const beforeDenied=schemaCalls.length;await schemaContext.executeSchema(plan);await schemaContext.schemaAccess();assert.equal(schemaCalls.length,beforeDenied);
console.log('MDA-T22 PASS: structure UI cancellation, explicit scope/revision, successful/partial/failed results and admin-only action.');
