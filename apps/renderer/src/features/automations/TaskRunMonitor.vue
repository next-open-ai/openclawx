<script setup lang="ts">
import {computed,ref,watch,nextTick,onMounted,onBeforeUnmount} from 'vue';
import type {TemplateTaskRun} from '@openclawx/contracts';
import {templateTasksApi as api} from '../../services/template-tasks';
import {getRunRecord,type ServerRunRecord} from '../../services/orchestration';
const props=defineProps<{taskId:string;runId:string;taskName:string;requestError?:string}>();
const emit=defineEmits<{'close':[];'open-conversation':[id:string]}>();
const run=ref<TemplateTaskRun|null>(null),agent=ref<ServerRunRecord|null>(null),connectionError=ref(''),clock=ref(Date.now()),openedAt=ref(Date.now()),lastSync=ref<number|null>(null),reading=ref(false);
const tab=ref<'logs'|'report'|'json'>('logs'),reportHtml=ref(''),reportError=ref(''),reportLoading=ref(false),reportWarning=ref('');
let reportController:AbortController|undefined,reportEpoch=0;
const jsonText=computed(()=>run.value?.jsonResult?JSON.stringify(run.value.jsonResult,null,2):'');
async function loadReport(){
  tab.value='report';
  if(!run.value?.result||reportLoading.value)return;
  const token=epoch,version=++reportEpoch,taskId=props.taskId,runId=props.runId;
  reportController?.abort();const request=new AbortController();reportController=request;
  reportLoading.value=true;reportError.value='';reportHtml.value='';reportWarning.value='';
  const timeout=setTimeout(()=>request.abort(),8000);
  try{
    const response=await api.result(taskId,runId,request.signal);
    if(!disposed&&token===epoch&&version===reportEpoch){reportHtml.value=response.html??'';reportWarning.value=response.warning??'';}
  }catch{
    if(!disposed&&token===epoch&&version===reportEpoch)reportError.value='报告读取失败，请重试；也可查看 result-json。';
  }finally{clearTimeout(timeout);if(token===epoch&&version===reportEpoch)reportLoading.value=false;}
}
function downloadJson(){
  if(!jsonText.value)return;
  const url=URL.createObjectURL(new Blob([jsonText.value],{type:'application/json'})),link=document.createElement('a');
  link.href=url;link.download='json-result.json';link.style.display='none';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const panel=ref<HTMLElement|null>(null);let previousFocus:HTMLElement|null=null;
function trapFocus(event:KeyboardEvent){
  const nodes=panel.value?.querySelectorAll<HTMLElement>('button:not([disabled]),summary,[tabindex="0"]');
  if(!nodes?.length)return;
  const first=nodes[0],last=nodes[nodes.length-1];
  if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel.value)){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
}
let epoch=0,controller:AbortController|undefined,timer:ReturnType<typeof setInterval>|undefined,disposed=false;
const terminal=computed(()=>!!run.value&&run.value.status!=='running');
const phase=computed(()=>{
  if(!run.value)return props.requestError?'状态待核实':'等待服务端确认';
  if(run.value.status==='completed')return '任务完成';
  if(run.value.status==='failed')return '执行失败';
  const status=agent.value?.status??run.value.agentStatus;
  if(status==='waiting-approval')return '等待审批';
  if(String(status)==='queued')return '排队中';
  if(status==='completed')return '正在保存结果';
  if(status==='failed'||status==='cancelled')return '正在同步结束状态';
  return '执行中';
});
const duration=computed(()=>{
  const seconds=Math.max(0,Math.floor(((run.value?.finishedAt??clock.value)-(run.value?.startedAt??openedAt.value))/1000));
  return [Math.floor(seconds/3600),Math.floor(seconds%3600/60),seconds%60].map(value=>String(value).padStart(2,'0')).join(':');
});
const stages=[{id:'input',label:'参数准备'},{id:'execution',label:'智能体执行'},{id:'output',label:'结果归档'}] as const;
function stageState(stage:string){
  const step=run.value?.steps.find(item=>item.stage===stage);
  if(step)return step.status==='completed'?'完成':'失败';
  if(!run.value||terminal.value)return '未开始';
  const next=stages.find(item=>!run.value!.steps.some(step=>step.stage===item.id));
  return next?.id===stage?'进行中':'等待';
}
const logs=computed(()=>{
  const rows:Array<{key:string;at:number;name:string;text:string;status:string}>=(run.value?.steps??[]).map((step,index)=>({key:'step-'+index,at:step.at,name:stages.find(item=>item.id===step.stage)?.label??step.stage,text:step.status==='completed'?'阶段完成':'阶段失败',status:step.status}));
  for(const [index,item] of (agent.value?.activities??[]).slice(-120).entries()){
    rows.push({key:'tool-'+index,at:item.at,name:item.toolName,text:(item.summary||'暂无执行摘要').slice(0,260),status:item.status});
  }
  return rows.sort((a,b)=>a.at-b.at).slice(-120);
});
const output=computed(()=>agent.value?.transcript?.slice(-12000)??'');
const time=(at:number)=>new Date(at).toLocaleTimeString('zh-CN',{hour12:false});
watch(()=>run.value?.result?.id,()=>{if(tab.value==='report'&&run.value?.result)void loadReport();});
async function refresh(){
  if(disposed||reading.value)return;
  const token=epoch;reading.value=true;const request=new AbortController();controller=request;
  const deadline=setTimeout(()=>request.abort(),8000);
  try{
    const detail=await api.detail(props.taskId,request.signal);
    if(disposed||token!==epoch)return;
    run.value=detail.runs.find(item=>item.id===props.runId)??null;
    connectionError.value='';lastSync.value=Date.now();
    const linked=run.value?.agentRunId;
    if(!linked){agent.value=null;return;}
    if(agent.value?.id!==linked)agent.value=null;
    try{
      const record=await getRunRecord(linked,request.signal);
      if(!disposed&&token===epoch&&run.value?.agentRunId===linked)agent.value=record;
    }catch{
      if(!disposed&&token===epoch)connectionError.value='执行日志暂时无法读取，任务状态已更新，可手动刷新。';
    }
  }catch{
    if(!disposed&&token===epoch)connectionError.value='监控连接暂时中断，尚不能判断任务失败；正在重连。';
  }finally{
    clearTimeout(deadline);if(token===epoch)reading.value=false;
  }
}
watch(()=>[props.taskId,props.runId],()=>{
  reportEpoch++;reportController?.abort();reportLoading.value=false;reportHtml.value='';reportError.value='';reportWarning.value='';tab.value='logs';
  epoch++;controller?.abort();reading.value=false;run.value=null;agent.value=null;connectionError.value='';lastSync.value=null;openedAt.value=Date.now();void refresh();
},{immediate:true});
onMounted(()=>{previousFocus=document.activeElement as HTMLElement|null;void nextTick(()=>panel.value?.focus());timer=setInterval(()=>{clock.value=Date.now();if(!terminal.value)void refresh();},1500);});
onBeforeUnmount(()=>{disposed=true;epoch++;reportEpoch++;controller?.abort();reportController?.abort();if(timer)clearInterval(timer);if(previousFocus?.isConnected)previousFocus.focus();});
</script>

<template>
  <Teleport to="body"><div class="mission-backdrop" @keydown.esc="emit('close')">
    <section ref="panel" class="mission" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="mission-title" @keydown.tab="trapFocus" :class="{'is-failed':run?.status==='failed','is-complete':run?.status==='completed'}">
      <header class="mission-header"><div><div class="eyebrow"><span class="beacon"></span> OPENCLAWX / MISSION CONTROL</div><h2 id="mission-title">{{taskName}}</h2></div><button class="close-button" @click="emit('close')">关闭监控 ✕</button></header>
      <div class="mission-body">
        <aside class="telemetry">
          <div class="reactor" :class="{'is-active':!terminal}"><div class="reactor-ring"></div><div class="reactor-core"><span>{{run?.status==='completed'?'✓':run?.status==='failed'?'!':'◈'}}</span><small>EXECUTION NODE</small></div></div>
          <div class="phase" role="status">{{phase}}</div><p class="connection">{{lastSync?'最近同步 '+time(lastSync):'正在连接任务运行记录'}}</p>
          <dl class="metrics"><div><dt>任务耗时</dt><dd>{{duration}}</dd></div><div><dt>工具活动</dt><dd>{{agent?.activities.length??'—'}} <small>条</small></dd></div><div><dt>已用 Token</dt><dd>{{agent?.usage?.totalTokens?.toLocaleString()??'—'}}</dd></div></dl>
          <ol class="stage-list"><li v-for="(stage,index) in stages" :key="stage.id" :data-state="stageState(stage.id)"><span class="stage-number">0{{index+1}}</span><div><strong>{{stage.label}}</strong><small>{{stageState(stage.id)}}</small></div></li></ol>
          <div class="run-identity"><span>RUN IDENTIFIER</span><code>{{runId}}</code></div>
        </aside>
        <main class="console-area">
          <nav class="monitor-tabs" aria-label="运行详情视图">
            <button :aria-pressed="tab==='logs'" @click="tab='logs'">执行日志</button>
            <button :aria-pressed="tab==='report'" @click="loadReport">结果报告</button>
            <button :aria-pressed="tab==='json'" @click="tab='json'">result-json</button>
          </nav>
          <div v-if="connectionError||requestError" class="monitor-warning" role="status">{{connectionError||requestError}}<span v-if="!run"> · 请以服务端记录为准，不要重复提交。</span></div>
          <div v-if="run?.error" class="monitor-error" role="alert">{{run.error}}</div>
          <template v-if="tab==='logs'">
          <div class="console-heading"><div><span class="eyebrow">LIVE EXECUTION FEED</span><h3>执行日志</h3></div><button :disabled="reading" @click="refresh">{{reading?'同步中…':'刷新日志'}}</button></div>
          <div class="log-console" tabindex="0" aria-label="真实执行步骤和工具日志">
            <p v-if="!logs.length" class="log-empty">{{run?'尚无工具日志，等待智能体执行事件。':'等待本次提交被服务端登记，不代表已经执行成功。'}}</p>
            <article v-for="line in logs" :key="line.key" class="log-line" :data-status="line.status"><time>{{time(line.at)}}</time><span class="log-status">{{line.status==='completed'?'DONE':line.status==='failed'?'FAIL':'LIVE'}}</span><div><strong>{{line.name}}</strong><p>{{line.text}}</p></div></article>
          </div>
          <details v-if="output" class="execution-output"><summary>执行输出 <small>仅显示最近 12,000 字符，不包含模型思考链</small></summary><pre>{{output}}</pre></details>
          <p class="log-note">只展示当前任务的真实步骤和工具摘要；最多保留最近 120 条，不展示原始工具参数或系统日志。</p>
          </template>
          <section v-else-if="tab==='report'" class="report-area" aria-label="本次运行结果报告">
            <div class="console-heading"><div><span class="eyebrow">RUN RESULT</span><h3>结果报告</h3></div><button :disabled="reportLoading||!run?.result" @click="loadReport">重新读取</button></div>
            <p v-if="reportLoading" role="status" class="log-empty">正在读取本次运行报告…</p>
            <p v-else-if="!run?.result" class="log-empty">{{terminal?'本次运行没有生成报告，可查看 result-json 和失败原因。':'本次任务尚未生成报告，完成后可在此查看。'}}</p>
            <p v-else-if="reportError" role="alert" class="monitor-warning">{{reportError}}</p>
            <p v-if="reportWarning" role="status" class="monitor-warning">{{reportWarning}}</p>
            <iframe v-if="reportHtml" :srcdoc="reportHtml" sandbox="allow-scripts" title="本次任务报告" referrerpolicy="no-referrer"></iframe>
            <p v-else-if="run?.result&&!reportLoading&&!reportError" class="log-empty">本次没有可用的报告页面，请查看 result-json 中的结果内容。</p>
          </section>
          <section v-else class="json-area" aria-label="本次运行完整 result-json">
            <div class="console-heading"><div><span class="eyebrow">IMMUTABLE RUN SNAPSHOT</span><h3>result-json</h3></div><button :disabled="!jsonText" @click="downloadJson">下载 json-result.json</button></div>
            <p class="log-note">包含本次运行的输入、状态、结果和错误信息；不是最新任务配置。</p>
            <pre v-if="jsonText" tabindex="0">{{jsonText}}</pre><p v-else class="log-empty">本次记录暂未提供 json-result，请刷新监控后重试。</p>
          </section>
        </main>
      </div>
      <footer class="mission-footer"><span><i class="connection-dot"></i>{{terminal?'运行已结束':'只读监控'}} · 关闭窗口不会停止任务</span><div><button v-if="run?.sessionId" @click="emit('open-conversation',run.sessionId)">{{phase==='等待审批'?'处理审批 ↗':'执行对话 ↗'}}</button><button v-if="run?.result" class="report-button" @click="loadReport">查看结果 ↗</button><button v-if="run" @click="tab='json'">result-json</button><button @click="emit('close')">关闭窗口</button></div></footer>
    </section>
  </div></Teleport>
</template>

<style scoped>
.mission-backdrop{position:fixed;inset:0;z-index:3600;display:grid;place-items:center;padding:28px;background:#030711d9;backdrop-filter:blur(12px)}
.mission{--signal:#58e5d1;width:min(1320px,100%);height:min(860px,94dvh);display:flex;flex-direction:column;min-height:0;overflow:hidden;color:#dbe8f5;background:radial-gradient(ellipse at 10% 20%,#164d5b26,transparent 50%),#090f1c;border:1px solid #294759;border-radius:18px;box-shadow:0 0 70px #08bca51a,0 35px 120px #0009;font:14px system-ui}
.mission.is-failed{--signal:#ff9b9b}.mission.is-complete{--signal:#7ee3ab}
.mission-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:24px 30px;border-bottom:1px solid #223145;background:#101a29aa}
.eyebrow{display:flex;align-items:center;gap:8px;font:10px ui-monospace,monospace;letter-spacing:.18em;color:#85a6bd}
h2{font-size:23px;font-weight:650;margin:8px 0 0;overflow-wrap:anywhere}h3{font-size:17px;margin:6px 0 0;font-weight:600}
button{min-height:40px;padding:9px 14px;border:1px solid #31455c;border-radius:8px;background:#152337;color:#dbe8f5;font:inherit;cursor:pointer}button:hover{border-color:var(--signal);color:var(--signal)}button:focus-visible{outline:2px solid var(--signal);outline-offset:3px}button:disabled{opacity:.5;cursor:wait}
.mission-body{display:grid;grid-template-columns:300px minmax(0,1fr);flex:1;min-height:0}
.telemetry{padding:20px 24px;border-right:1px solid #223145;overflow:auto;background:linear-gradient(180deg,#0c1a2a90,transparent)}
.reactor{position:relative;width:170px;height:170px;display:grid;place-items:center;margin:0 auto 14px}
.reactor-ring{position:absolute;inset:10px;border:1px solid #376474;border-radius:50%;background:repeating-conic-gradient(from 0deg,#58e5d126 0deg 2deg,transparent 2deg 12deg);box-shadow:0 0 30px #58e5d110}
.reactor-ring:before{content:'';position:absolute;inset:10px;border:3px solid transparent;border-top-color:var(--signal);border-bottom-color:var(--signal);border-radius:50%}
.is-active .reactor-ring{animation:orbit 16s linear infinite}
.reactor-core{position:relative;width:110px;height:110px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;border:1px solid #294a58;border-radius:50%;background:#0b1b28;box-shadow:inset 0 0 25px #37d8bf12;color:var(--signal)}
.reactor-core>span{font:38px ui-monospace,monospace}.reactor-core small{font:8px ui-monospace,monospace;letter-spacing:.1em}
.phase{text-align:center;font-size:21px;color:var(--signal);font-weight:650}.connection{text-align:center;color:#8499ad;font-size:11px;margin:8px 0 20px}
.metrics{margin:0}.metrics>div{display:flex;align-items:baseline;justify-content:space-between;padding:12px 0;border-top:1px solid #223145}.metrics dt{color:#94adc1;font-size:12px}.metrics dd{font:19px ui-monospace,monospace;margin:0}.metrics small{font-size:11px;color:#8499ad}
.stage-list{list-style:none;padding:12px 0;margin:0}.stage-list li{display:flex;gap:13px;padding:12px 0;color:#7590a6}.stage-number{font:13px ui-monospace,monospace;padding-top:3px}.stage-list strong{font-size:13px;font-weight:500}.stage-list small{display:block;font-size:10px;margin-top:5px}.stage-list [data-state=完成]{color:#7ee3ab}.stage-list [data-state=进行中]{color:var(--signal)}.stage-list [data-state=失败]{color:#ff9b9b}
.run-identity{border-top:1px solid #223145;padding-top:16px}.run-identity>span{font:9px ui-monospace,monospace;color:#7590a6;letter-spacing:.16em}.run-identity code{display:block;overflow-wrap:anywhere;font-size:10px;color:#91a9bd;margin-top:8px}
.console-area{display:flex;flex-direction:column;gap:14px;min-width:0;min-height:0;padding:24px;overflow:auto}.console-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
.log-console{flex:1;min-height:180px;overflow:auto;padding:10px 18px;background:linear-gradient(#1c314518 1px,transparent 1px),#060c15;background-size:100% 28px;border:1px solid #23384c;border-radius:10px;font-family:ui-monospace,SFMono-Regular,monospace}
.log-line{display:grid;grid-template-columns:66px 40px minmax(0,1fr);gap:12px;padding:14px 0;border-bottom:1px solid #1b2939}.log-line time{font-size:11px;color:#728da3;padding-top:3px}.log-status{font-size:10px;color:var(--signal);padding-top:3px}.log-line[data-status=failed] .log-status{color:#ff9b9b}.log-line strong{color:#bdd7ed;font-size:12px;font-weight:500;overflow-wrap:anywhere}.log-line p{color:#8da6bc;font-size:11px;line-height:1.65;margin:5px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.log-empty{color:#7991a7;font-size:12px;line-height:1.8;padding:20px 0}.log-note{color:#71869c;font-size:10px;line-height:1.6;margin:0}.monitor-warning,.monitor-error{padding:12px;border:1px solid #725b2c;background:#59401333;color:#eccb8f;border-radius:8px;font-size:12px;line-height:1.6;overflow-wrap:anywhere}.monitor-error{border-color:#773e4e;color:#ffb4bf;background:#52203344}
.execution-output{border:1px solid #23384c;border-radius:8px;padding:12px;font-size:12px;color:#a4bdcf}.execution-output summary{cursor:pointer}.execution-output small{display:inline-block;color:#728da3;font-size:10px;margin-left:10px}.execution-output pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:190px;overflow:auto;font:12px/1.8 ui-monospace,monospace;color:#b7cadb;margin:12px 0 0}
.mission-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 24px;border-top:1px solid #223145;background:#101a29aa;font-size:11px;color:#8da6bc}.mission-footer>div{display:flex;gap:8px;flex-wrap:wrap}.report-button{border-color:#478b80;color:var(--signal)}.connection-dot,.beacon{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--signal);box-shadow:0 0 10px #58e5d155;margin-right:5px}
@keyframes orbit{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.is-active .reactor-ring{animation:none}}
@media(max-width:760px){.mission-backdrop{padding:8px}.mission{height:96dvh}.mission-header{padding:16px}.mission-header h2{font-size:18px}.mission-body{display:block;overflow:auto}.telemetry{border-right:0;border-bottom:1px solid #223145;padding:16px}.reactor{display:none}.metrics{display:flex;gap:18px;justify-content:center}.metrics>div{display:block;border:0}.metrics dd{font-size:16px;margin-top:6px}.stage-list{display:flex;justify-content:space-around;padding:6px 0}.run-identity{display:none}.console-area{padding:16px;min-height:320px}.mission-footer{padding:12px;flex-wrap:wrap}.log-line{grid-template-columns:58px 32px minmax(0,1fr);gap:8px}}
.mission{color-scheme:dark}
@media(min-width:761px) and (max-height:800px){.telemetry{padding:16px}.reactor{width:100px;height:100px;margin-bottom:8px}.reactor-core{width:72px;height:72px;gap:5px}.reactor-core>span{font-size:26px}.reactor-core small{font-size:6px}.reactor-ring{inset:0}.phase{font-size:18px}.connection{margin:6px 0 12px}.metrics>div{padding:8px 0}.metrics dd{font-size:16px}.stage-list{padding:6px 0}.stage-list li{padding:8px 0}.run-identity{display:none}}
.monitor-tabs{display:flex;gap:8px;flex-wrap:wrap}.monitor-tabs [aria-pressed=true]{color:var(--signal);border-color:var(--signal);background:#17474355}
.report-area,.json-area{display:flex;flex-direction:column;gap:14px;flex:1;min-height:0}.report-area iframe{width:100%;flex:1;min-height:360px;border:1px solid #31455c;border-radius:10px;background:#fff}.json-area pre{margin:0;flex:1;min-height:180px;max-height:60vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#060c15;border:1px solid #23384c;border-radius:10px;padding:18px;font:12px/1.8 ui-monospace,monospace;color:#bfd5e7}
</style>
