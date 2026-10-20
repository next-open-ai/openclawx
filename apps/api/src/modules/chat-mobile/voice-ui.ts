/** Browser-only client embedded in the token page; no credentials/configuration are serialized. */
export const mobileVoiceStyle = String.raw`
.callButton{height:44px;width:44px;border-radius:14px;border:1px solid #3d7eff55;background:#3d7eff18;color:#8eb0ff;display:grid;place-items:center}.callButton svg{width:21px;height:21px}.composer{grid-template-columns:1fr auto auto auto}
.callSheet[hidden]{display:none}.callSheet{position:fixed;inset:0;z-index:40;background:radial-gradient(ellipse at 50% 25%,#243765 0,transparent 60%),#0b1220;display:flex;flex-direction:column;padding:max(20px,env(safe-area-inset-top)) 22px max(24px,env(safe-area-inset-bottom));overflow:hidden}
.callTop{display:flex;justify-content:space-between;align-items:center}.callBrand{font-size:17px;font-weight:700}.callBrand small{display:block;color:#94a7cd;font-size:11px;font-weight:400;margin-top:4px}.callTimer{font-size:13px;color:#b9c9e8;font-variant-numeric:tabular-nums}.callHero{flex:none;text-align:center;padding:24px 0 14px}.callOrb{width:110px;height:110px;border-radius:50%;margin:auto;display:grid;place-items:center;background:radial-gradient(circle at 33% 27%,#a9c7ff,#5578ff 48%,#3041a9);box-shadow:0 0 60px #668aff33,inset 0 0 28px #c1d7ff55;transition:transform .18s}.callOrb svg{width:40px;height:40px;color:#fff}.callState{font-size:16px;font-weight:600;margin:18px 0 8px}.callWave{height:30px;display:flex;justify-content:center;align-items:center;gap:4px}.callWave i{width:3px;height:4px;border-radius:4px;background:#95b6ff;transition:height .08s}.callHint{color:#94a7cd;font-size:11px;margin:8px 0 0}.callCaptions{flex:1;min-height:0;overflow:auto;padding:14px 0;scroll-behavior:smooth}.callCaption{margin:0 0 12px;padding:12px 14px;border-radius:16px;background:#ffffff08;font-size:15px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}.callCaption.user{background:#648aff1c;margin-left:20px}.callCaption small{display:block;color:#94a7cd;font-size:10px;margin-bottom:4px}.callEmpty{color:#94a7cd;text-align:center;font-size:13px;line-height:1.8;padding:24px 12px}.callWork{border:1px solid #6588d333;border-radius:12px;padding:10px 12px;font-size:12px;color:#bcd0fa;margin-bottom:10px}.callError{color:#fecaca;background:#ef44441a;border-radius:12px;padding:12px;font-size:13px;margin-top:12px}.callControls{display:flex;gap:36px;justify-content:center;padding:12px 0 0}.callControl{border:0;background:none;color:#c9d6ee;display:flex;flex-direction:column;align-items:center;gap:9px;font-size:12px}.callControl span{display:grid;place-items:center;width:58px;height:58px;border:1px solid #ffffff18;border-radius:50%;background:#ffffff0b}.callControl svg{width:24px;height:24px}.callControl.hangup span{background:#f04463;border:0;color:white}.callControl[aria-pressed="true"] span{background:#fff;color:#263452}.callControl:disabled{opacity:.45}.callClose{border:0;background:#ffffff0b;border-radius:10px;color:#b9c9e8;padding:8px 12px;font-size:12px}@media(max-height:650px){.callHero{padding:12px 0 4px}.callOrb{width:72px;height:72px}.callState{margin:10px 0 4px}}
`;

const phone = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.4 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1Z"/></svg>';
export const mobileCallButton = `<button class="callButton" id="callButton" type="button" aria-label="实时语音通话" aria-expanded="false" aria-controls="callSheet" title="实时语音通话">${phone}</button>`;
export const mobileCallSheet = `
<section class="callSheet" id="callSheet" hidden role="dialog" aria-modal="true" aria-label="OpenClawX 实时语音通话">
  <header class="callTop"><div class="callBrand">OpenClawX<small>实时语音 · 当前对话</small></div><time class="callTimer" id="callTimer">00:00</time><button class="callClose" id="callClose" type="button">返回聊天</button></header>
  <div class="callHero"><div class="callOrb" id="callOrb">${phone}</div><p class="callState" id="callState" aria-live="polite">准备通话</p><div class="callWave" id="callWave" aria-hidden="true">${'<i></i>'.repeat(29)}</div><p class="callHint" id="callHint">可以聊天，也可以请数字员工开始工作</p></div>
  <div class="callError" id="callError" role="alert" hidden></div>
  <div class="callCaptions" id="callCaptions"><div class="callEmpty">像打电话一样，自然地说出你的想法。<br>双方字幕会显示在这里。</div></div>
  <div class="callWork" id="callWork" hidden></div>
  <footer class="callControls"><button class="callControl" id="callMute" type="button" aria-pressed="false"><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg></span><b id="callMuteText">静音</b></button><button class="callControl hangup" id="callHangup" type="button"><span>${phone}</span><b>结束通话</b></button></footer>
</section>`;

export const mobileVoiceScript = String.raw`
(() => {
const $ = id => document.getElementById(id);
const sheet=$('callSheet'), captions=$('callCaptions'), state=$('callState'), mute=$('callMute');
const base='/api/chat-mobile/'+encodeURIComponent(token)+'/voice';
let generation=0, id='', context=null, stream=null, processor=null, source=null, meter=null, captureMeter=null, eventStream=null;
let timer=null, pumpTimer=null, reconnectTimer=null, animation=0, muted=false, sending=false, audioFailures=0, bytes=[], byteCount=0, nextPlay=0, started=0, expires=0;
let upstreamMuted=false, desiredUpstreamMuted=false, silentSince=0;
let phase='idle', question=null, answer=null, sources=new Set(), previousFocus=null;
const bars=Array.from($('callWave').children);
const statusLabels={connecting:'正在接通',listening:'正在听',thinking:'正在思考',speaking:'正在回复',error:'未能连接'};
function status(value){phase=value;state.textContent=muted&&value==='listening'?'麦克风已静音':statusLabels[value]||value;}
async function request(path, body, signal){
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.message||'语音服务暂时不可用');return payload;
}
function stopPlayback(){for(const node of sources){try{node.stop();}catch(_){}}sources.clear();nextPlay=0;}
function queueAudio(chunk){bytes.push(chunk);byteCount+=chunk.length;if(byteCount>192000)fail(new Error('网络持续较慢，音频上传积压，请检查 Wi-Fi 后重新拨打。'));}
function end(clear=true){
  generation++; const old=id;id='';eventStream?.close();eventStream=null;
  clearInterval(timer);clearInterval(pumpTimer);clearTimeout(reconnectTimer);cancelAnimationFrame(animation);timer=null;pumpTimer=null;reconnectTimer=null;
  if(processor){processor.onaudioprocess=null;processor.disconnect();}source?.disconnect();meter?.disconnect();captureMeter?.disconnect();
  stream?.getTracks().forEach(track=>track.stop());stream=null;stopPlayback();
  const oldContext=context;context=null;if(oldContext&&oldContext.state!=='closed')void oldContext.close().catch(()=>{});
  bytes=[];byteCount=0;upstreamMuted=false;desiredUpstreamMuted=false;silentSince=0;processor=null;source=null;meter=null;captureMeter=null;question=null;answer=null;muted=false;sending=false;audioFailures=0;
  mute.setAttribute('aria-pressed','false');$('callMuteText').textContent='静音';
  if(old)void fetch(base+'/'+encodeURIComponent(old)+'/close',{method:'POST',keepalive:true}).catch(()=>{});
  if(clear){sheet.hidden=true;captions.replaceChildren();$('callWork').hidden=true;$('callError').hidden=true;document.querySelector('.app').inert=false;$('callButton').setAttribute('aria-expanded','false');previousFocus?.focus();}
  $('newSession').disabled=busy;
}
function fail(error){end(false);status('error');$('callError').hidden=false;$('callError').textContent=error.message||String(error);mute.disabled=true;}
function caption(role,text,done=false){
  if(!text)return;
  let node=role==='user'?question:answer;
  if(!node){
    const empty=captions.querySelector('.callEmpty');empty?.remove();
    node=document.createElement('div');node.className='callCaption '+role;
    const label=document.createElement('small');label.textContent=role==='user'?'你':'OpenClawX';
    const content=document.createElement('div');node.append(label,content);captions.append(node);
    if(role==='user')question=node;else answer=node;
    while(captions.children.length>40)captions.firstElementChild.remove();
  }
  node.lastElementChild.textContent=text.slice(-12000);captions.scrollTop=captions.scrollHeight;
}
function play(audio){
  if(!context||!audio)return;const raw=atob(audio);const count=Math.floor(raw.length/2);if(!count)return;
  if(nextPlay-context.currentTime>15)throw new Error('语音播放积压，请重新连接。');
  const buffer=context.createBuffer(1,count,24000), out=buffer.getChannelData(0);
  for(let i=0;i<count;i++){let value=raw.charCodeAt(i*2)|(raw.charCodeAt(i*2+1)<<8);if(value>32767)value-=65536;out[i]=value/32768;}
  const node=context.createBufferSource();node.buffer=buffer;node.connect(meter);sources.add(node);node.onended=()=>sources.delete(node);
  const at=Math.max(context.currentTime+.025,nextPlay);node.start(at);nextPlay=at+buffer.duration;
}
function onEvent(message){
  if(message.type==='local.error')throw new Error(message.message||'连接失败');
  if(message.type==='local.closed')throw new Error('通话已结束，可返回聊天重新拨打。');
  if(message.type==='local.connected')status('listening');
  if(message.type==='local.work_result'){
    const result=message.result||{};$('callWork').hidden=false;
    $('callWork').textContent=(result.spokenSummary||'任务状态已更新')+' · 成果在当前聊天查看';void poll();return;
  }
  if(message.type!=='upstream.event')return;
  const e=message.event||{}, type=e.type, text=String(e.text||e.delta||e.transcript||'');
  if(type==='conversation.item.input_audio_transcription.started'){question=null;answer=null;stopPlayback();status('listening');}
  if(type==='conversation.item.input_audio_transcription.delta'||type==='conversation.item.input_audio_transcription.completed')caption('user',text);
  if(type==='conversation.item.input_audio_transcription.completed')status('thinking');
  if(type==='response.output_text.delta'){caption('assistant',(answer?.lastElementChild.textContent||'')+text);status('speaking');}
  if(type==='response.output_text.done')caption('assistant',text);
  if(type==='response.output_audio.started'){stopPlayback();status('speaking');}
  if(type==='response.output_audio.delta')play(String(e.audio||e.delta||''));
  if(type==='response.done'||type==='response.output_audio.done')status('listening');
  if(type==='session.closed')throw new Error('通话已结束。');
}
async function pump(g){
  if(g!==generation||!id||sending)return;
  if(upstreamMuted!==desiredUpstreamMuted){const target=desiredUpstreamMuted;sending=true;try{await request('/'+id+'/mute',{muted:target},AbortSignal.timeout(15000));upstreamMuted=target;audioFailures=0;}
    catch(error){if(g===generation){audioFailures++;if(audioFailures>=3)fail(error);}}finally{if(g===generation)sending=false;}return;}
  if(upstreamMuted)return;
  if(byteCount<3200)return;
  // Upload exactly 100 ms per 100 ms tick. Bursting a larger backlog makes
  // upstream audio run faster than real time and can trigger SeedDuplex errors.
  const size=3200, frame=new Uint8Array(size);let offset=0;
  while(offset<size&&bytes.length){const chunk=bytes[0],take=Math.min(size-offset,chunk.length);frame.set(chunk.subarray(0,take),offset);offset+=take;byteCount-=take;if(take===chunk.length)bytes.shift();else bytes[0]=chunk.subarray(take);}
  if(muted)frame.fill(0);let binary='';for(const b of frame)binary+=String.fromCharCode(b);
  sending=true;try{await request('/'+id+'/audio',{audio:btoa(binary)},AbortSignal.timeout(15000));audioFailures=0;if(phase==='connecting')status('listening');}
  catch(error){if(g===generation){audioFailures++;if(audioFailures>=3)fail(error);else status('connecting');}}finally{if(g===generation)sending=false;}
}
async function start(){
  if(!sheet.hidden){end();return;}
  previousFocus=document.activeElement;sheet.hidden=false;document.querySelector('.app').inert=true;$('callButton').setAttribute('aria-expanded','true');$('callError').hidden=true;$('callWork').hidden=true;
  captions.innerHTML='<div class="callEmpty">像打电话一样，自然地说出你的想法。<br>双方字幕会显示在这里。</div>';
  $('callTimer').textContent='00:00';mute.disabled=true;status('connecting');$('callClose').focus();
  const g=++generation;
  try{
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw new Error('手机语音需要可信 HTTPS 地址。请在电脑端配置 HTTPS 手机访问地址后重新扫码；当前地址仍可使用文字聊天。');
    const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw new Error('当前浏览器不支持实时音频，请使用系统浏览器。');
    context=new Audio();await context.resume();if(g!==generation)return;
    const local=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    if(g!==generation){local.getTracks().forEach(track=>track.stop());return;}stream=local;
    const caps=await request('/capabilities',undefined,AbortSignal.timeout(10000));if(g!==generation)return;
    if(!caps.enabled)throw new Error('请先在电脑设置中开启并配置实时语音。');
    $('callHint').textContent=caps.workEnabled?'聊天或交给数字员工工作 · 成果同步当前对话':'实时聊天 · 工作能力关联尚未开启';
    const created=await request('/session',{},AbortSignal.timeout(20000));
    if(g!==generation){void request('/'+created.session_id+'/close',{}).catch(()=>{});return;}
    id=created.session_id;expires=created.expiresAt;started=Date.now();$('newSession').disabled=true;
    meter=context.createAnalyser();meter.fftSize=256;meter.connect(context.destination);
    source=context.createMediaStreamSource(stream);processor=context.createScriptProcessor(4096,1,1);
    const silent=context.createGain();silent.gain.value=0;source.connect(processor);processor.connect(silent);silent.connect(context.destination);
    // Capture analyser does not connect to destination: never feed microphone back into speakers.
    captureMeter=context.createAnalyser();captureMeter.fftSize=256;source.connect(captureMeter);
    processor.onaudioprocess=event=>{
      if(g!==generation)return;const samples=event.inputBuffer.getChannelData(0),ratio=context.sampleRate/16000;
      const pcm=new Uint8Array(Math.floor(samples.length/ratio)*2),view=new DataView(pcm.buffer);let energy=0;
      for(let i=0;i<pcm.length/2;i++){let sum=0,start=Math.floor(i*ratio),end=Math.min(samples.length,Math.floor((i+1)*ratio));for(let j=start;j<end;j++)sum+=samples[j];const v=Math.max(-1,Math.min(1,sum/Math.max(1,end-start)));energy+=v*v;view.setInt16(i*2,muted?0:(v<0?v*32768:v*32767),true);}
      const now=performance.now(),level=Math.sqrt(energy/Math.max(1,pcm.length/2));
      if(muted){desiredUpstreamMuted=true;bytes=[];byteCount=0;return;}
      if(level>.0001){silentSince=0;desiredUpstreamMuted=false;queueAudio(pcm);if(byteCount>32000){bytes=bytes.slice(-8);byteCount=bytes.reduce((sum,chunk)=>sum+chunk.length,0);}return;}
      if(!silentSince)silentSince=now;
      if(now-silentSince>=5000){desiredUpstreamMuted=true;bytes=[];byteCount=0;return;}
      queueAudio(pcm);
    };
    eventStream=new EventSource(base+'/'+id+'/events');
    const eventRecovered=()=>{clearTimeout(reconnectTimer);reconnectTimer=null;if(g===generation&&phase==='connecting')status('listening');};
    eventStream.onopen=eventRecovered;
    eventStream.onmessage=event=>{if(g!==generation)return;eventRecovered();try{onEvent(JSON.parse(event.data));}catch(error){fail(error);}};
    eventStream.onerror=()=>{if(g!==generation||!id)return;status('connecting');if(!reconnectTimer)reconnectTimer=setTimeout(()=>{if(g===generation)fail(new Error('语音网络持续中断，请检查 Wi-Fi 与证书信任后重新拨打。'));},15000);};
    pumpTimer=setInterval(()=>void pump(g),100);
    timer=setInterval(()=>{const secs=Math.floor((Date.now()-started)/1000);$('callTimer').textContent=String(Math.floor(secs/60)).padStart(2,'0')+':'+String(secs%60).padStart(2,'0');if(Date.now()>=expires)fail(new Error('本次通话已到时长上限，请重新拨打。'));},1000);
    mute.disabled=false;status('connecting');
    // Use both microphone and output levels without synthetic idle animation.
    function draw(){if(g!==generation||!context)return;const data=new Uint8Array(256);(phase==='speaking'?meter:captureMeter).getByteTimeDomainData(data);let energy=0;for(const v of data)energy+=((v-128)/128)**2;energy=muted&&phase!=='speaking'?0:Math.min(1,Math.sqrt(energy/256)*6);bars.forEach((bar,i)=>bar.style.height=(4+energy*(10+20*Math.abs(Math.sin(i*.8+context.currentTime*4))))+'px');$('callOrb').style.transform='scale('+(1+energy*.08)+')';animation=requestAnimationFrame(draw);}draw();
  }catch(error){if(g===generation)fail(error.name==='NotAllowedError'?new Error('麦克风权限被拒绝，请在浏览器中允许后重新拨打。'):error);}
}
$('callButton').addEventListener('click',()=>void start());
$('callClose').addEventListener('click',()=>end());$('callHangup').addEventListener('click',()=>end());
mute.addEventListener('click',()=>{muted=!muted;desiredUpstreamMuted=muted;silentSince=0;bytes=[];byteCount=0;mute.setAttribute('aria-pressed',String(muted));$('callMuteText').textContent=muted?'取消静音':'静音';status(phase);});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&!sheet.hidden)end();});
window.addEventListener('pagehide',()=>end());
$('newSession').addEventListener('click',()=>{if(!sheet.hidden)end();},true);
sheet.addEventListener('keydown',event=>{
  if(event.key==='Escape'){end();return;}
  if(event.key==='Tab'){const controls=Array.from(sheet.querySelectorAll('button:not(:disabled)'));const first=controls[0],last=controls[controls.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
});
})();
`;
