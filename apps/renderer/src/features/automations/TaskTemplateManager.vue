<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue';
import { parameterDataRequest } from '../../services/task-parameter-bridge';
import {parameterValidator,parameterValidationMessage,TaskTemplateProblemSchema,type TaskTemplateProblem} from '@workmate/contracts';
import type { Employee } from '../../app/workspace';
import {employeeDisplayName} from '../../app/employees';
import {useI18n} from '../../app/i18n';
const {t}=useI18n();
const props = defineProps<{employees?:Employee[]; returnDefinitionId?:string;returnProjectId?:string}>();
import { templateTasksApi as api, type TaskTemplate, type TaskTemplateConfiguration, type TaskTemplateDefinition, type TaskSkillDescriptor, type TaskTemplateTrial } from '../../services/template-tasks';

const emit = defineEmits<{ changed: []; 'open-project':[id:string, definitionId:string] }>();
const definitions = ref<TaskTemplateDefinition[]>([]), templates = ref<TaskTemplate[]>([]), skills = ref<TaskSkillDescriptor[]>([]);
const configuration = ref<TaskTemplateConfiguration | null>(null), record = ref<TaskTemplateDefinition>();
const pendingParameters = ref(false);
const parameterPurpose = ref<'defaults'|'test'>('defaults');
const testParameters = ref<Record<string,unknown>|null>(null);
const parameterEditor = ref(false), editorDialog = ref<HTMLDialogElement | null>(null), parameterDialog = ref<HTMLDialogElement | null>(null);
watch(() => !!configuration.value, async open => { await nextTick(); if(open && !editorDialog.value?.open) editorDialog.value?.showModal(); });
watch(parameterEditor, async open => { await nextTick(); if(open && !parameterDialog.value?.open) parameterDialog.value?.showModal(); });
const busy = ref(false), error = ref(''), notice = ref(''), step = ref(0), saved = ref('');
const parameterError = ref('');
const parameterProblem=ref<TaskTemplateProblem|null>(null);
const confirmingParameters = ref(false);
let confirmationTimer: ReturnType<typeof setTimeout> | undefined;
function stopConfirmation() {
  clearTimeout(confirmationTimer);confirmationTimer=undefined;confirmingParameters.value=false;
}
const trial = ref<TaskTemplateTrial | null>(null), frame = ref<HTMLIFrameElement | null>(null), html = ref(''), channel = ref('');
const verificationLabel = computed(() => configuration.value?.agent ? '配置验证' : '试运行');
const steps = computed(() => ['基本信息', '输入参数', '执行能力', '任务报告查看', `${verificationLabel.value}与发布`]);
const dirty = computed(() => !!configuration.value && JSON.stringify(configuration.value) !== saved.value);
const verified = computed(() => !!record.value && record.value.verifiedRevision === record.value.revision && !dirty.value);
const published = computed(() => record.value?.published.some(item => item.version === record.value?.draft.version) && !dirty.value);
const parameterUiPublished=computed(()=>!!configuration.value?.parameterUi && !!record.value?.published.some(item=>item.parameterUi?.revision===configuration.value?.parameterUi?.revision));
const reportUiPublished=computed(()=>!!configuration.value?.reportUi&&!!record.value?.published.some(item=>item.reportUi?.revision===configuration.value?.reportUi?.revision));
const reportPreview=ref(''),reportDialog=ref<HTMLDialogElement>();
const date = (time: number) => new Date(time).toLocaleString('zh-CN');
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
async function action(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';parameterProblem.value=null;
  try { await fn(); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause);const parsed=TaskTemplateProblemSchema.safeParse(cause);if(parsed.success)parameterProblem.value=parsed.data; }
  finally { busy.value = false; }
}
async function refresh() {
  const [defs, list, capabilities] = await Promise.all([api.definitions(), api.templates(), api.skills()]);
  definitions.value = defs.definitions; templates.value = list.templates; skills.value = capabilities.skills;
}
function configOf(template: TaskTemplate): TaskTemplateConfiguration {
  const { id: _id, version: _version, ...config } = clone(template);
  return { ...config, defaults: config.defaults ?? {},
    resultOutput:config.resultOutput??{destination:'task-results',instructions:''},
    presentation: config.presentation ?? { title: '', accent: 'blue', showRows: true, showSummary: true, defaultTab: 'report' },
    delivery: config.delivery ?? { storage: 'task-results', exports: ['json', 'html', 'csv'] },
  };
}
function start(template: TaskTemplate, definition?: TaskTemplateDefinition) {
  configuration.value = configOf(template); record.value = definition;
  if (!definition) configuration.value.name += '（自定义）';
  saved.value = definition ? JSON.stringify(configuration.value) : '';
  pendingParameters.value = false; step.value = 0; trial.value = null; html.value = ''; error.value = ''; notice.value = '';
  testParameters.value=null;parameterProblem.value=null;
}
function newTemplate() {
  if(!templates.value[0])return;
  start(templates.value[0]);
  if(configuration.value){configuration.value.name='新任务模板';configuration.value.description='';configuration.value.defaults={};configuration.value.agent={employeeId:props.employees?.[0]?.id??'general',prompt:'请根据用户确认的参数完成任务，并输出清晰的结果。'};}
}
function close() {
  if ((dirty.value || pendingParameters.value) && !window.confirm('当前修改尚未保存，确定离开模板编辑？')) return;
  configuration.value = null;
}
async function openParameters() {
  await action(async () => { parameterPurpose.value='defaults';await loadInput(); pendingParameters.value=false; parameterEditor.value=true; });
}
async function openTestParameters() {
  await action(async () => {
    await save();if(configuration.value?.parameterUi)await syncParameterUi();await syncReportUi();
    if(configuration.value?.agent && !configuration.value.parameterUi){
      await verifyConfiguration(clone(configuration.value.defaults ?? {}));return;
    }
    parameterPurpose.value='test';await loadInput();pendingParameters.value=false;parameterEditor.value=true;
  });
}
function closeParameters() {
  if (pendingParameters.value && !window.confirm('参数修改尚未应用，确定放弃本次修改？')) return;
  stopConfirmation();pendingParameters.value=false;parameterEditor.value=false;html.value='';channel.value=crypto.randomUUID();
}
function returnToConfiguration(index:number) {
  const reason=parameterError.value;
  closeParameters();if(parameterEditor.value)return;
  step.value=index;error.value='';notice.value=`${reason} 已返回${index===2?'执行能力':'模板设置'}，请修改后重新验证。`;
}
function binding(stage: 'input' | 'execution' | 'output' | 'view', event: Event) {
  if (!configuration.value) return;
  const skill = skills.value.find(item => `${item.id}@${item.version}` === (event.target as HTMLSelectElement).value);
  if (!skill) return;
  configuration.value[stage] = { skillId: skill.id, version: skill.version, entry: skill.entries[stage] };
  if (stage === 'output') {
    configuration.value.resultType = skill.resultType; configuration.value.resultVersion = skill.resultVersion;
    configuration.value.delivery!.exports = configuration.value.delivery!.exports.filter(format => skill.exports.includes(format));
  }
  if (stage === 'input') { delete configuration.value.parameterUi; configuration.value.defaults = {}; void action(loadInput); }
  trial.value = null;
}
async function loadInput() {
  if (!configuration.value) return;
  const input = configuration.value.input;
  stopConfirmation();html.value = ''; parameterError.value=''; channel.value = crypto.randomUUID();
  html.value = configuration.value.parameterUi && record.value ? (await api.previewInput(record.value)).html : (await api.skillInput(input.skillId, input.version)).html;
}
async function go(index: number) {
  await action(async () => { step.value = index; });
}
function send(message: Record<string, unknown>) {
  frame.value?.contentWindow?.postMessage(clone({ ...message, channel: channel.value }), '*');
}
function confirmParameters() {
  if(busy.value||confirmingParameters.value)return;
  parameterError.value='';
  confirmingParameters.value=true;
  const activeChannel=channel.value;
  confirmationTimer=setTimeout(()=>{
    if(channel.value!==activeChannel)return;
    stopConfirmation();parameterError.value='参数页面未响应，请重试。若仍无响应，请重新打开验证窗口，或检查参数 UI 的提交逻辑。';
  },5000);
  send({type:'workmate.task.confirm'});
}
async function receive(event: MessageEvent) {
  if (event.source !== frame.value?.contentWindow || !configuration.value) return;
  if(event.data?.type==='workmate.task.confirm-error' && event.data.channel===channel.value){stopConfirmation();parameterError.value=event.data.error || '请检查表单中的必填项。';return;}
  if (event.data?.type === 'workmate.task.request' && event.data.channel === channel.value) {
    const activeChannel = channel.value;
    try {const data=await parameterDataRequest(event.data.path,event.data.query);if(channel.value===activeChannel)send({type:'workmate.task.response',id:event.data.id,data});}
    catch(cause){if(channel.value===activeChannel)send({type:'workmate.task.response',id:event.data.id,error:cause instanceof Error?cause.message:'数据查询失败'});}
    return;
  }
  if (event.data?.type === 'workmate.task.dirty' && event.data.channel === channel.value) { pendingParameters.value = true;if(parameterPurpose.value==='test'){trial.value=null;if(record.value)record.value.verifiedRevision=undefined;} return; }
  if (event.data?.type === 'workmate.task.ready') {
    send({ type: 'workmate.task.init', parameters: parameterPurpose.value==='test' ? testParameters.value ?? configuration.value.defaults : configuration.value.defaults, submitLabel: parameterPurpose.value==='test' ? (configuration.value.agent ? '验证配置' : '确认并试运行') : '应用为默认参数' });
  } else if (event.data?.type === 'workmate.task.submit' && event.data.channel === channel.value) {
    stopConfirmation();
    if (busy.value) { send({ type: 'workmate.task.saved', error: '正在处理，请稍后应用参数' }); return; }
    if(parameterPurpose.value==='test'){trial.value=null;if(record.value)record.value.verifiedRevision=undefined;}
    if (configuration.value.parameterUi) {
      try {
        const schema=JSON.parse(configuration.value.parameterUi.files['input.schema.json']);
        const parsed=parameterValidator(schema).safeParse(event.data.parameters);
        if(!parsed.success){pendingParameters.value=true;parameterError.value=parameterValidationMessage(parsed.error,schema,parameterPurpose.value);send({type:'workmate.task.saved',error:parameterError.value});return;}
      } catch(cause) {parameterError.value=cause instanceof Error?cause.message:'参数 Schema 无效';send({type:'workmate.task.saved',error:parameterError.value});return;}
    }
    if(parameterPurpose.value==='test') {
      const activeChannel=channel.value;
      testParameters.value=clone(event.data.parameters);pendingParameters.value=false;trial.value=null;
      send({type:'workmate.task.saved',notice:'参数已确认，正在验证配置…'});
      await runTrial();
      if(channel.value!==activeChannel)return;
      if(verified.value && !error.value){parameterEditor.value=false;html.value='';channel.value=crypto.randomUUID();}
      else {parameterError.value=error.value || '验证未完成，请检查配置后重试。';send({type:'workmate.task.saved',error:parameterError.value});}
      return;
    }
    configuration.value.defaults = clone(event.data.parameters); pendingParameters.value = false; trial.value = null;
    send({ type: 'workmate.task.saved', notice: '默认参数已应用，请保存草稿后试运行。' });
    notice.value = '默认参数已应用，保存草稿后会用于新建任务。';
    parameterEditor.value=false;
  }
}
async function save() {
  if (pendingParameters.value) throw new Error('请先在参数表单内点击“应用为默认参数”，再保存草稿。');
  if (!configuration.value) return;
  if (record.value && !dirty.value) return;
  const response = await api.saveDefinition(clone(configuration.value), record.value);
  record.value = response.definition; configuration.value = configOf(response.definition.draft);
  saved.value = JSON.stringify(configuration.value); trial.value = null;
  await refresh(); notice.value = `草稿已保存。发布前需要对当前版本完成${verificationLabel.value}。`;
}
async function runTrial() {
  if(configuration.value?.agent && !configuration.value.parameterUi){await openTestParameters();return;}
  if(testParameters.value===null){await openTestParameters();return;}
  const parameters=clone(testParameters.value);
  await action(async () => {
    await save();
    if (!record.value) return;
    // A fresh attempt invalidates earlier validation, including failed attempts.
    record.value.verifiedRevision = undefined;
    trial.value = null;
    await verifyConfiguration(parameters);
  });
}
async function verifyConfiguration(parameters:Record<string,unknown>) {
  if(!record.value)return;
  record.value.verifiedRevision=undefined;trial.value=null;
  trial.value=await api.trial(record.value,parameters);
  record.value.verifiedRevision=record.value.revision;step.value=4;
  await refresh();notice.value=`${verificationLabel.value}通过。下一步：点击底部“发布模板”。`;
}
async function publish() {
  await action(async () => {
    if (!record.value || !verified.value) return;
    record.value = (await api.publish(record.value)).definition;
    await refresh(); emit('changed'); notice.value = `版本 ${record.value.draft.version} 已发布，可在“任务管理”中从模板创建任务并运行。`;
  });
}
async function openParameterProject() {
  await action(async () => { await save(); if(!record.value)return;
    const {projectId}=await api.parameterProject(record.value,configuration.value?.agent?.employeeId??'general');
    emit('open-project',projectId,record.value.id);
  });
}
async function importParameterUi() {
  await openTestParameters();
}
async function syncParameterUi() {
  if(!record.value?.parameterProjectId)return;
  const updated=(await api.importParameterUi(record.value)).definition;
  if(updated.revision!==record.value.revision){record.value=updated;configuration.value=configOf(updated.draft);saved.value=JSON.stringify(configuration.value);trial.value=null;testParameters.value=null;}
}
async function syncReportUi() {
  if(!record.value?.reportProjectId||!configuration.value?.reportUi)return;
  const updated=(await api.importReportUi(record.value)).definition;
  if(updated.revision!==record.value.revision){record.value=updated;configuration.value=configOf(updated.draft);saved.value=JSON.stringify(configuration.value);trial.value=null;}
}
async function openReportProject(){await action(async()=>{await save();if(!record.value)return;const {projectId}=await api.reportProject(record.value,configuration.value?.agent?.employeeId??'general');emit('open-project',projectId,record.value.id);});}
async function previewReport(){await action(async()=>{await save();if(!record.value)return;await syncReportUi();reportPreview.value=(await api.previewReport(record.value)).html;reportDialog.value?.showModal();});}
function useDefaultReport(){if(!configuration.value)return;delete configuration.value.reportUi;trial.value=null;notice.value='已切回默认任务报告，保存并验证后发布生效。';}
function toggleAgent(event:Event) {
  if(!configuration.value)return;
  if((event.target as HTMLInputElement).checked) configuration.value.agent={employeeId:'general',prompt:'请根据用户确认的参数完成任务，并输出清晰的结果。'};
  else delete configuration.value.agent;
  trial.value=null;
}
async function archive(definition: TaskTemplateDefinition) {
  await action(async () => { await api.archive(definition, !definition.archived); await refresh(); emit('changed'); });
}
async function removeDefinition(definition:TaskTemplateDefinition) {
  if(busy.value||!window.confirm(`删除模板“${definition.draft.name}”？\n删除后不能再用它创建任务。已有任务、定时执行、运行记录和项目文件将保留。`))return;
  await action(async()=>{await api.deleteDefinition(definition);await refresh();emit('changed');notice.value='模板已删除，已有任务和运行记录不受影响。';});
}
async function restoreTemplate() {
  await refresh();
  if (!props.returnDefinitionId) return;
  const {definition}=await api.definition(props.returnDefinitionId);
  start(definition.draft,definition);step.value=props.returnProjectId&&definition.reportProjectId===props.returnProjectId?3:1;
  if(step.value===3){const updated=(await api.importReportUi(definition)).definition;record.value=updated;configuration.value=configOf(updated.draft);saved.value=JSON.stringify(configuration.value);notice.value='已返回模板，任务报告界面已同步到草稿。完成配置后验证并发布。';return;}
  await syncParameterUi();
  notice.value=configuration.value?.parameterUi ? '已返回模板，参数界面已准备好。可继续编辑，或点击下一步完成配置；发布前统一验证。' : '已返回模板。请先编辑参数界面，再继续配置。';
}
onMounted(() => { window.addEventListener('message', receive); void action(restoreTemplate); });
watch(()=>JSON.stringify(configuration.value),()=>{trial.value=null;});
watch(()=>JSON.stringify([configuration.value?.parameterUi,configuration.value?.input,configuration.value?.defaults]),()=>{testParameters.value=null;});
onBeforeUnmount(() => {stopConfirmation();window.removeEventListener('message', receive);});
</script>

<template>
  <div class="manager">
    <div class="heading"><div><h2>模板管理</h2><p>管理可复用的任务配置；普通任务无需创建模板。</p></div><button v-if="!configuration" :disabled="busy || !templates.length" class="primary" @click="newTemplate">＋ 新建模板</button></div>
    <p v-if="notice && !configuration" role="status" class="notice">{{notice}}</p>
    <p v-if="error && !configuration" role="alert" class="error">{{ error }}</p><p v-if="busy && !configuration" class="muted" role="status">正在处理…</p>
      <section class="card"><h3>内置起点</h3><p>从已接通的 Skill 模板复制配置。当前支持经营数据汇总，执行无需模型。</p><button :disabled="busy || !templates.length" @click="start(templates[0])">复制经营汇总模板</button></section>
      <h3 class="section-title">我的模板</h3><p v-if="!definitions.length" class="empty">尚无自定义模板。新建后可编辑参数界面、选择执行员工并设置结果展示。</p>
      <article v-for="item in definitions" :key="item.id" class="definition card">
        <div><h3>{{ item.draft.name }} <span class="badge">{{ item.archived ? '已停用' : item.published.length ? '已发布' : '草稿' }}</span></h3><p>{{ item.draft.description || '尚未填写说明' }}</p><small>草稿 {{ item.draft.version }} · 已发布 {{ item.published.length }} 个版本 · {{ date(item.updatedAt) }}</small></div>
        <div class="buttons"><button :disabled="busy" @click="start(item.draft, item)">配置模板</button><button :disabled="busy" @click="start(item.draft)">复制</button><button :disabled="busy" @click="archive(item)">{{ item.archived ? '恢复' : '停用' }}</button><button :disabled="busy" class="error" @click="removeDefinition(item)">删除</button></div>
      </article>
    <Teleport to="body"><dialog v-if="configuration" ref="editorDialog" class="template-dialog editor" aria-label="编辑任务模板" @cancel.prevent="!busy && close()">
      <div class="heading dialog-heading"><div><h3>{{ configuration.name || '新模板' }}</h3><p>{{ record ? `草稿 ${record.draft.version}` : '新建草稿' }} · {{ dirty ? '有未保存修改' : '已保存' }}<span v-if="record?.archived"> · 已停用，请返回列表恢复后发布</span></p></div><button :disabled="busy" @click="close">关闭</button></div>
      <nav class="steps" aria-label="模板配置步骤"><button v-for="(label, index) in steps" :key="label" :disabled="busy" :class="{ active: step === index }" @click="go(index)">{{ index + 1 }}. {{ label }}</button></nav>
      <fieldset :disabled="busy" class="stage">
        <p v-if="error && step !== 4" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status" class="notice">{{ notice }}</p><p v-if="busy" role="status">正在处理…</p>
        <div v-if="step === 0" class="fields">
          <label>模板名称<input v-model="configuration.name" maxlength="120" placeholder="例如：华东月度经营汇总"></label>
          <label>模板说明<textarea v-model="configuration.description" maxlength="1000" rows="3" placeholder="说明适用场景、需要的数据和交付内容"></textarea></label>
          <div class="hint">每次发布生成独立版本。修改草稿不会改变已发布版本、已有任务或历史结果。</div>
        </div>
        <div v-else-if="step === 1">
          <section class="parameter-ui-entry"><div class="heading"><h3>用户参数界面</h3><span v-if="configuration.parameterUi" class="badge">{{ parameterUiPublished ? '已有已发布界面' : '已有界面草稿' }}</span><span v-else-if="record?.parameterProjectId" class="badge">编辑项目已创建</span></div>
          <p>{{ configuration.parameterUi ? '界面已准备好。可继续编辑；修改只更新草稿，不影响已发布任务。' : record?.parameterProjectId ? '编辑项目已创建，可继续编辑；未导入界面时仍可直接使用任务提示词。' : configuration.agent ? '可选。不需要收集参数时直接点击下一步，任务按提示词执行。' : '未定制时使用执行能力自带的参数表单，也可进入编辑器定制。' }}</p>
          <div class="buttons"><button type="button" class="primary" @click="openParameterProject">{{ record?.parameterProjectId ? '继续编辑' : '去编辑' }}</button><button v-if="record?.parameterProjectId" type="button" @click="importParameterUi">验证参数界面</button></div></section>
        </div>
        <div v-else-if="step === 2" class="fields">
          <div v-if="configuration.parameterUi && !configuration.agent" class="hint"><strong>当前使用固定 Skill，不会调用智能体</strong><p>自定义参数界面必须符合下方 Skill 的输入要求。若希望数字员工根据这些参数工作，请启用“使用智能体执行”，并选择执行员工。</p></div>
          <label class="checks"><input type="checkbox" :checked="!!configuration.agent" @change="toggleAgent">使用智能体执行</label>
          <template v-if="configuration.agent"><label>默认执行智能体<select v-model="configuration.agent.employeeId"><option v-if="!props.employees?.length" value="general">默认员工</option><option v-for="employee in props.employees" :key="employee.id" :value="employee.id">{{employeeDisplayName(employee,t)}}</option></select></label><label>默认执行提示词<textarea v-model="configuration.agent.prompt" rows="5" maxlength="8000"></textarea></label><p>使用员工已有的模型、Skill、MCP 与审批，按提示词执行。参数界面可选；有参数时作为 JSON 数据交给员工。结果保存在任务运行记录。</p></template>
          <label v-else>执行 Skill<select :value="`${configuration.execution.skillId}@${configuration.execution.version}`" @change="binding('execution', $event)"><option v-for="skill in skills" :key="skill.id" :value="`${skill.id}@${skill.version}`">{{ skill.name }} · {{ skill.version }}</option></select></label>
          <div v-if="!configuration.agent" class="hint">当前执行方式：已注册的 Skill 入口。经营汇总按金额计算，无需模型，不调用外部业务接口。</div>
          <details v-if="!configuration.agent"><summary>能力说明</summary><p v-for="skill in skills.filter(item => item.id === configuration?.execution.skillId)" :key="skill.id">{{ skill.description }}</p></details>
          <label>结果输出位置<select disabled><option>任务运行记录（默认）</option></select></label><p>每次运行独立保存 json-result 结构化结果；失败原因也会保留。暂不支持外部路径输出。</p>
          <label>结果输出要求（可选）<textarea v-model="configuration.resultOutput!.instructions" rows="3" maxlength="4000" placeholder="例如：给出摘要、关键指标和后续行动；智能体执行时使用"></textarea></label>
          <div v-if="!configuration.agent"><strong>允许导出</strong><div class="checks"><label v-for="format in skills.find(item => item.id === configuration?.output.skillId)?.exports ?? []" :key="format"><input v-model="configuration.delivery!.exports" type="checkbox" :value="format">{{ { json: 'JSON 数据', html: 'HTML 报告', csv: 'CSV 明细' }[format] }}</label></div></div>
        </div>
        <div v-else-if="step === 3" class="fields">
          <section class="parameter-ui-entry"><div class="heading"><h3>任务报告查看</h3><span class="badge">{{configuration.reportUi?(reportUiPublished?'已有已发布界面':'已有界面草稿'):'默认结果界面'}}</span></div>
          <p>默认显示本次任务的结果内容。需要定制摘要、表格或图表时，进入编辑器；不会改变结果存储或历史报告。</p>
          <div class="buttons"><button class="primary" @click="openReportProject">{{record?.reportProjectId?'继续编辑':'去编辑'}}</button><button @click="previewReport">预览报告</button><button v-if="configuration.reportUi" @click="useDefaultReport">使用默认界面</button></div></section>
        </div>
        <div v-else>
          <div class="hint">{{ configuration.agent ? '配置验证只检查参数界面、测试参数与智能体配置，不调用模型或工具，也不代表任务已实际执行。发布后，请在任务管理中从此模板创建任务并运行，真实结果保存在任务运行记录。' : '使用独立测试参数实际执行已注册的 Skill，预览计算、格式化与报告结果；不创建正式任务。' }} 测试参数不会保存为模板默认值。</div>
          <div class="release-status" role="status"><strong>{{ published ? '当前版本已发布' : record?.archived ? '模板已停用' : verified ? '验证通过，可以发布' : '下一步：验证配置' }}</strong><p>{{ published ? '可在任务管理中选择此模板创建任务。' : record?.archived ? '请关闭编辑窗口，在模板列表恢复后再发布。' : verified ? '发布后即可从模板创建任务并运行。' : configuration.agent && !configuration.parameterUi ? '未定制参数界面，点击配置验证即可；报告使用默认界面或已有定制。' : '填写一次验证参数，检查配置是否可用；不会保存为默认参数。' }}</p></div>
          <div v-if="verified && !published" class="buttons trial-actions"><button @click="openTestParameters">{{configuration.agent && !configuration.parameterUi?'重新验证配置':'修改验证参数并重新验证'}}</button></div>
          <p v-if="error" role="alert" class="error">{{ error }}</p>
          <p v-if="verified" class="notice">当前草稿已通过{{ verificationLabel }}{{ configuration.agent ? '（未实际运行智能体）' : '' }}。</p><p v-else class="muted">发布前必须通过当前草稿的{{ verificationLabel }}；修改配置后需重新验证。默认参数可以留空。</p>
          <ul v-if="trial && !dirty" class="checklist"><li v-for="check in trial.checks" :key="check">✓ {{ check }}</li></ul>
          <iframe v-if="trial && !dirty && !configuration.agent" :srcdoc="trial.html" sandbox="allow-scripts" referrerpolicy="no-referrer" title="模板报告预览" class="report-frame"></iframe>
          <details v-if="record?.published.length"><summary>已发布版本（不可覆盖）</summary><p v-for="version in record.published" :key="version.version">{{ version.version }} · {{ version.name }}</p></details>
        </div>
      </fieldset>
      <footer><span class="muted" role="status">{{ busy ? '正在处理，请稍候…' : published ? '已发布，可创建任务使用' : step===4 && verified ? '验证通过，可以发布' : dirty ? '尚未保存' : '草稿已保存' }}</span><button :disabled="busy || step === 0" @click="go(step - 1)">上一步</button><button :disabled="busy" @click="action(save)">保存草稿</button><button v-if="step < 4" class="primary" :disabled="busy" @click="go(step + 1)">下一步</button><button v-else-if="!verified && !published" class="primary" :disabled="busy || !!record?.archived" @click="runTrial">{{ busy ? '正在验证…' : verificationLabel }}</button><button v-else class="primary" :disabled="busy || !verified || !!record?.archived || !!published" @click="publish">{{ published ? '当前版本已发布' : '发布模板' }}</button></footer>
    </dialog>
    <dialog v-if="parameterEditor && configuration" ref="parameterDialog" class="template-dialog parameter-dialog" :aria-label="parameterPurpose==='test' ? '填写测试参数' : '设置用户默认参数'" @cancel.prevent="!busy && closeParameters()">
      <div class="heading dialog-heading"><div><h3>{{ parameterPurpose==='test' ? '验证参数' : '默认参数（可选）' }}</h3><p>{{ parameterPurpose==='test' ? (configuration.agent ? '填写后点击底部“验证配置”。只检查配置，不执行任务，也不保存为默认值。' : '填写后点击底部“确认并试运行”。将执行当前 Skill，不创建正式任务。') : '为新任务预填常用值；点击底部“应用为默认参数”保存本次填写。' }}</p></div></div>
      <iframe v-if="html" ref="frame" :key="channel" :srcdoc="html" sandbox="allow-scripts" referrerpolicy="no-referrer" :title="parameterPurpose==='test' ? '模板测试参数' : '模板默认参数'" class="input-frame"></iframe>
      <section v-if="parameterError" class="validation-failure" role="alert"><strong>验证未通过</strong><p>{{ parameterError }}</p><div class="buttons"><button v-if="parameterProblem?.target==='execution'" :disabled="busy" class="primary" @click="returnToConfiguration(2)">返回执行配置</button><button v-if="parameterProblem?.target==='execution'" :disabled="busy" @click="returnToConfiguration(1)">修改参数界面</button><button v-else :disabled="busy" @click="returnToConfiguration(4)">返回模板设置</button></div></section>
      <footer class="parameter-footer"><div class="parameter-feedback"><span class="muted" role="status">{{ busy ? '正在验证配置，请稍候…' : confirmingParameters ? '正在读取表单参数…' : parameterError ? '请按上方建议修改；验证通过后才能发布。' : parameterPurpose==='test' ? '验证成功后自动进入发布页。' : '默认参数可留空，不影响用户创建任务时填写。' }}</span></div><button :disabled="busy" @click="closeParameters">取消</button><button v-if="parameterProblem?.target!=='execution'" class="primary" :disabled="busy || confirmingParameters || !html" @click="confirmParameters">{{ busy ? '正在验证…' : confirmingParameters ? '正在确认…' : parameterError ? '重试验证' : parameterPurpose==='test' ? (configuration.agent ? '验证配置' : '确认并试运行') : '应用为默认参数' }}</button></footer>
    </dialog></Teleport>
    <Teleport to="body"><dialog ref="reportDialog" class="template-dialog" aria-label="任务报告设计预览"><div class="heading"><h3>任务报告查看 · 设计预览</h3><button @click="reportDialog?.close()">关闭预览</button></div><p>以下为设计示例，非真实任务结果。正式运行后使用该次结果。</p><iframe v-if="reportPreview" :srcdoc="reportPreview" sandbox="allow-scripts" title="任务报告预览" referrerpolicy="no-referrer" class="input-frame"></iframe></dialog></Teleport>
  </div>
</template>

<style scoped>
.stage .error{max-height:160px;overflow:auto;padding:12px;border-radius:10px;background:#be33470a}
.parameter-ui-entry{border:1px solid var(--border);border-radius:12px;padding:24px}.parameter-ui-entry .heading{margin-bottom:8px;justify-content:flex-start}.parameter-ui-entry .buttons{margin-top:20px}
.validation-failure{flex-shrink:0;margin-top:12px;padding:12px;border:1px solid #be334740;border-radius:10px;background:#be334708;color:#9d2639}.validation-failure p{color:inherit;max-height:90px;overflow:auto;margin:6px 0 10px}.validation-failure .buttons{gap:8px}
.release-status{margin-top:20px;padding:16px;border:1px solid var(--border);border-radius:10px}.release-status strong{font-size:15px}.parameter-footer{margin-top:16px}.parameter-feedback{flex:1;min-width:0}.parameter-feedback p{margin:0;max-height:70px;overflow:auto}.parameter-footer button{flex-shrink:0}
@media(max-width:700px){.parameter-footer .parameter-feedback{flex-basis:100%}.parameter-footer{row-gap:10px}}
.template-dialog{padding:24px;border:1px solid var(--border);border-radius:20px;background:var(--surface);color:var(--text);width:min(960px,calc(100vw - 32px));height:min(820px,calc(100dvh - 40px));max-height:calc(100dvh - 40px);box-shadow:0 24px 80px #17213c30;font:14px system-ui}.template-dialog[open]{display:flex;flex-direction:column;gap:0}.template-dialog::backdrop{background:#17213c66;backdrop-filter:blur(3px)}.template-dialog>.heading,.template-dialog>.steps,.template-dialog>footer{flex-shrink:0}.template-dialog>.stage{flex:1;min-height:0;overflow:auto;padding:20px 4px}.parameter-dialog>.input-frame{flex:1;min-height:0;height:auto}.parameter-entry{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 0}.parameter-entry button{flex-shrink:0}.parameter-warning{padding:10px 12px;background:#fff4de;color:#8a5a13;border-radius:8px}@media(max-width:700px){.template-dialog{padding:16px;width:calc(100vw - 16px);height:calc(100dvh - 24px);max-height:calc(100dvh - 24px);border-radius:14px}.parameter-entry{align-items:flex-start;flex-direction:column}.template-dialog footer{flex-wrap:wrap}.template-dialog .steps{gap:6px}.template-dialog .steps button{font-size:12px;padding:7px}}
.manager{font-size:14px}.heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.heading>div{flex:1}h2{font-size:22px;font-weight:700}h3{font-size:16px;font-weight:700}p{color:var(--muted);line-height:1.7;margin:8px 0}.card{border:1px solid var(--border);border-radius:16px;background:var(--surface);padding:24px;margin-bottom:16px}button,input,textarea,select{font:inherit;border:1px solid var(--border);border-radius:9px;padding:9px 12px;background:var(--surface);color:var(--text)}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}button:hover:not(:disabled){border-color:var(--accent)}button.primary{background:var(--accent);color:white;border-color:var(--accent)}.definition{display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap}.buttons,.checks{display:flex;gap:12px;flex-wrap:wrap}.badge{font-size:11px;background:var(--accent-soft);color:var(--accent);padding:3px 7px;border-radius:5px}.section-title{margin:24px 0 12px}.empty{padding:24px;text-align:center;color:var(--muted)}small,.muted{color:var(--muted);font-size:12px}.steps{display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:18px}.steps .active{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}.stage{border:0;padding:24px 0;min-width:0}.fields{display:grid;gap:20px}label{display:grid;gap:8px;font-weight:500}.columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.checks{margin-top:12px}.checks label{display:flex;align-items:center}.hint{background:var(--surface-muted);border-radius:10px;padding:16px;color:var(--muted);line-height:1.7}.error{color:#be3347;white-space:pre-wrap;overflow-wrap:anywhere}.notice{color:#178163}.input-frame{width:100%;height:570px;border:1px solid var(--border);border-radius:12px;background:white}.report-frame{width:100%;height:680px;border:0;background:white;margin:16px 0}.trial-actions{margin:20px 0}.checklist{display:flex;gap:10px;flex-wrap:wrap;color:#178163;font-size:12px}details{margin-top:16px}summary{cursor:pointer;color:var(--muted)}pre{max-height:220px;overflow:auto;padding:14px;background:var(--surface-muted);border-radius:10px;font-size:12px}footer{display:flex;justify-content:flex-end;align-items:center;gap:10px;border-top:1px solid var(--border);padding-top:18px}footer>span{margin-right:auto}@media(max-width:700px){.columns{grid-template-columns:1fr}.heading{flex-wrap:wrap}.card{padding:16px}}
</style>
