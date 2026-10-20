<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { parameterDataRequest } from '../../services/task-parameter-bridge';
import {TaskScheduleSchema,type TaskSchedule} from '@openclawx/contracts';
import TaskScheduleEditor from './TaskScheduleEditor.vue';
import TaskRunMonitor from './TaskRunMonitor.vue';
import type {Employee} from '../../app/workspace';
import {employeeDisplayName} from '../../app/employees';
import {useI18n} from '../../app/i18n';
import { templateTasksApi as api, type TaskTemplate, type TemplateTask, type TemplateTaskDetail, type TaskResult, type TaskExportFormat } from '../../services/template-tasks';

const emit=defineEmits<{'open-conversation':[id:string]}>();
const props=defineProps<{employees?:Employee[]}>();
const {t}=useI18n();
const direct=ref(false),employeeId=ref('general'),outputInstructions=ref('');
const schedule=ref<TaskSchedule>({kind:'manual'});
function scheduleLabel(task:TemplateTask){const value=task.schedule;if(!value||value.kind==='manual')return '手动执行';if(value.kind==='once'&&task.scheduleState?.lastScheduledAt&&task.scheduleState.nextRunAt===null)return '指定时间 · 已执行';const label=value.kind==='once'?'指定时间':value.kind==='interval'?`每 ${value.everyMinutes} 分钟`:({daily:'每天',weekly:'每周',monthly:'每月'}[value.kind]+' '+value.time);return `${label} · ${value.enabled?'已启用':'已暂停'}`;}
const tasks = ref<TemplateTask[]>([]);
const detail = ref<TemplateTaskDetail | null>(null), selectedTemplate = ref<TaskTemplate | null>(null);
const detailOpen=ref(false);
const runningTaskId=ref('');
const monitorTarget=ref<{taskId:string;runId:string;taskName:string}|null>(null),monitorError=ref('');
function closeDetail(){if(!busy.value)detailOpen.value=false;}
const editingTask = ref<TemplateTask | undefined>(), editing = ref(false), name = ref('');
const createStage=ref<'parameters'|'basic'>('basic'), parameters=ref<Record<string,unknown>>({}), prompt=ref('');
const inputHtml = ref(''), inputFrame = ref<HTMLIFrameElement | null>(null);
const result = ref<TaskResult | null>(null), report = ref(''), warning = ref(''), error = ref('');
const busy = ref(false), query = ref(''), resultTab = ref<'report' | 'data' | 'input'>('report');
const notice = ref('');
let channel = '';
const exportFormats = computed<TaskExportFormat[]>(() => result.value?.delivery?.exports ?? ['json']);
const pendingRequests = new Map<string, string>();
function reopenMonitor(task:TemplateTask){
  const runId=pendingRequests.get(task.id);
  if(runId)monitorTarget.value={taskId:task.id,runId,taskName:task.name};
}
const date = (time: number) => new Date(time).toLocaleString('zh-CN');
async function action(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try { await fn(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
async function reload() { tasks.value = (await api.list()).tasks; }
async function deleteTask(task: TemplateTask) {
  if (busy.value || !window.confirm(`删除任务“${task.name}”？\n删除后将停止后续定时执行。已有运行记录、报告和文件会保留。`)) return;
  await action(async () => {
    await api.deleteTask(task);
    tasks.value = tasks.value.filter(item => item.id !== task.id);
    pendingRequests.delete(task.id);
    if (detail.value?.task.id === task.id) { detail.value = null; detailOpen.value=false;clearResult(); }
    notice.value = '任务已删除，后续定时执行已停止；历史运行记录仍可查看。';
  });
}
function clearResult() { result.value = null; report.value = ''; warning.value = ''; }
async function openTask(task: TemplateTask) {
  await action(async () => { editing.value = false; clearResult(); detail.value = await api.detail(task.id);
    const latest = detail.value.runs.find(run => run.status === 'completed' && run.result);
    if (latest) await loadResult(latest.id);
    detailOpen.value=true;
  });
}
async function prepareEdit(template: TaskTemplate, task: TemplateTask) {
    const noForm=!!template.agent && !template.parameterUi;
    const view = noForm ? {html:''} : await api.input(template);
    direct.value=false;outputInstructions.value=task?.resultOutput?.instructions??template.resultOutput?.instructions??'';
    schedule.value=task?.schedule?structuredClone(JSON.parse(JSON.stringify(task.schedule))):{kind:'manual'};
    selectedTemplate.value = template; editingTask.value = task;
    name.value = task?.name ?? template.name; channel = crypto.randomUUID();
    inputHtml.value = view.html; editing.value = true; detailOpen.value=false;createStage.value=noForm?'basic':'parameters';parameters.value=task.parameters;prompt.value=task.prompt ?? template.agent?.prompt ?? '';
}
async function edit(template:TaskTemplate,task:TemplateTask){await action(()=>prepareEdit(template,task));}
async function editTask(task:TemplateTask){
  await action(async()=>{
    const latest=(await api.detail(task.id)).task;
    if(latest.mode==='direct'){editDirect(latest);return;}
    const {template}=await api.template(latest.templateId,latest.templateVersion);
    await prepareEdit(template,latest);
  });
}
async function editCurrent() {
  if (!detail.value) return;
  await editTask(detail.value.task);
}
function editDirect(task?:TemplateTask) {
  direct.value=true;selectedTemplate.value=null;editingTask.value=task;
  name.value=task?.name??'';prompt.value=task?.prompt??'';employeeId.value=task?.employeeId??props.employees?.[0]?.id??'general';
  outputInstructions.value=task?.resultOutput?.instructions??'';parameters.value={};
  schedule.value=task?.schedule?structuredClone(JSON.parse(JSON.stringify(task.schedule))):{kind:'manual'};
  inputHtml.value='';detailOpen.value=false;editing.value=true;createStage.value='basic';error.value='';
}
function send(message: Record<string, unknown>) {
  // Parameters are JSON data; Vue reactive proxies cannot cross postMessage's clone boundary.
  const payload = JSON.parse(JSON.stringify({ ...message, channel }));
  inputFrame.value?.contentWindow?.postMessage(payload, '*');
}
async function receive(event: MessageEvent) {
  if (!editing.value || event.source !== inputFrame.value?.contentWindow) return;
  if (event.data?.type === 'openclawx.task.ready') {
    send({ type: 'openclawx.task.init', parameters: parameters.value,submitLabel:'确认参数，下一步' }); return;
  }
  if(event.data?.type==='openclawx.task.request' && event.data.channel===channel) {
    const activeChannel=channel;try{const data=await parameterDataRequest(event.data.path,event.data.query);if(channel===activeChannel)send({type:'openclawx.task.response',id:event.data.id,data});}catch(cause){if(channel===activeChannel)send({type:'openclawx.task.response',id:event.data.id,error:cause instanceof Error?cause.message:'查询失败'});}return;
  }
  if (event.data?.type !== 'openclawx.task.submit' || event.data.channel !== channel || !selectedTemplate.value) return;
  if (busy.value) { send({ type: 'openclawx.task.saved', error: '正在处理，请稍后保存' }); return; }
  await action(async () => {
    try {
      parameters.value=(await api.validateParameters(selectedTemplate.value!,event.data.parameters)).parameters;
      send({type:'openclawx.task.saved',notice:'参数已确认'}); createStage.value='basic';
    } catch(cause) {send({type:'openclawx.task.saved',error:cause instanceof Error?cause.message:'参数无效'});throw cause;}
  });
}
async function saveTask() {
  if(!selectedTemplate.value&&!direct.value)return;
  if(!direct.value&&!editingTask.value){error.value='请通过任务应用创建任务';return;}
  await action(async()=>{
    const resultOutput={destination:'task-results' as const,instructions:outputInstructions.value};
    const checked=TaskScheduleSchema.safeParse(schedule.value);if(!checked.success)throw new Error('执行时间配置无效，请检查时间、间隔、星期或时区。');
    const input=direct.value?{mode:'direct' as const,name:name.value,employeeId:employeeId.value,prompt:prompt.value,resultOutput,schedule:checked.data}:{name:name.value,templateId:selectedTemplate.value!.id,templateVersion:selectedTemplate.value!.version,parameters:parameters.value,resultOutput,schedule:checked.data,...(selectedTemplate.value!.agent?{prompt:prompt.value}:{})};
    const {task}=await api.save(input,editingTask.value);
    editing.value=false;detailOpen.value=false;clearResult();detail.value=await api.detail(task.id);await reload();
    notice.value=`任务“${task.name}”已保存，可随时再次运行。`;
  });
}

async function loadResult(runId: string) {
  if (!detail.value) return;
  clearResult();
  const response = await api.result(detail.value.task.id, runId);
  result.value = response.result; report.value = response.html ?? ''; warning.value = response.warning ?? '';
  resultTab.value = response.html && response.result.presentation?.defaultTab !== 'data' ? 'report' : 'data';
}
async function toggleSchedule(){const task=detail.value?.task;if(!task?.schedule||task.schedule.kind==='manual')return;await action(async()=>{const {task:updated}=await api.schedule(task,{...task.schedule!,enabled:!(task.schedule as Exclude<TaskSchedule,{kind:'manual'}>).enabled} as TaskSchedule);detail.value!.task=updated;await reload();});}
async function run(task:TemplateTask|undefined=detail.value?.task) {
  if (!task||busy.value) return;
  runningTaskId.value=task.id;
  await action(async () => {
    const id = task.id;
    notice.value=`任务“${task.name}”正在提交执行…`;
    // Keep the request ID on transport failure so retry cannot duplicate execution.
    const requestId = pendingRequests.get(id) ?? crypto.randomUUID(); pendingRequests.set(id, requestId);
    monitorError.value='';monitorTarget.value={taskId:id,runId:requestId,taskName:task.name};
    const response = await api.run(id, requestId); pendingRequests.delete(id);
    detail.value = await api.detail(id); await reload();
    if (response.run.result&&detailOpen.value) await loadResult(response.run.id);
    if (response.run.status === 'failed'){notice.value='';error.value=`任务“${task.name}”执行失败：${response.run.error??'请查看运行记录'}`;}
    else notice.value=`任务“${task.name}”${response.run.status==='completed'?'已完成，可查看运行记录。':'已提交，可查看运行记录了解进度。'}`;
  });
  runningTaskId.value='';if(error.value){notice.value='';monitorError.value=error.value;}
}
async function download(format: TaskExportFormat) {
  if (!result.value || !detail.value) return;
  await action(async () => { await api.download(detail.value!.task.id, result.value!.runId, format); });
}

onMounted(() => {
  window.addEventListener('message', receive);
  void action(reload);
});
onBeforeUnmount(() => window.removeEventListener('message', receive));
</script>

<template>
  <div class="task-pilot">
    <TaskRunMonitor v-if="monitorTarget" :key="monitorTarget.runId" v-bind="monitorTarget" :request-error="monitorError" @close="monitorTarget=null" @open-conversation="id=>emit('open-conversation',id)" />
    <p class="intro">管理已保存的任务：修改配置、再次运行或删除。运行完成不会移除任务，历次结果独立保存。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="busy" role="status" class="intro">正在处理…</p>
    <div class="toolbar"><div><h2>任务管理</h2><p class="intro">通过任务应用填写参数，或直接描述工作来创建任务。</p></div><button class="primary" :disabled="busy" @click="editDirect()">＋ 直接创建任务</button></div>
    <Teleport to="body"><div v-if="editing" class="task-modal-backdrop" @click.self="!busy && (editing=false)"><section class="task-modal" role="dialog" aria-modal="true" :aria-label="createStage==='parameters'?'修改任务参数':'任务基本信息'">
      <header><div><small>{{createStage==='parameters'?'01 / 任务参数':'任务信息'}}</small><h2>{{createStage==='parameters'?'修改任务参数':editingTask?'编辑任务':'创建任务'}}</h2></div><button :disabled="busy" @click="editing=false">关闭</button></header>
      <p v-if="error" class="error" role="alert">{{error}}</p><p v-if="busy" role="status">正在处理…</p>
      <template v-if="selectedTemplate && createStage==='parameters'"><p class="intro">先填写执行参数，确认后再设置任务名称与提示词。</p><iframe ref="inputFrame" :key="channel" :srcdoc="inputHtml" sandbox="allow-scripts" referrerpolicy="no-referrer" title="任务参数" class="input-frame"></iframe><footer><button :disabled="busy" @click="editing=false">取消编辑</button></footer></template>
      <template v-else-if="selectedTemplate || direct"><label class="name-field">任务名称<input v-model="name" maxlength="120" :disabled="busy" placeholder="为任务命名"></label>
        <label v-if="direct" class="name-field">执行智能体<select v-model="employeeId" aria-label="执行智能体" :disabled="busy"><option v-if="!props.employees?.length" value="general">默认员工</option><option v-for="employee in props.employees" :key="employee.id" :value="employee.id">{{employeeDisplayName(employee,t)}}</option></select></label>
        <label v-if="direct || selectedTemplate?.agent" class="name-field">执行提示词<textarea v-model="prompt" rows="5" maxlength="8000" :disabled="busy" placeholder="说明要完成的工作、数据来源和交付要求"></textarea></label>
        <label class="name-field">结果输出位置<select disabled><option>任务运行记录（默认）</option></select></label><p class="intro">每次执行独立保存 json-result 结构化结果；失败原因也保留。暂不支持外部路径输出。</p>
        <label class="name-field">结果输出要求（可选）<textarea v-model="outputInstructions" rows="3" maxlength="4000" :disabled="busy" placeholder="例如：给出摘要、关键指标和后续行动；智能体执行时使用"></textarea></label>
        <TaskScheduleEditor v-model="schedule" :disabled="busy" />
        <details v-if="selectedTemplate && (!selectedTemplate.agent || selectedTemplate.parameterUi)"><summary>已确认的任务参数</summary><pre>{{JSON.stringify(parameters,null,2)}}</pre></details><footer><button v-if="selectedTemplate && (!selectedTemplate.agent || selectedTemplate.parameterUi)" :disabled="busy" @click="createStage='parameters'">返回修改参数</button><button class="primary" :disabled="busy || !name.trim() || ((direct || !!selectedTemplate?.agent) && !prompt.trim()) || (direct && !employeeId)" @click="saveTask">保存任务</button></footer></template>
    </section></div></Teleport>
    <div>
      <div class="toolbar"><h2>我的任务</h2><input v-model="query" placeholder="搜索任务名称" aria-label="搜索任务名称"><button :disabled="busy" @click="action(reload)">刷新</button></div>
      <p v-if="!tasks.length && !busy" class="empty">还没有任务。请在「任务应用」中填写参数，或直接创建任务。</p>
      <div class="task-list">
        <div v-for="task in tasks.filter(item => item.name.toLowerCase().includes(query.toLowerCase()))" :key="task.id" :class="['task-row', { active: detail?.task.id === task.id }]">
          <button class="task-open" :disabled="busy" @click="openTask(task)"><strong>{{ task.name }}</strong><span>{{task.mode==='direct'?'直接创建':'应用任务'}} · {{scheduleLabel(task)}} · v{{ task.revision }} · {{ date(task.updatedAt) }} · 查看任务 →</span></button>
          <div class="task-row-actions">
            <button v-if="runningTaskId===task.id" @click="reopenMonitor(task)">查看监控</button>
            <button :disabled="busy" :aria-label="`编辑任务：${task.name}`" @click="editTask(task)">编辑</button>
            <button class="primary" :disabled="busy" :aria-label="`立即运行任务：${task.name}`" @click="run(task)">{{runningTaskId===task.id?'正在运行…':'立即运行'}}</button>
            <button class="task-delete" :disabled="busy" :aria-label="`删除任务：${task.name}`" @click="deleteTask(task)">删除</button>
          </div>
        </div>
      </div>
      <Teleport to="body"><div v-if="detailOpen&&detail" class="task-modal-backdrop" @click.self="closeDetail" @keydown.esc="closeDetail"><section class="task-modal task-detail-modal" role="dialog" aria-modal="true" aria-labelledby="task-detail-title">
        <header><div><h2 id="task-detail-title">{{detail.task.name}}</h2><p class="intro">运行记录与结果</p></div><button :disabled="busy" @click="closeDetail">关闭</button></header>
        <p v-if="error" role="alert" class="error">{{error}}</p><p v-if="notice" role="status" class="notice">{{notice}}</p>
        <div class="toolbar"><div><p class="intro">{{detail.task.mode==='direct'?'直接创建':'应用任务'}} · 配置 v{{ detail.task.revision }} · {{scheduleLabel(detail.task)}}</p></div><button :disabled="busy" @click="editCurrent">编辑任务</button><button class="primary" :disabled="busy" @click="run(detail.task)">立即运行</button></div>
        <p v-if="detail.task.scheduleState?.nextRunAt" class="intro">下次自动执行：{{date(detail.task.scheduleState.nextRunAt)}}（当前设备时间）。可在“编辑任务”中暂停或修改周期。</p>
        <div v-if="detail.task.schedule && detail.task.schedule.kind!=='manual' && !(detail.task.schedule.kind==='once' && detail.task.scheduleState?.lastScheduledAt && detail.task.scheduleState.nextRunAt===null)" class="toolbar"><button :disabled="busy" @click="toggleSchedule">{{detail.task.schedule.enabled?'暂停自动执行':'启用自动执行'}}</button><span class="intro">暂停不影响已经开始的运行。</span></div>
        <p v-if="detail.task.scheduleState?.lastError" class="error">{{detail.task.scheduleState.lastError}}</p>
        <div class="pipeline"><span>① 参数准备</span><span>② 执行任务</span><span>③ 结果保存</span><span>④ 报告展示</span></div>
        <h3>运行记录</h3><p v-if="!detail.runs.length" class="intro">保存成功。点击“立即运行”生成第一份报告。</p>
        <div v-for="item in detail.runs" :key="item.id" class="run-row"><div><strong>{{ item.status === 'completed' ? '已完成' : item.status === 'failed' ? '失败' : '执行中 / 等待刷新' }}</strong><span> · {{ date(item.startedAt) }} · 参数 v{{ item.taskRevision }}</span><p v-if="item.error" class="error">{{ item.error }}</p><button v-if="item.sessionId" @click="emit('open-conversation',item.sessionId!)">查看执行对话 / 审批</button></div><button v-if="item.result" :disabled="busy" @click="action(() => loadResult(item.id))">{{ result?.runId === item.id ? '正在查看' : '查看结果' }}</button></div>
        <template v-if="result">
          <div class="toolbar result-heading"><div><h3>运行结果</h3><p class="intro">{{ date(result.createdAt) }} · 报告版本 {{ result.schemaVersion }}</p></div><button v-for="format in exportFormats" :key="format" :disabled="busy" @click="download(format)">下载 {{ format.toUpperCase() }}</button></div>
          <p v-if="warning" class="error">{{ warning }}</p>
          <div class="tabs"><button :class="{ active: resultTab === 'report' }" :disabled="!report" @click="resultTab = 'report'">报告</button><button :class="{ active: resultTab === 'data' }" @click="resultTab = 'data'">结构化数据</button><button :class="{ active: resultTab === 'input' }" @click="resultTab = 'input'">本次输入</button></div>
          <iframe v-if="resultTab === 'report'" :srcdoc="report" sandbox="allow-scripts" title="任务报告" referrerpolicy="no-referrer" class="report-frame"></iframe>
          <pre v-else>{{ JSON.stringify(resultTab === 'data' ? result.data : detail.runs.find(item => item.id === result?.runId)?.inputSnapshot, null, 2) }}</pre>
        </template>
      </section></div></Teleport>
    </div>
  </div>
</template>

<style scoped>
.notice{margin:12px 0;padding:12px 16px;border-radius:10px;background:var(--accent-soft);color:var(--accent);line-height:1.6}
.task-list .task-row{padding:0;align-items:center;border:1px solid var(--border);border-radius:10px;background:var(--surface);gap:0;overflow:hidden}
.task-list .task-row.active{border-color:var(--accent)}
.task-list .task-open{flex:1;min-width:0;display:flex;align-items:center;justify-content:space-between;gap:16px;text-align:left;padding:16px;border:0;border-radius:0;color:inherit}
.task-open strong{overflow-wrap:anywhere}.task-open span{text-align:right}
.task-list .task-delete{flex:none;margin:0;color:#b42338;border-color:transparent;white-space:nowrap}
.task-list .task-delete:hover{background:var(--surface-muted);border-color:#b42338}
.task-list button:focus-visible{outline:2px solid var(--accent);outline-offset:-3px}
@media(max-width:640px){.task-list .task-open{align-items:flex-start;flex-direction:column;gap:6px;padding:14px}.task-open span{text-align:left}.task-list .task-delete{min-height:44px;margin-right:8px}}
.task-modal select{font:inherit;border:1px solid var(--border);border-radius:9px;padding:10px;background:var(--surface);color:var(--text)}
.task-pilot{font-size:14px}.intro{color:var(--muted);font-size:13px;line-height:1.7;margin:6px 0 16px}.panel{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;margin-top:20px}h2{font-size:18px;font-weight:700}h3{font-weight:700;margin:16px 0 10px}button,input{border:1px solid var(--border);border-radius:9px;padding:9px 13px}button{cursor:pointer;background:var(--surface)}button:hover{border-color:var(--accent)}button:disabled{opacity:.5;cursor:default}input{background:var(--background);min-width:0}button.primary{background:var(--accent);color:white;border-color:var(--accent)}.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:18px 0}.toolbar>:first-child{flex:1}.toolbar p{margin-bottom:0}.task-list{display:grid;gap:8px}.task-row{display:flex;justify-content:space-between;text-align:left;gap:12px;padding:16px}.task-row span,.run-row span{color:var(--muted);font-size:12px}.active{border-color:var(--accent);color:var(--accent)}.name-field{display:grid;gap:8px;margin:18px 0}.input-frame{width:100%;height:570px;border:1px solid var(--border);border-radius:12px;background:white}.report-frame{width:100%;height:680px;border:0;border-radius:12px;background:white}.pipeline{display:flex;flex-wrap:wrap;gap:12px;padding:14px;background:var(--accent-soft);border-radius:10px;color:var(--accent);font-size:12px}.run-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);padding:12px 0}.result-heading{border-top:1px solid var(--border);padding-top:16px}.tabs{display:flex;gap:8px;margin:12px 0}.error{color:#c43d4f;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}.empty{padding:24px;color:var(--muted);text-align:center}pre{background:var(--surface-muted);padding:18px;border-radius:10px;max-height:600px;overflow:auto;font-size:12px}
.task-modal-backdrop{position:fixed;inset:0;z-index:3000;background:rgba(15,23,42,.5);backdrop-filter:blur(8px);display:grid;place-items:center;padding:24px}.task-modal{width:min(940px,100%);max-height:92vh;overflow:auto;background:var(--surface,#fff);color:var(--text,#172033);border:1px solid var(--border,#dbe2ee);border-radius:22px;box-shadow:0 24px 90px #08132640;padding:28px}.task-modal header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:20px}.task-modal header small{color:var(--accent);font-size:11px;letter-spacing:.12em}.task-modal footer{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}.task-modal textarea{font:inherit;border:1px solid var(--border);border-radius:10px;padding:14px;background:var(--background);color:inherit}@media(max-width:640px){.task-modal-backdrop{padding:10px}.task-modal{padding:18px;border-radius:16px}.input-frame{height:55vh}}
.task-row-actions{display:flex;align-items:center;gap:8px;padding:10px 12px;flex-shrink:0}
.task-row-actions button{white-space:nowrap;min-height:40px}
.task-detail-modal{width:min(1100px,100%)}
@media(max-width:860px){.task-list .task-row{flex-wrap:wrap}.task-list .task-open{flex-basis:100%}.task-row-actions{justify-content:flex-end;width:100%;padding-top:0}.task-list .task-delete{margin:0}}
</style>
