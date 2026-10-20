import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { RealtimeVoiceSession } from './realtime-routes.js';
import { registerRealtimeVoiceRoutes } from './realtime-routes.js';
import Fastify from 'fastify';
import { VoiceResponseGate } from './response-gate.js';
import { explicitPlaybackStop } from './playback-control.js';
import { RealtimeVoiceInterruptSchema, RealtimeVoicePlaybackSchema, RealtimeVoiceDiagnosticSchema } from '@openclawx/contracts';

test('BI-A1: response fencing rejects retired IDs and untagged late events', () => {
  const gate = new VoiceResponseGate();
  gate.accept({type:'response.created',response:{id:'r1'}});
  const old = gate.epoch;
  assert.equal(gate.interrupt(old),true); assert.equal(gate.interrupt(old),false);
  for (const type of ['response.audio.delta','response.text.delta','response.done','response.function_call_arguments.done']) {
    assert.equal(gate.accept({type,response_id:'r1'}),false);
    assert.equal(gate.accept({type}),false);
  }
  assert.equal(gate.accept({type:'response.audio.started'}),false);
  gate.accept({type:'conversation.item.input_audio_transcription.completed'});
  assert.equal(gate.accept({type:'response.audio.started'}),true);
  assert.equal(gate.accept({type:'response.done',response_id:'r1'}),false);
  assert.equal(gate.accept({type:'response.created',response:{id:'r2'}}),true);
  assert.equal(gate.interrupt(old),false,'late HTTP cannot cancel next response');
  assert.equal(gate.accept({type:'response.audio.delta',response_id:'r2'}),true);
  assert.equal(RealtimeVoiceInterruptSchema.safeParse({session_id:'x'}).success,false);
  assert.equal(RealtimeVoicePlaybackSchema.safeParse({session_id:'a'.repeat(32),responseEpoch:1,busy:false}).success,true);
});

test('BI-A1: interrupt/playback routes require an owned session and valid input', async () => {
  const app=Fastify();
  app.addHook('preHandler',async request=>{
    request.auth={userId:'other',orgId:'other',role:'member',username:'test',displayName:'test',sessionId:'test'};
  });
  await registerRealtimeVoiceRoutes(app);
  try {
    for(const operation of ['interrupt','playback']) {
      assert.equal((await app.inject({method:'POST',url:`/voice/realtime/${operation}`,payload:{session_id:'a'.repeat(32),responseEpoch:0,...(operation==='playback'?{busy:false}:{})}})).statusCode,404);
      assert.equal((await app.inject({method:'POST',url:`/voice/realtime/${operation}`,payload:{session_id:'invalid'}})).statusCode,400);
    }
  } finally { await app.close(); }
});

test('BI-A5: diagnostics whitelist excludes audio, transcript, arbitrary text and oversized metrics', () => {
  const input={session_id:'a'.repeat(32),diagnostic:{reason:'echo',durationMs:600,level:.02,noise:.003,echoCancellation:true,playing:true}};
  assert.equal(RealtimeVoiceDiagnosticSchema.safeParse(input).success,true);
  for(const extra of [{text:'private'},{audio:'AAA='},{reason:'arbitrary message'},{durationMs:10001}]) {
    assert.equal(RealtimeVoiceDiagnosticSchema.safeParse({...input,diagnostic:{...input.diagnostic,...extra}}).success,false);
  }
});

test('BI-A6: playback stop intent does not include ordinary interruption, negation, quotes, questions or employee cancellation', () => {
  for (const text of ['停止朗读','请停止播报文件内容','不要继续朗读了','停一下','stop reading']) assert.equal(explicitPlaybackStop(text),true,text);
  for (const text of ['不要停止朗读','是否停止朗读？','他说“停止朗读”','取消生成报告任务','换个话题','停一下是什么意思']) assert.equal(explicitPlaybackStop(text),false,text);
});

for(const failure of ['timeout','error','closed'])test(`SN-A1: initialization ${failure} rejects without uploading or leaking session`,async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const connection=once(server,'connection');const logs:Record<string,unknown>[]=[];
  const session=new RealtimeVoiceSession({orgId:'test',userId:'test'}, {provider:'qwen',endpoint:`ws://127.0.0.1:${(server.address() as {port:number}).port}`,workLinkEnabled:false},'stub-secret',event=>logs.push(event),500);
  const outcome=session.waitReady().then(()=>false,()=>true);
  const upload=session.sendAudio('AAA=').then(()=>false,()=>true);
  const [socket]=await connection;let audio=0;socket.on('message',raw=>{if(JSON.parse(raw.toString()).type==='input_audio_buffer.append')audio++;});
  try {
    if(failure==='error')socket.send(JSON.stringify({type:'error',error:{message:'private prompt'}}));
    if(failure==='closed')socket.close();
    assert.equal(await outcome,true);assert.equal(await upload,true);assert.equal(audio,0);
    assert.doesNotMatch(JSON.stringify(logs),/stub-secret|private prompt|AAA=/);
  }finally{session.close(false);socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

for (const provider of ['volcengine','qwen']) test(`BI-A1: ${provider} local WebSocket interrupt preserves session and audio`, async () => {
  const server = new WebSocketServer({host:'127.0.0.1',port:0}); await once(server,'listening');
  const endpoint = `ws://127.0.0.1:${(server.address() as {port:number}).port}`;
  const connected = once(server,'connection');
  const session = new RealtimeVoiceSession({orgId:'test',userId:'test'}, {provider,endpoint,model:'test',workLinkEnabled:false,clientPlayback:true},'stub-key');
  const [socket] = await connected;
  const sent: Record<string,unknown>[]=[];
  socket.on('message',(raw:Buffer)=>sent.push(JSON.parse(raw.toString())));
  const received: Array<Record<string,unknown>>=[];
  const unsubscribe=session.subscribe(event=>received.push(event));
  assert.equal(session.takeDiagnosticSlot(),true);
  assert.equal(session.takeDiagnosticSlot(),false,'candidate diagnostic logs are rate bounded');
  const flush=async()=>{await new Promise(resolve=>setTimeout(resolve,20));};
  try {
    // No audio is allowed merely because the WebSocket is open.
    let uploadSettled = false;
    const earlyUpload = session.sendAudio('AAA=').then(()=>{uploadSettled=true;});
    if(provider==='qwen')socket.send(JSON.stringify({type:'session.created'}));
    await flush();assert.equal(uploadSettled,false);assert.equal(sent.filter(e=>e.type==='input_audio_buffer.append').length,0);
    socket.send(JSON.stringify({type:provider==='qwen'?'session.updated':'session.created'}));
    await session.waitReady();await earlyUpload;await flush();
    assert.equal(uploadSettled,true);
    received.length=0;sent.length=0;
    socket.send(JSON.stringify({type:'response.created',response:{id:'r1'}})); await flush();
    const epoch=Number(received.find(e=>e.type==='upstream.event')?.responseEpoch);
    const next=await session.interrupt(epoch); await session.interrupt(epoch); await flush();
    assert.equal(next,epoch+1);
    assert.equal(sent.filter(e=>e.type==='response.cancel').length,1);
    socket.send(JSON.stringify({type:'error',error:{event_id:sent.find(e=>e.type==='response.cancel')!.event_id,message:'no active response'}}));
    socket.send(JSON.stringify({type:'response.audio.delta',response_id:'r1',delta:'AAA='}));
    socket.send(JSON.stringify({type:'response.function_call_arguments.done',response_id:'r1',call_id:'late',name:'start_work',arguments:'{}'}));
    await flush();
    assert.ok(received.some(e=>e.type==='local.interrupt_warning'));
    assert.equal(received.filter(e=>e.type==='upstream.event').length,1);
    await session.sendAudio('AAA=');
    socket.send(JSON.stringify({type:'response.created',response:{id:'r2'}}));
    socket.send(JSON.stringify({type:'response.audio.delta',response_id:'r2',delta:'AAA='})); await flush();
    assert.ok(received.some(e=>(e.event as Record<string,unknown>)?.response_id==='r2'));
    assert.equal(sent.filter(e=>e.type==='input_audio_buffer.append').length,1);
    assert.equal(sent.filter(e=>e.type==='session.close').length,0);
    assert.equal(received.filter(e=>e.type==='local.work_result').length,0,'old tools never dispatch');
    // Use a deterministic bridge double; no real employee or model is invoked.
    let finishWork!: (result: Record<string,unknown>)=>void;
    const runningWork = new Promise<Record<string,unknown>>(resolve=>{finishWork=resolve;});
    const taskId='11111111-1111-4111-8111-111111111111';
    const internals=session as unknown as {
      workBridge:{call:()=>Promise<Record<string,unknown>>;status:()=>Promise<Record<string,unknown>>};
      workTasks:Set<string>;pollWork:()=>Promise<void>;
    };
    internals.workBridge={call:()=>runningWork,status:async()=>({ok:true,status:'completed',taskId,title:'报告',spokenSummary:'完成'})};
    socket.send(JSON.stringify({type:'response.function_call_arguments.done',response_id:'r2',call_id:'accepted',name:'start_work',arguments:'{}'})); await flush();
    const current=Number(received.filter(e=>e.type==='upstream.event').at(-1)?.responseEpoch);
    await session.interrupt(current); await flush();
    const beforeResult=sent.length;
    finishWork({ok:true,status:'accepted',taskId}); await flush();
    assert.ok(internals.workTasks.has(taskId),'already accepted task survives speech interruption');
    assert.equal(sent.length,beforeResult,'late tool result cannot restart interrupted speech');
    await internals.pollWork();
    assert.equal(received.filter(e=>e.type==='local.work_notice').length,0,'notice waits while interruption is fenced');
    socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',text:'下一轮'}));
    socket.send(JSON.stringify({type:'response.created',response:{id:'r3'}}));
    socket.send(JSON.stringify({type:'response.audio.delta',response_id:'r3',delta:'AAA='}));
    socket.send(JSON.stringify({type:'response.done',response:{id:'r3'}})); await flush();
    await internals.pollWork();
    assert.equal(received.filter(e=>e.type==='local.work_notice').length,0,'notice waits for buffered speaker audio');
    const playbackEpoch=Number(received.filter(e=>e.type==='upstream.event').at(-1)?.responseEpoch);
    session.setPlaybackBusy(false,playbackEpoch); await internals.pollWork(); await flush();
    assert.equal(received.filter(e=>e.type==='local.work_notice').length,1,'idle notification delivered once');
    const cancels=sent.filter(e=>e.type==='response.cancel').length;
    socket.send(JSON.stringify({type:'input_audio_buffer.speech_started'}));
    socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.started'}));await flush();
    assert.equal(sent.filter(e=>e.type==='response.cancel').length,cancels,'provider interruption never sends redundant cancel');
    assert.equal(received.filter(e=>e.type==='local.provider_interrupted').length,1,'duplicate starts are idempotent');
    socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',text:'停止朗读'}));
    socket.send(JSON.stringify({type:'response.created',response:{id:'stop-response'}}));
    const stopCall={type:'response.function_call_arguments.done',response_id:'stop-response',call_id:'stop-1',name:'stop_voice_playback',arguments:'{}'};
    socket.send(JSON.stringify(stopCall));await flush();socket.send(JSON.stringify(stopCall));await flush();
    assert.equal(received.filter(e=>e.type==='local.playback_stopped').length,1);
    assert.equal(sent.filter(e=>e.type==='response.cancel').length,cancels+1,'explicit stop cancels only playback response');
  } finally {
    unsubscribe(); session.close(false); socket.terminate(); await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
