import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,readdir,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {WorkspaceWriteStateSchema,WorkspaceWriteErrorSchema} from '@openclawx/contracts';
import {validateToolArguments} from '@mariozechner/pi-ai';
import {createSkillExecutionTools} from '../skill-runtime.js';
import {extractToolDetails} from '../pi-tools.js';
import {streamAgentReply} from '../pi-runtime.js';
import {MAX_FILE_BYTES,MAX_WRITE_CONTENT,MAX_STAGED_APPEND_CHARS,MAX_STAGED_SESSIONS,startStagedWrite,appendStagedWrite,statusStagedWrite,beginStagedCommit,settleStagedCommit,resolveWriteBody,resetStagedWritesForTests,withWorkspaceWriteLock} from '../workspace-write.js';

test('FW-T1/T2: medium source, exact byte bounds, safe sequence retry and explicit total repair',()=>{
  resetStagedWritesForTests();
  assert.equal(resolveWriteBody({content:'a'.repeat(18000)}).ok,true);
  assert.equal(resolveWriteBody({content:'a'.repeat(MAX_WRITE_CONTENT+1)}).ok,false);
  assert.equal(resolveWriteBody({content:'鸭'.repeat(32000)}).ok,true);
  assert.equal(resolveWriteBody({chunks:['鸭'.repeat(16000),'鸭'.repeat(16000),'x']}).ok,false);
  assert.equal(resolveWriteBody({content:'a',chunks:['b']}).ok,false);
  const session=startStagedWrite({path:'x.css',scope:'a',totalParts:1});
  const text='a'.repeat(8000);
  assert.equal(appendStagedWrite(session.id,text,{seq:1,scope:'a'}).ok,true);
  const duplicate=appendStagedWrite(session.id,text,{seq:1,scope:'a'});
  assert.ok(duplicate.ok&&duplicate.duplicate);assert.equal(session.bytes,8000);
  const conflict=appendStagedWrite(session.id,'different',{seq:1,scope:'a'});
  assert.ok(!conflict.ok&&conflict.code==='SEQ_CONFLICT');assert.ok(WorkspaceWriteErrorSchema.safeParse(conflict).success);
  const blocked=appendStagedWrite(session.id,'b',{seq:2,scope:'a'});
  assert.ok(!blocked.ok&&blocked.code==='TOTAL_EXCEEDED');
  assert.equal(statusStagedWrite(session.id,'other',null).ok,false);
  assert.equal(appendStagedWrite(session.id,'x',{seq:2,scope:'other'}).ok,false);
  assert.equal(beginStagedCommit(session.id,'other').ok,false);
  assert.equal(statusStagedWrite(session.id,'a',null).ok,true);
  assert.equal(appendStagedWrite(session.id,'b',{seq:2,scope:'a'}).ok,true);
  const status=statusStagedWrite(session.id,'a');
  assert.ok(status.ok&&WorkspaceWriteStateSchema.safeParse(status.state).success);
  assert.ok(!JSON.stringify(status).includes(text));
  assert.equal(statusStagedWrite(session.id,'a',1).ok,false);
  const commit=beginStagedCommit(session.id,'a');assert.ok(commit.ok);if(commit.ok)assert.equal(commit.body,text+'b');
  assert.equal(appendStagedWrite(session.id,'c',{seq:3,scope:'a'}).ok,false);
  assert.equal(beginStagedCommit(session.id,'a').ok,false);
  settleStagedCommit(session.id,'a',false);
  assert.ok(beginStagedCommit(session.id,'a').ok);settleStagedCommit(session.id,'a',true);
  assert.equal(statusStagedWrite(session.id,'a').ok,false);
});

test('FW-T2/T3: rejected reset preserves pieces; sessions are bounded per run without evicting other runs',()=>{
  resetStagedWritesForTests();
  const first=startStagedWrite({path:'a.css',scope:'a'});
  appendStagedWrite(first.id,'preserved',{seq:1,scope:'a'});
  assert.equal(appendStagedWrite(first.id,'x'.repeat(MAX_STAGED_APPEND_CHARS+1),{seq:1,reset:true,scope:'a'}).ok,false);
  assert.deepEqual(first.parts,['preserved']);
  for(let i=1;i<MAX_STAGED_SESSIONS;i++)startStagedWrite({path:`${i}.txt`,scope:'a'});
  assert.throws(()=>startStagedWrite({path:'overflow.txt',scope:'a'}),/Too many/);
  assert.equal(statusStagedWrite(first.id,'a').ok,true);
  assert.ok(startStagedWrite({path:'other.txt',scope:'b'}));
});

test('FW-T1/T3/T4: production tools admit medium files, atomic replace, guarded append and recoverable finish',async()=>{
  resetStagedWritesForTests();
  const root=await mkdtemp(path.join(os.tmpdir(),'openclawx-fw-v2-'));
  const project=path.join(root,'project');await mkdir(project);
  try{
    const tools=createSkillExecutionTools({runId:'fw-a',projectRoot:project,skills:[]});
    const call=async(name:string,args:Record<string,unknown>,signal?:AbortSignal)=>{
      const tool=tools.find(t=>t.name===name)!;
      const parsed=validateToolArguments(tool,{type:'toolCall',id:name,name,arguments:args});
      return extractToolDetails(await tool.execute(name,parsed,signal)) as Record<string,any>;
    };
    const css='/* synthetic CSS */\n'+'body{color:navy}\n'.repeat(900);
    assert.equal((await call('write_workspace_file',{path:'styles.css',content:css})).ok,true);
    assert.equal(await readFile(path.join(project,'styles.css'),'utf8'),css);
    const script='/*'+' synthetic source '.repeat(1100)+'*/';
    assert.equal((await call('write_workspace_file',{path:'main.js',content:script})).ok,true);
    assert.equal(await readFile(path.join(project,'main.js'),'utf8'),script);
    assert.equal((await call('write_workspace_file',{path:'../outside.txt',content:'no'})).ok,false);
    await writeFile(path.join(root,'outside.txt'),'unchanged');await symlink(path.join(root,'outside.txt'),path.join(project,'escape.txt'));
    assert.equal((await call('write_workspace_file',{path:'escape.txt',content:'no'})).ok,false);
    assert.equal(await readFile(path.join(root,'outside.txt'),'utf8'),'unchanged');
    const large='x'.repeat(MAX_FILE_BYTES-1);
    assert.equal((await call('write_workspace_file',{path:'limit.txt',chunks:[large.slice(0,16000),large.slice(16000,32000),large.slice(32000,48000),large.slice(48000,64000),large.slice(64000,80000),large.slice(80000)]})).ok,true);
    const appended=await Promise.all([call('write_workspace_file',{path:'limit.txt',content:'a',mode:'append'}),call('write_workspace_file',{path:'limit.txt',content:'b',mode:'append'})]);
    assert.equal(appended.filter(r=>r.ok).length,1);assert.equal(Buffer.byteLength(await readFile(path.join(project,'limit.txt'),'utf8')),MAX_FILE_BYTES);
    const session=await call('start_workspace_write',{path:'retry.txt',mode:'append'});
    assert.equal((await call('append_workspace_write',{writeId:session.writeId,seq:1,text:'suffix'})).ok,true);
    await writeFile(path.join(project,'retry.txt'),'x'.repeat(MAX_FILE_BYTES));
    assert.equal((await call('finish_workspace_write',{writeId:session.writeId})).ok,false);
    assert.equal((await call('workspace_write_status',{writeId:session.writeId})).state.parts,1);
    await writeFile(path.join(project,'retry.txt'),'prefix');
    const controller=new AbortController();controller.abort();
    assert.equal((await call('finish_workspace_write',{writeId:session.writeId},controller.signal)).ok,false);
    assert.equal((await call('workspace_write_status',{writeId:session.writeId})).state.parts,1);
    const others=createSkillExecutionTools({runId:'fw-b',projectRoot:project,skills:[]});
    const status=extractToolDetails(await others.find(t=>t.name==='workspace_write_status')!.execute('other',{writeId:session.writeId})) as {ok:boolean};assert.equal(status.ok,false);
    assert.equal((await call('finish_workspace_write',{writeId:session.writeId})).ok,true);
    assert.equal((await call('finish_workspace_write',{writeId:session.writeId})).duplicate,true);
    assert.equal(await readFile(path.join(project,'retry.txt'),'utf8'),'prefixsuffix');
    const denied=createSkillExecutionTools({runId:'fw-a',projectRoot:project,workspaceAccess:'read',skills:[]});
    assert.equal((extractToolDetails(await denied.find(t=>t.name==='start_workspace_write')!.execute('read',{path:'no.txt'})) as {ok:boolean}).ok,false);
    assert.equal((await readdir(project)).some(name=>name.startsWith('.openclawx-write-')),false);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('FW-T3/T4: cancelled queued write does not overwrite existing file; commit keeps assembly',async()=>{
  resetStagedWritesForTests();const root=await mkdtemp(path.join(os.tmpdir(),'openclawx-fw-cancel-'));
  try{
    await writeFile(path.join(root,'a.txt'),'old');
    const tools=createSkillExecutionTools({runId:'cancel',projectRoot:root,skills:[]});
    const call=async(name:string,args:Record<string,unknown>,signal?:AbortSignal)=>extractToolDetails(await tools.find(t=>t.name===name)!.execute(name,args,signal)) as Record<string,any>;
    const {writeId}=await call('start_workspace_write',{path:'a.txt'});await call('append_workspace_write',{writeId,seq:1,text:'new'});
    let unlock!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    const blocked=withWorkspaceWriteLock(path.join(root,'a.txt'),async()=>{entered();await new Promise<void>(resolve=>{unlock=resolve;});});await started;
    const controller=new AbortController();const pending=call('finish_workspace_write',{writeId},controller.signal);
    // Yield through file authorization until the commit is queued behind the target lock.
    for(let i=0;i<20;i++){const state=await call('workspace_write_status',{writeId});if(state.state.state==='committing')break;await new Promise(resolve=>setImmediate(resolve));}
    controller.abort();unlock();await blocked;
    assert.equal((await pending).ok,false);assert.equal(await readFile(path.join(root,'a.txt'),'utf8'),'old');
    assert.equal((await call('workspace_write_status',{writeId})).state.state,'assembling');
    assert.equal((await call('finish_workspace_write',{writeId})).ok,true);assert.equal(await readFile(path.join(root,'a.txt'),'utf8'),'new');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('FW-T5: logical write failures emit actionable failed events in the real Pi loop', {timeout:20000},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'openclawx-fw-events-'));
  let requests=0;
  const server=createServer((request,response)=>{
    request.resume();requests++;
    response.writeHead(200,{'content-type':'text/event-stream'});
    const chunk=(delta:unknown,finish_reason:string|null=null)=>`data: ${JSON.stringify({id:'fw',object:'chat.completion.chunk',created:1,model:'deepseek-chat',choices:[{index:0,delta,finish_reason}]})}\n\n`;
    if(requests===1){
      response.write(chunk({role:'assistant',tool_calls:[{index:0,id:'status-1',type:'function',function:{name:'workspace_write_status',arguments:JSON.stringify({writeId:'unknown-id'})}}]}));
      response.end(chunk({},'tool_calls')+'data: [DONE]\n\n');
    }else{
      response.write(chunk({role:'assistant',content:'写入会话不存在，请重新开始写入。'}));
      response.end(chunk({},'stop')+'data: [DONE]\n\n');
    }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const events=[];
    for await(const event of streamAgentReply({
      runId:'fw-events',projectWorkspacePath:root,maxSteps:5,
      profile:{id:'general',name:'Test',instructions:'Check the staged write status once.',toolIds:[]},
      messages:[{role:'user',content:'请检查本次材料的状态。'}],
      model:{provider:'deepseek',chatModel:'deepseek-chat',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,apiKey:'mock-key'},
    }))events.push(event);
    const failure=events.find(event=>event.type==='tool.failed');
    assert.ok(failure);assert.match(JSON.stringify(failure),/Unknown|expired/i);
    assert.equal(events.filter(event=>event.type==='tool.completed').length,0);
    assert.equal(requests,2);
  }finally{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(root,{recursive:true,force:true});
  }
});
