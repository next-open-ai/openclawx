<script setup lang="ts">
import {ref,computed,watch,onMounted,onBeforeUnmount} from 'vue';
import type {TaskTemplateDefinition,TaskSchedule,TemplateTaskDetail,TemplateTaskRun} from '@openclawx/contracts';
import type {Employee} from '../../app/workspace';
import {employeeDisplayName} from '../../app/employees';
import {useI18n} from '../../app/i18n';
import {templateTasksApi as api} from '../../services/template-tasks';
import {parameterDataRequest} from '../../services/task-parameter-bridge';
import TaskScheduleEditor from './TaskScheduleEditor.vue';
import TaskRunMonitor from './TaskRunMonitor.vue';
const props=defineProps<{employees:Employee[];returnDefinitionId?:string}>();
const emit=defineEmits<{'open-project':[id:string,definitionId:string];'open-conversation':[id:string]}>();
const records=ref<TaskTemplateDefinition[]>([]),selected=ref<TaskTemplateDefinition|null>(null),design=ref(false),creating=ref(false),busy=ref(false),loading=ref(true),error=ref(''),notice=ref('');
const {t}=useI18n();
const availableEmployees=computed(()=>props.employees.filter(employee=>!employee.system&&employee.id!=='administrator'));
const labelEmployee=(employee:Employee)=>employeeDisplayName(employee,t);
const name=ref(''),description=ref(''),prompt=ref(''),employeeId=ref('');
watch(availableEmployees,employees=>{
  if(!employees.some(employee=>employee.id===employeeId.value))employeeId.value=employees.find(employee=>employee.id==='general')?.id??employees[0]?.id??'';
},{immediate:true});
const html=ref(''),frame=ref<HTMLIFrameElement|null>(null),parameters=ref<Record<string,unknown>>({}),confirmed=ref(false),requestText=ref(''),taskName=ref(''),schedule=ref<TaskSchedule>({kind:'manual'}),history=ref<TemplateTaskDetail[]>([]),report=ref(''),reportText=ref('');
const step=ref<'parameters'|'execution'|'history'>('parameters');
const monitorTarget=ref<{taskId:string;runId:string;taskName:string}|null>(null);
function backToParameters(){if(busy.value)return;step.value='parameters';error.value='';}
function nextStep(){
  if(busy.value)return;
  if(html.value){confirmParameters();return;}
  confirmed.value=true;step.value='execution';error.value='';
}
let channel=crypto.randomUUID(),pendingId:string|undefined,timer:ReturnType<typeof setInterval>|undefined,polling=false,generation=0;
let confirmTimer:ReturnType<typeof setTimeout>|undefined;
const confirmationPending=ref(false);
function clearConfirmation(){if(confirmTimer)clearTimeout(confirmTimer);confirmationPending.value=false;}
function confirmParameters(){if(confirmationPending.value||busy.value)return;confirmationPending.value=true;send({type:'openclawx.task.confirm'});confirmTimer=setTimeout(()=>{confirmationPending.value=false;error.value='参数页面未响应，请使用表单内确认按钮，或返回编辑器检查提交逻辑。';},8000);}
const date=(time:number)=>new Date(time).toLocaleString('zh-CN');
const state=(run:TemplateTaskRun)=>run.status==='completed'?'已完成':run.status==='failed'?'执行失败':run.agentStatus==='waiting-approval'?'等待审批':run.agentStatus==='queued'?'排队中':'执行中';
async function action(fn:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';try{await fn();}catch(cause){error.value=cause instanceof Error?cause.message:'操作失败，请重试';}finally{busy.value=false;}}
async function refresh(){records.value=(await api.applications()).applications;}
async function create(){await action(async()=>{if(!availableEmployees.value.some(employee=>employee.id===employeeId.value))throw Error('暂无可用执行智能体，请先在数字员工中配置。');const response=await api.createApplication({name:name.value,description:description.value,employeeId:employeeId.value,prompt:prompt.value});creating.value=false;await refresh();emit('open-project',response.projectId,response.definition.id);});}
async function edit(record:TaskTemplateDefinition){await action(async()=>{const latest=(await api.definition(record.id)).definition;const {projectId}=await api.parameterProject(latest,latest.draft.agent?.employeeId??employeeId.value);emit('open-project',projectId,record.id);});}
async function open(record:TaskTemplateDefinition,asDesign=false){await action(async()=>{
  clearConfirmation();step.value='parameters';generation++;let current=(await api.definition(record.id)).definition;
  if(asDesign&&current.parameterProjectId)current=(await api.importParameterUi(current)).definition;
  const template=asDesign?current.draft:current.published.at(-1);if(!template)throw Error('应用尚未发布，请先预览验证并发布。');
  selected.value=current;design.value=asDesign;parameters.value={...template.defaults};confirmed.value=!template.parameterUi;requestText.value='';taskName.value=template.name;schedule.value={kind:'manual'};pendingId=undefined;channel=crypto.randomUUID();history.value=[];report.value='';reportText.value='';notice.value='';
  html.value=template.parameterUi?(asDesign?await api.previewInput(current):await api.input(template)).html:'';
  if(!asDesign)await loadHistory();
});}
function send(message:Record<string,unknown>){frame.value?.contentWindow?.postMessage(JSON.parse(JSON.stringify({...message,channel})),'*');}
async function receive(event:MessageEvent){
  if(!selected.value||event.source!==frame.value?.contentWindow)return;
  if(event.data?.type==='openclawx.task.ready'){send({type:'openclawx.task.init',parameters:parameters.value,submitLabel:design.value?'确认验证参数':'确认参数'});return;}
  if(event.data?.channel!==channel)return;
  if(event.data.type==='openclawx.task.dirty'){confirmed.value=false;pendingId=undefined;step.value='parameters';notice.value='参数已修改，请重新确认。';return;}
  if(event.data.type==='openclawx.task.confirm-error'){clearConfirmation();confirmed.value=false;error.value=String(event.data.error||'请检查表单必填项');return;}
  if(event.data.type==='openclawx.task.request'){
    const active=channel;try{const data=await parameterDataRequest(event.data.path,event.data.query);if(channel===active)send({type:'openclawx.task.response',id:event.data.id,data});}catch(cause){if(channel===active)send({type:'openclawx.task.response',id:event.data.id,error:cause instanceof Error?cause.message:'查询失败'});}return;
  }
  if(event.data.type!=='openclawx.task.submit'||busy.value)return;
  clearConfirmation();
  await action(async()=>{try{
    const input=event.data.parameters;
    if(design.value)await api.trial(selected.value!,input);
    else await api.validateParameters(selected.value!.published.at(-1)!,input);
    parameters.value=JSON.parse(JSON.stringify(input));confirmed.value=true;pendingId=undefined;
    notice.value=design.value?'参数验证成功，可以发布应用；尚未执行任务。':'参数已确认，请选择立即执行或定时执行。';send({type:'openclawx.task.saved',notice:notice.value});step.value='execution';
  }catch(cause){confirmed.value=false;send({type:'openclawx.task.saved',error:cause instanceof Error?cause.message:'参数不正确'});throw cause;}});
}
async function publish(){if(!selected.value)return;await action(async()=>{await api.trial(selected.value!,parameters.value);selected.value=(await api.publish(selected.value!)).definition;await refresh();notice.value='发布成功。可以打开应用填写参数并执行任务。';});}
async function launch(){if(!selected.value||!confirmed.value)return;await action(async()=>{
  pendingId??=crypto.randomUUID();const template=selected.value!.published.at(-1)!;
  const response=await api.launchApplication(selected.value!.id,{requestId:pendingId,version:template.version,name:taskName.value,parameters:html.value?parameters.value:{...parameters.value,...(requestText.value?{request:requestText.value}:{})},schedule:schedule.value,executeNow:schedule.value.kind==='manual'});
  if(response.status==='accepted'&&response.runId)monitorTarget.value={taskId:response.task.id,runId:response.runId,taskName:taskName.value};
  pendingId=undefined;step.value='history';notice.value=response.status==='accepted'?'任务已提交，进度会在下方更新。':'定时任务已保存，由服务端按计划执行。';await loadHistory();
});}
async function loadHistory(){if(!selected.value||design.value||polling)return;polling=true;const id=selected.value.id,token=generation;try{const tasks=(await api.list()).tasks.filter(task=>task.templateId===id).sort((a,b)=>b.createdAt-a.createdAt).slice(0,10);const details=await Promise.all(tasks.map(task=>api.detail(task.id)));if(token===generation&&selected.value?.id===id)history.value=details;}catch(cause){if(token===generation)error.value=cause instanceof Error?cause.message:'读取执行记录失败';}finally{polling=false;}}
async function showResult(taskId:string,runId:string){await action(async()=>{const response=await api.result(taskId,runId);report.value=response.html??'';reportText.value=JSON.stringify(response.result.data,null,2);});}
function close(){clearConfirmation();generation++;selected.value=null;html.value='';channel=crypto.randomUUID();}
onMounted(async()=>{window.addEventListener('message',receive);await action(refresh);if(props.returnDefinitionId){const record=records.value.find(row=>row.id===props.returnDefinitionId);if(record)await open(record,true);}loading.value=false;timer=setInterval(()=>{if(selected.value&&!design.value)void loadHistory();},2000);});
onBeforeUnmount(()=>{clearConfirmation();generation++;if(timer)clearInterval(timer);window.removeEventListener('message',receive);});
</script>

<template>
  <section class="task-apps">
    <TaskRunMonitor v-if="monitorTarget" :key="monitorTarget.runId" v-bind="monitorTarget" @close="monitorTarget=null" @open-conversation="id=>emit('open-conversation',id)" />
    <header class="toolbar"><div><h2>任务应用</h2><p>把常用工作做成应用，填写参数即可执行，或安排稍后自动执行。</p></div><button class="primary" @click="creating=true">＋ 创建任务应用</button><button :disabled="busy" @click="action(refresh)">刷新</button></header>
    <p v-if="error" role="alert" class="error">{{error}}</p><p v-if="notice" role="status" class="notice">{{notice}}</p>
    <p v-if="loading" role="status">正在读取任务应用…</p><div v-else-if="!records.length" class="empty"><h3>将下一项常用工作变成应用</h3><p>说明任务目标和执行智能体，再到项目编辑器用AI设计参数界面。无需先配置五步模板。</p><button @click="creating=true">创建第一个任务应用</button></div>
    <div class="app-list"><article v-for="record in records" :key="record.id"><div><h3>{{record.draft.name}}</h3><p>{{record.draft.description||'填写参数，执行工作，统一查看报告。'}}</p><small>{{record.published.length?'已有发布版本':'草稿 · 尚未发布'}} · 修改于 {{date(record.updatedAt)}}</small></div><div class="actions"><button class="primary" :disabled="busy||!record.published.length||record.archived" @click="open(record)">打开应用</button><button :disabled="busy" @click="edit(record)">去编辑</button><button :disabled="busy" @click="open(record,true)">预览与发布</button></div></article></div>
    <div v-if="creating" class="overlay" @keydown.esc="creating=false"><section role="dialog" aria-modal="true" aria-labelledby="task-app-create-title" class="dialog"><header class="toolbar"><h3 id="task-app-create-title">创建任务应用</h3><button :disabled="busy" @click="creating=false">关闭</button></header><form @submit.prevent="create"><label>应用名称<input v-model="name" required maxlength="120" placeholder="例如：客户月度经营分析"></label><label>应用介绍<input v-model="description" maxlength="1000" placeholder="说明这个应用能完成什么工作"></label><label>执行智能体<select v-model="employeeId" required :disabled="busy||!availableEmployees.length"><option v-if="!availableEmployees.length" disabled value="">暂无可用智能体</option><option v-for="employee in availableEmployees" :key="employee.id" :value="employee.id">{{labelEmployee(employee)}}</option></select><small v-if="!availableEmployees.length" role="status">请先在「数字员工」中配置可用智能体。</small></label><label>任务目标<textarea v-model="prompt" required maxlength="8000" placeholder="描述需要分析的数据、处理方式和期望结果。AI编辑器将以此设计参数页面。"></textarea></label><p>创建后进入项目编辑器。任务API参考与参数SDK会随项目提供；不会自动执行任务或发布应用。</p><p v-if="error" role="alert" class="error">{{error}}</p><button class="primary" :disabled="busy||!employeeId">{{busy?'正在创建…':'创建并去编辑'}}</button></form></section></div>
    <div v-if="selected" class="overlay application-overlay">
      <section role="dialog" aria-modal="true" aria-labelledby="task-app-title" class="application-workspace">
        <header class="workspace-header">
          <div><h3 id="task-app-title">{{selected.draft.name}}</h3><p>{{design?'设计预览 · 验证不会执行任务':'运行已发布版本 · 任务提交后可关闭页面'}}</p></div>
          <div class="actions"><button v-if="!design&&step!=='history'" :disabled="busy" @click="step='history';loadHistory()">执行记录</button><button :disabled="busy" @click="close">关闭</button></div>
        </header>
        <nav class="stepper" aria-label="任务应用步骤">
          <span :aria-current="step==='parameters'?'step':undefined">1. {{design?'填写验证参数':'填写参数'}}</span><span aria-hidden="true">›</span>
          <span :aria-current="step==='execution'?'step':undefined">2. {{design?'验证发布':'执行设置'}}</span>
          <template v-if="!design"><span aria-hidden="true">›</span><span :aria-current="step==='history'?'step':undefined">3. 运行记录</span></template>
        </nav>
        <p v-if="error" role="alert" class="error workspace-feedback">{{error}}</p>
        <p v-if="notice&&step!=='parameters'" role="status" class="notice workspace-feedback">{{notice}}</p>
        <div v-show="step==='parameters'" class="parameter-stage">
          <iframe v-if="html" ref="frame" :key="channel" :srcdoc="html" class="parameter-frame" title="任务应用参数" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
          <div v-else class="step-content"><h2>本次任务需要什么？</h2><p>可以补充要求，也可以直接进入下一步。这里不会执行任务。</p><label>任务补充说明（可选）<textarea v-model="requestText" maxlength="4000"></textarea></label></div>
        </div>
        <div v-if="step==='execution'" class="workspace-scroll"><div class="step-content">
          <h2>{{design?'参数验证通过':'安排本次任务'}}</h2>
          <p>{{design?'确认后发布当前应用配置，不会执行智能体。':'参数已确认，设置任务名称和执行时间即可，无需重复填写。'}}</p>
          <template v-if="!design"><label>本次任务名称<input v-model="taskName" required maxlength="120"></label><TaskScheduleEditor v-model="schedule" :disabled="busy" /></template>
        </div></div>
        <div v-if="step==='history'&&!design" class="workspace-scroll"><div class="step-content history">
          <header class="toolbar"><h2>执行记录</h2><button @click="loadHistory">刷新记录</button></header>
          <p v-if="!history.length">尚无执行记录。定时任务会按计划运行，全部任务也保存在任务管理中。</p>
          <article v-for="detail in history" :key="detail.task.id"><strong>{{detail.task.name}}</strong><small>{{detail.task.schedule?.kind==='manual'?'手动任务':'定时任务'}} · {{detail.runs.length?'':'等待执行'}}</small><div v-for="run in detail.runs.slice(0,5)" :key="run.id" class="run"><span>{{state(run)}} · {{date(run.startedAt)}}</span><p v-if="run.error" class="error">{{run.error}}</p><button v-if="run.sessionId" @click="emit('open-conversation',run.sessionId)">执行对话 / 审批</button><button v-if="run.result" @click="showResult(detail.task.id,run.id)">查看报告</button></div></article>
          <iframe v-if="report" :srcdoc="report" sandbox="allow-scripts" title="任务应用报告" referrerpolicy="no-referrer"></iframe><pre v-else-if="reportText">{{reportText}}</pre>
        </div></div>
        <footer class="workspace-footer">
          <span class="hint">{{step==='parameters'?'填写后进入下一步；确认参数不会执行任务。':step==='history'?'关闭页面不会停止已提交的任务。':'返回上一步可修改参数，已有输入会保留。'}}</span>
          <div class="actions">
            <button v-if="step==='execution'" :disabled="busy" @click="backToParameters">← 上一步</button>
            <button v-if="step==='parameters'" class="primary" :disabled="busy||confirmationPending" @click="nextStep">{{confirmationPending?'正在验证参数…':'下一步'}}</button>
            <template v-else-if="step==='execution'">
              <template v-if="design"><button class="primary" :disabled="busy||!confirmed" @click="publish">{{busy?'正在发布…':'验证并发布'}}</button><button v-if="selected.published.length" :disabled="busy" @click="open(selected)">使用已发布版本</button></template>
              <button v-else class="primary" :disabled="busy||!confirmed||!taskName.trim()" @click="launch">{{busy?'正在提交…':schedule.kind==='manual'?'立即执行':'保存定时任务'}}</button>
            </template>
            <button v-else :disabled="busy" @click="backToParameters">填写新任务</button>
          </div>
        </footer>
      </section>
    </div>
  </section>
</template>
<style scoped>
.task-apps{font-size:14px}.toolbar,.actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.toolbar>div{flex:1;min-width:0}h2{font-size:21px;font-weight:700}h3{font-size:16px;font-weight:650}p,small{color:var(--muted);line-height:1.7;margin:8px 0}button,input,textarea,select{font:inherit;background:var(--surface);color:var(--text);border:1px solid var(--border);padding:10px 14px;border-radius:10px;min-width:0}button{cursor:pointer;min-height:42px}button:disabled{opacity:.5;cursor:default}.primary{background:var(--accent);border-color:var(--accent);color:#fff}.app-list{display:grid;gap:14px;margin-top:24px}.app-list article{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:18px;padding:24px;background:var(--surface);border:1px solid var(--border);border-radius:16px}.app-list article>div:first-child{flex:1;min-width:180px}.empty{padding:40px 24px;border:1px dashed var(--border);border-radius:16px;margin-top:24px}.overlay{position:fixed;inset:0;z-index:70;background:#10182880;display:flex;align-items:center;justify-content:center;padding:16px}.dialog{width:min(600px,100%);max-height:92dvh;overflow:auto;overscroll-behavior:contain;padding:24px;border-radius:18px;background:var(--surface);box-shadow:0 20px 80px #0003}.wide{width:min(1000px,100%)}label{display:grid;gap:8px;margin:18px 0}textarea{min-height:110px;resize:vertical}iframe{display:block;width:100%;height:44vh;margin:18px 0;border:1px solid var(--border);border-radius:12px}.error{color:var(--danger,#c02929);white-space:pre-wrap}.notice{padding:12px 16px;background:var(--surface-muted);border-radius:10px}.hint{font-size:12px}footer{position:sticky;bottom:-24px;padding:16px 0;background:var(--surface);border-top:1px solid var(--border)}.history{margin-top:24px;border-top:1px solid var(--border);padding-top:20px}.history article{padding:16px 0;border-bottom:1px solid var(--border)}small{display:block}.run{margin-top:10px}.run button{margin:8px 8px 0 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:var(--surface-muted);border-radius:10px;max-height:45vh;overflow:auto}@media(max-width:600px){.dialog{padding:16px}.app-list article{padding:18px}.actions{width:100%}.actions button{flex:1}.overlay{padding:8px}footer{bottom:-16px}}
/* The parameter app owns the full work area; isolation is not presented as a preview box. */
.application-overlay{padding:0;background:var(--surface)}
.application-workspace{width:100%;height:100dvh;min-height:0;display:flex;flex-direction:column;background:var(--surface);overflow:hidden}
.workspace-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 32px;border-bottom:1px solid var(--border);flex-shrink:0}
.workspace-header h3{font-size:20px}.workspace-header p{margin:4px 0 0;font-size:12px}
.stepper{display:flex;align-items:center;justify-content:center;gap:20px;padding:14px 24px;color:var(--muted);font-size:13px;border-bottom:1px solid var(--border);flex-shrink:0}
.stepper [aria-current=step]{color:var(--accent);font-weight:700}
.workspace-feedback{margin:10px 24px 0;flex-shrink:0}
.parameter-stage{flex:1;min-height:0;overflow:auto}
.parameter-frame{height:100%;width:100%;margin:0;border:0;border-radius:0}
.workspace-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
.step-content{width:min(760px,100%);margin:0 auto;padding:32px;box-sizing:border-box}
.step-content.history{border:0;margin:0 auto}
.workspace-footer{position:static;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-shrink:0;padding:16px 32px;border-top:1px solid var(--border)}
.workspace-footer .actions{justify-content:flex-end}.workspace-footer .hint{margin:0}
@media(max-width:600px){.workspace-header{padding:12px 16px}.workspace-header .actions{width:auto}.stepper{gap:10px;padding:12px 8px;font-size:12px}.step-content{padding:24px 16px}.workspace-footer{padding:12px 16px;flex-wrap:wrap}.workspace-footer .actions{width:100%}.workspace-feedback{margin:8px 16px 0}}
</style>
