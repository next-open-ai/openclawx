<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { algorithmDefinitionSchema, workflowDefinitionSchema, type AlgorithmDefinition, type WorkflowDefinition } from '@workmate/contracts';
import type { Employee } from '../../app/employees';
import { employeeDisplayName } from '../../app/employees';
import { useI18n } from '../../app/i18n';
import { useCapabilities } from '../../app/capabilities';
import { useModelConfig } from '../../app/model-config';
import { createManagedWorkspace } from '../../services/api';
import * as orch from '../../services/orchestration';
import { materializeWorkflow, workflowFromPlan } from './workflow-project';
import type { ProviderConfig } from '../../app/model-config';
import type { ProjectDraftResult } from '../../app/project-planning';
import ProjectDagPreview from '../projects/ProjectDagPreview.vue';
import WorkflowRunHistory from './WorkflowRunHistory.vue';
import WorkflowRunDocuments from './WorkflowRunDocuments.vue';

const props = defineProps<{
  mode: 'workflows' | 'algorithms'; employees: Employee[]; models?: ProviderConfig[];
  generateDraft?: (goal: string, model: ProviderConfig, options?: { employeeIds?: string[]; preferredMode?: 'dag' }) => Promise<ProjectDraftResult>;
}>();
const emit = defineEmits<{ openProject: [id: string]; openSkills: [] }>();
const { t } = useI18n();
const { skills, load: loadSkills, policyFor, setPolicy } = useCapabilities();
const { configured } = useModelConfig();
const workflows = ref<WorkflowDefinition[]>([]);
const algorithms = ref<AlgorithmDefinition[]>([]);
const loading = ref(true); const busy = ref(false); const error = ref(''); const notice = ref('');
const search = ref(''); const editing = ref(false);
const selectedEmployees = ref<string[]>([]);
const workflow = ref<WorkflowDefinition>(blankWorkflow());
const algorithm = ref<AlgorithmDefinition>(blankAlgorithm());
const runWorkflow = ref<WorkflowDefinition | null>(null);
const runInput = ref('');
const runFileIds = ref<string[]>([]); const uploadingDocuments = ref(false); const documentsValid = ref(true);
const createStep = ref<1 | 2>(1);
const planning = ref(false);
const participantIds = ref<string[]>([]);
const coordinatorId = ref('');
const coordinator = computed(() => props.models?.find(model => model.id === coordinatorId.value) ?? props.models?.[0]);
const planNotice = ref('');
const dagTasks = computed(() => workflow.value.nodes.map(node => ({ ...node, subtitle: employeeName(node.employeeId) })));
// Remember a prepared instance so a navigation failure does not create another project.
const preparedProjectId = ref<string | null>(null);
const historyId = ref('');
const runRequestId = ref(''); const preparedWorkspace = ref('');
const dialog = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;
watch(() => editing.value || !!runWorkflow.value, async open => {
  if (open) { returnFocus = document.activeElement as HTMLElement; await nextTick(); dialog.value?.querySelector<HTMLElement>('input, textarea, button')?.focus(); }
  else returnFocus?.focus();
});
function dialogKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && !busy.value && !uploadingDocuments.value) { editing.value = false; runWorkflow.value = null; }
  if (event.key !== 'Tab') return;
  const elements = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary') ?? [])].filter(element => element.getClientRects().length);
  const first = elements[0]; const last = elements.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
const isWorkflow = computed(() => props.mode === 'workflows');
const title = computed(() => isWorkflow.value ? '工作流' : '算法');
const usableEmployees = computed(() => props.employees.filter(employee => !employee.system));
const algorithmSkills = computed(() => skills.value.filter(skill => !skill.systemOnly && skill.status === 'ready'));
const records = computed(() => (isWorkflow.value ? workflows.value : algorithms.value).filter(item => `${item.name} ${item.description}`.toLowerCase().includes(search.value.trim().toLowerCase())));
const employeeName = (id: string) => employeeDisplayName(props.employees.find(item => item.id === id), t) || '员工已移除';
function blankWorkflow(): WorkflowDefinition { return { id: crypto.randomUUID(), name: '', description: '', nodes: [] }; }
function blankAlgorithm(): AlgorithmDefinition { return { id: crypto.randomUUID(), name: '', description: '', skillId: '', version: '1.0.0' }; }
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
async function load() {
  loading.value = true; error.value = '';
  try {
    if (!isWorkflow.value) await loadSkills();
    if (isWorkflow.value) workflows.value = (await orch.listDefinitions('workflows')).items;
    else algorithms.value = (await orch.listDefinitions('algorithms')).items;
  } catch (cause) { error.value = message(cause); }
  finally { loading.value = false; }
}
function addNode() {
  const previous = workflow.value.nodes.at(-1);
  workflow.value.nodes.push({ id: crypto.randomUUID(), title: '', employeeId: usableEmployees.value[0]?.id ?? '', objective: '', dependsOn: previous ? [previous.id] : [], acceptance: '' });
}
function removeNode(id: string) {
  workflow.value.nodes = workflow.value.nodes.filter(node => node.id !== id);
  for (const node of workflow.value.nodes) node.dependsOn = node.dependsOn.filter(dependency => dependency !== id);
}
function edit(item?: WorkflowDefinition | AlgorithmDefinition) {
  error.value = ''; notice.value = '';
  if (isWorkflow.value) {
    workflow.value = item ? JSON.parse(JSON.stringify(item)) as WorkflowDefinition : blankWorkflow();
    createStep.value = item ? 2 : 1;
    participantIds.value = usableEmployees.value.map(employee => employee.id);
    coordinatorId.value = props.models?.[0]?.id ?? '';
    planNotice.value = '';
  } else {
    algorithm.value = item ? JSON.parse(JSON.stringify(item)) as AlgorithmDefinition : blankAlgorithm();
    selectedEmployees.value = props.employees.filter(employee => {
      const policy = policyFor(employee.id, algorithm.value.skillId);
      return policy && policy.mode !== 'disabled';
    }).map(employee => employee.id);
  }
  editing.value = true;
}
function prepareDefinition() {
  if (!workflow.value.description.trim()) throw new Error('请描述工作流要完成的目标与期望交付');
  workflow.value.name ||= workflow.value.description.trim().slice(0, 24);
}
function manualPlan() {
  error.value = '';
  try {
    prepareDefinition();
    if (!usableEmployees.value.length) throw new Error('请先创建可执行任务的数字员工');
    if (!workflow.value.nodes.length) addNode();
    createStep.value = 2;
  } catch (cause) { error.value = message(cause); }
}
async function plan() {
  if (busy.value) return;
  error.value = '';
  try {
    prepareDefinition();
    const allowed = participantIds.value.filter(id => usableEmployees.value.some(employee => employee.id === id));
    if (!allowed.length) throw new Error('请至少选择一位参与员工');
    if (!coordinator.value || !props.generateDraft) throw new Error('请先配置可用的规划模型，或选择手动编排');
    if (workflow.value.nodes.length && !window.confirm('重新规划将替换当前步骤与依赖，是否继续？')) return;
    busy.value = true; planning.value = true;
    const result = await props.generateDraft(workflow.value.description, coordinator.value, { employeeIds: allowed, preferredMode: 'dag' });
    const planned = workflowFromPlan(workflow.value, result.tasks, allowed);
    workflow.value = planned;
    planNotice.value = result.modeRationale || '已按真实依赖规划，请检查步骤、员工及交付要求。';
    createStep.value = 2;
  } catch (cause) { error.value = message(cause); }
  finally { busy.value = false; planning.value = false; }
}
function skillChanged() {
  const skill = skills.value.find(item => item.id === algorithm.value.skillId);
  if (skill) { algorithm.value.name ||= skill.name; algorithm.value.description ||= skill.description; }
  selectedEmployees.value = props.employees.filter(employee => {
    const policy = policyFor(employee.id, algorithm.value.skillId);
    return policy && policy.mode !== 'disabled';
  }).map(employee => employee.id);
}
async function save() {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try {
    if (isWorkflow.value) {
      const parsed = workflowDefinitionSchema.safeParse(workflow.value);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || '请完善工作流');
      if (parsed.data.nodes.some(node => !usableEmployees.value.some(employee => employee.id === node.employeeId))) throw new Error('请为每个步骤选择有效员工');
      await orch.saveDefinition('workflows', parsed.data);
    } else {
      const parsed = algorithmDefinitionSchema.safeParse(algorithm.value);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || '请完善算法信息');
      const skill = algorithmSkills.value.find(item => item.id === parsed.data.skillId);
      if (!skill) throw new Error('请先在技能与连接中安装或创建算法 Skill');
      await orch.saveDefinition('algorithms', parsed.data);
      // Explicitly selected employee associations only. Keep existing default policies intact.
      for (const employee of usableEmployees.value) {
        const old = policyFor(employee.id, skill.id);
        const selected = selectedEmployees.value.includes(employee.id);
        if (selected && (!old || old.mode === 'disabled')) await setPolicy(employee.id, skill.id, 'available');
        else if (!selected && old && old.mode !== 'disabled') await setPolicy(employee.id, skill.id, 'disabled');
      }
    }
    editing.value = false; await load(); notice.value = '已保存';
  } catch (cause) { error.value = message(cause); }
  finally { busy.value = false; }
}
async function remove(item: WorkflowDefinition | AlgorithmDefinition) {
  if (!window.confirm(`删除“${item.name}”的登记？不会删除历史项目、底层 Skill 或员工已有授权。`)) return;
  busy.value = true; error.value = '';
  try { await orch.deleteDefinition(props.mode, item.id); await load(); }
  catch (cause) { error.value = message(cause); }
  finally { busy.value = false; }
}
function prepareRun(item: WorkflowDefinition) {
  runWorkflow.value = JSON.parse(JSON.stringify(item)) as WorkflowDefinition; runInput.value = ''; preparedProjectId.value = null; error.value = ''; notice.value = '';
  runRequestId.value = crypto.randomUUID(); preparedWorkspace.value = '';
  runFileIds.value = []; documentsValid.value = true; uploadingDocuments.value = false;
}
async function run() {
  const definition = runWorkflow.value;
  if (!definition || busy.value || uploadingDocuments.value || !documentsValid.value) return;
  busy.value = true; error.value = '';
  try {
    if (!configured.value) throw new Error('请先在设置中配置可用的对话模型');
    if (!preparedProjectId.value) {
      const draft = materializeWorkflow(definition, usableEmployees.value.map(employee => employee.id), runInput.value);
      if (!preparedWorkspace.value) preparedWorkspace.value = await createManagedWorkspace(draft.name) || '';
      if (!preparedWorkspace.value) throw new Error('无法创建运行工作区');
      const result = await orch.prepareWorkflowRun(definition.id, { requestId: runRequestId.value, input: runInput.value, workspacePath: preparedWorkspace.value, fileIds: runFileIds.value });
      preparedProjectId.value = result.projectId;
    }
    const project = await orch.getProject(preparedProjectId.value);
    if (!project) throw new Error('无法读取已准备的项目，请重试或进入项目检查');
    if (project.status === 'draft') await orch.confirmProject(project.id);
    emit('openProject', project.id);
  } catch (cause) { error.value = message(cause); }
  finally { busy.value = false; }
}
onMounted(load);
</script>

<template>
  <section class="h-full overflow-y-auto bg-[var(--background)] p-5 md:p-8">
    <div class="mx-auto max-w-6xl">
      <header class="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div><h1 class="text-2xl font-bold">{{ title }}</h1><p class="mt-2 text-sm text-[var(--muted)]">{{ isWorkflow ? '将数字员工的协作步骤保存下来，按需重复运行。' : '用 Skill 封装领域算法，按需关联给数字员工。' }}</p></div>
        <button class="primary" :disabled="loading || busy" @click="edit()">{{ isWorkflow ? '创建工作流' : '登记算法' }}</button>
      </header>
      <p v-if="error && !editing && !runWorkflow" role="alert" class="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-600">{{ error }} <button class="underline" @click="load">重试加载</button></p>
      <p v-if="notice" role="status" class="mb-3 text-sm text-[var(--accent)]">{{ notice }}</p>
      <div class="mb-5 flex flex-wrap gap-3"><input v-model="search" class="field max-w-sm" :aria-label="`搜索${title}`" :placeholder="`搜索${title}名称或用途`" /><button v-if="!isWorkflow" class="secondary" @click="emit('openSkills')">管理算法 Skill</button></div>
      <div v-if="loading" aria-busy="true" class="space-y-3"><div v-for="i in 3" :key="i" class="h-28 rounded-xl bg-[var(--surface-muted)]" /></div>
      <div v-else-if="!records.length" class="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-16 text-center">
        <h2 class="text-lg font-semibold">{{ search ? '没有匹配结果' : `还没有${title}` }}</h2>
        <p class="mx-auto mt-3 max-w-md text-sm leading-6 text-[var(--muted)]">{{ search ? '换一个关键词试试。' : isWorkflow ? '描述要完成的目标，让协调员安排员工与协作步骤。确认后保存，可在不同任务中重复使用。' : '先安装包含算法脚本或工具的 Skill，再登记用途和版本，并选择允许调用它的员工。' }}</p>
        <button v-if="isWorkflow && !search" class="primary mt-5" :disabled="busy || !usableEmployees.length" @click="edit()">创建第一个工作流</button>
      </div>
      <div v-else class="space-y-3">
        <article v-for="item in records" :key="item.id" class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0 flex-1"><h2 class="break-words font-semibold">{{ item.name }}</h2><p class="mt-2 whitespace-pre-wrap break-words text-sm text-[var(--muted)]">{{ item.description || '未填写说明' }}</p></div>
            <div class="flex shrink-0 flex-wrap gap-2"><button v-if="'nodes' in item" class="primary" :disabled="busy" @click="prepareRun(item)">运行</button><button v-if="'nodes' in item" class="secondary" @click="historyId = historyId === item.id ? '' : item.id">{{ historyId === item.id ? '收起记录' : '运行记录' }}</button><button class="secondary" :disabled="busy" @click="edit(item)">{{ isWorkflow ? '编辑' : '配置员工' }}</button><button class="secondary" :disabled="busy" @click="remove(item)">删除</button></div>
          </div>
          <div v-if="'nodes' in item" class="mt-4 flex flex-wrap gap-2 text-xs text-[var(--muted)]"><span v-for="node in item.nodes" :key="node.id" class="max-w-full break-words rounded-lg bg-[var(--surface-muted)] px-3 py-2">{{ node.title }} · {{ employeeName(node.employeeId) }} · {{ node.dependsOn.length ? `${node.dependsOn.length} 个前置步骤` : '起始步骤' }}</span></div>
          <div v-else class="mt-4 flex flex-wrap gap-3 text-xs text-[var(--muted)]"><span>{{ skills.find(skill => skill.id === item.skillId)?.name || '底层 Skill 已移除' }}</span><span>版本 {{ item.version }}</span><span>运行时验证</span><span>关联 {{ usableEmployees.filter(employee => { const policy = policyFor(employee.id, item.skillId); return policy && policy.mode !== 'disabled'; }).length }} 位员工</span></div>
          <WorkflowRunHistory v-if="'nodes' in item && historyId === item.id" :key="item.id" :workflow-id="item.id" @open-project="emit('openProject', $event)" />
        </article>
      </div>
    </div>

    <div v-if="editing || runWorkflow" class="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" @keydown="dialogKey">
      <section ref="dialog" role="dialog" aria-modal="true" :aria-label="editing ? `配置${title}` : '运行工作流'" class="flex max-h-[90dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl">
        <header class="mb-5 flex shrink-0 items-center justify-between gap-4"><h2 class="text-lg font-semibold">{{ editing ? `配置${title}` : `运行 · ${runWorkflow?.name}` }}</h2><button class="secondary" :disabled="busy || uploadingDocuments" aria-label="关闭" @click="editing = false; runWorkflow = null">关闭</button></header>
        <p v-if="error" role="alert" class="mb-4 shrink-0 text-sm text-rose-600">{{ error }}</p>
        <form v-if="editing" class="min-h-0 space-y-4 overflow-y-auto" @submit.prevent="isWorkflow && createStep === 1 ? plan() : save()">
          <fieldset :disabled="busy" class="space-y-4">
          <template v-if="isWorkflow">
            <nav aria-label="创建进度" class="flex gap-5 border-b border-[var(--border)] pb-4 text-sm"><span :class="createStep === 1 ? 'font-semibold text-[var(--accent)]' : 'text-[var(--muted)]'" :aria-current="createStep === 1 ? 'step' : undefined">1 描述目标</span><span :class="createStep === 2 ? 'font-semibold text-[var(--accent)]' : 'text-[var(--muted)]'" :aria-current="createStep === 2 ? 'step' : undefined">2 确认流程</span></nav>
            <template v-if="createStep === 1">
              <label class="block text-sm font-medium">希望员工协作完成什么？<textarea v-model="workflow.description" required class="field mt-2" rows="4" maxlength="4000" placeholder="例如：分析每月经营数据，找出收入与成本变化，再生成一份带结论和建议的报告。" /></label>
              <label class="block text-sm">工作流名称 <span class="text-[var(--muted)]">可选，留空自动命名</span><input v-model="workflow.name" maxlength="120" class="field mt-2" placeholder="例如：月度经营报告" /></label>
              <fieldset class="rounded-xl border border-[var(--border)] p-4"><legend class="px-1 text-sm font-medium">参与员工</legend><p class="mb-3 text-xs leading-5 text-[var(--muted)]">默认从可用员工中按职责选择，不会强行安排所有人。</p><div class="grid gap-3 sm:grid-cols-2"><label v-for="employee in usableEmployees" :key="employee.id" class="flex min-w-0 items-center gap-2 text-sm"><input v-model="participantIds" type="checkbox" :value="employee.id" /><span class="break-words">{{ employeeName(employee.id) }}</span></label></div><p v-if="!usableEmployees.length" role="status" class="text-sm text-[var(--muted)]">暂无可用员工，请先在数字员工中创建。</p></fieldset>
              <label class="block text-sm">规划模型<select v-model="coordinatorId" class="field mt-2"><option v-if="!models?.length" value="">未配置模型，可手动编排</option><option v-for="model in models" :key="model.id" :value="model.id">{{ model.providerLabel || model.provider }} · {{ model.chatModel }}</option></select></label>
              <p class="text-xs leading-5 text-[var(--muted)]">规划复用项目协调员，可能产生模型调用费用；此处只生成草案，不执行员工任务。没有模型也可以手动编排。</p>
            </template>
            <template v-else>
            <label class="block text-sm">工作流名称<input v-model="workflow.name" required maxlength="120" class="field mt-2" /></label>
            <p class="whitespace-pre-wrap break-words text-sm text-[var(--muted)]">{{ workflow.description }}</p>
            <p v-if="planNotice" role="status" class="text-xs leading-5 text-[var(--muted)]">{{ planNotice }}</p>
            <details class="rounded-xl border border-[var(--border)] p-3" open><summary class="cursor-pointer text-sm font-medium">协作流程预览 · {{ workflow.nodes.length }} 个步骤</summary><ProjectDagPreview class="mt-3" :tasks="dagTasks" compact bare /></details>
            <article v-for="(node, index) in workflow.nodes" :key="node.id" class="space-y-3 rounded-xl border border-[var(--border)] p-4">
              <div class="flex items-center justify-between"><h3 class="text-sm font-semibold">步骤 {{ index + 1 }}</h3><button type="button" class="text-xs text-[var(--muted)]" :disabled="workflow.nodes.length === 1" @click="removeNode(node.id)">移除步骤</button></div>
              <div class="grid gap-3 md:grid-cols-2"><label class="text-sm">步骤名称<input v-model="node.title" required class="field mt-2" maxlength="120" /></label><label class="text-sm">执行员工<select v-model="node.employeeId" required class="field mt-2"><option value="" disabled>选择员工</option><option v-for="employee in usableEmployees" :key="employee.id" :value="employee.id">{{ employeeName(employee.id) }}</option></select></label></div>
              <label class="block text-sm">任务目标<textarea v-model="node.objective" required class="field mt-2" rows="3" maxlength="12000" /></label>
              <details class="text-sm"><summary class="cursor-pointer text-[var(--muted)]">依赖与验收要求</summary><div class="mt-3 space-y-3"><p class="text-xs text-[var(--muted)]">不选依赖即为独立起始步骤。不得形成循环。</p><label v-for="other in workflow.nodes.filter(item => item.id !== node.id)" :key="other.id" class="mr-3 inline-flex items-center gap-2"><input v-model="node.dependsOn" type="checkbox" :value="other.id" />{{ other.title || '未命名步骤' }}</label><label class="block">验收要求<textarea v-model="node.acceptance" class="field mt-2" rows="2" maxlength="4000" placeholder="例如：交付有效 PDF，并说明数据来源" /></label></div></details>
            </article>
            <button type="button" class="secondary" :disabled="workflow.nodes.length >= 30" @click="addNode">添加步骤</button>
            </template>
          </template>
          <template v-else>
            <label class="block text-sm">算法 Skill<select v-model="algorithm.skillId" required class="field mt-2" @change="skillChanged"><option value="" disabled>选择已安装技能</option><option v-for="skill in algorithmSkills" :key="skill.id" :value="skill.id">{{ skill.name }}</option></select></label>
            <p class="text-xs leading-5 text-[var(--muted)]">算法实现与调用说明由底层 Skill 管理。此处登记不修改脚本，也不会自动安装依赖或提升权限。</p>
            <div class="grid gap-3 md:grid-cols-[1fr_140px]"><label class="text-sm">算法名称<input v-model="algorithm.name" required class="field mt-2" maxlength="120" /></label><label class="text-sm">版本标记<input v-model="algorithm.version" required class="field mt-2" maxlength="80" /></label></div>
            <label class="block text-sm">业务用途<textarea v-model="algorithm.description" required class="field mt-2" rows="3" maxlength="4000" /></label>
            <fieldset class="rounded-xl border border-[var(--border)] p-4"><legend class="px-1 text-sm font-semibold">允许调用的员工</legend><p class="mb-3 text-xs text-[var(--muted)]">与员工的技能授权同步。取消选择会禁用该员工对此 Skill 的调用。</p><div class="grid gap-3 sm:grid-cols-2"><label v-for="employee in usableEmployees" :key="employee.id" class="flex items-center gap-2 text-sm"><input v-model="selectedEmployees" type="checkbox" :value="employee.id" />{{ employeeName(employee.id) }}</label></div></fieldset>
          </template>
          <footer class="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] bg-[var(--surface)] py-4">
            <button v-if="isWorkflow && createStep === 2" type="button" class="secondary" @click="createStep = 1; error = ''">返回修改目标</button>
            <button v-else-if="isWorkflow" type="button" class="secondary" :disabled="busy || !usableEmployees.length" @click="manualPlan">{{ workflow.nodes.length ? '保留步骤，继续编辑' : '手动编排' }}</button>
            <span v-else />
            <div class="flex gap-3"><button type="button" class="secondary" :disabled="busy" @click="editing = false">取消</button><button type="submit" class="primary" :disabled="busy || (isWorkflow && createStep === 1 && (!coordinator || !participantIds.length))">{{ planning ? '协调员正在规划…' : busy ? '正在保存…' : isWorkflow && createStep === 1 ? workflow.nodes.length ? '重新规划' : '规划协作步骤' : isWorkflow ? '保存工作流' : '保存' }}</button></div>
          </footer>
          </fieldset>
        </form>
        <form v-else class="min-h-0 overflow-y-auto" @submit.prevent="run">
          <p class="mb-4 text-sm leading-6 text-[var(--muted)]">将创建独立运行项目，复用当前员工授权、模型及审批规则。后续修改工作流不会改变本次运行。</p>
          <div class="mb-4 flex flex-wrap gap-2 text-xs text-[var(--muted)]"><span v-for="node in runWorkflow?.nodes" :key="node.id" class="rounded-md bg-[var(--surface-muted)] px-2 py-1">{{ node.title }} · {{ employeeName(node.employeeId) }}</span></div>
          <label class="block text-sm">本次要求（可选）<textarea v-model="runInput" class="field mt-2" rows="4" maxlength="12000" placeholder="例如：分析九月份销售情况，输出中文报告" :disabled="busy || !!preparedWorkspace" /></label>
          <WorkflowRunDocuments v-if="runWorkflow" :key="runRequestId" :workflow-id="runWorkflow.id" :request-id="runRequestId" :disabled="busy || !!preparedWorkspace" @change="runFileIds = $event" @uploading="uploadingDocuments = $event" @valid="documentsValid = $event" />
          <p v-if="preparedProjectId" class="mt-3 text-xs text-[var(--muted)]">项目已准备并关联运行记录。启动失败也会保留，可重试启动或进入详情处理。</p>
          <footer class="mt-5 flex flex-wrap justify-end gap-3"><button v-if="preparedProjectId" type="button" class="secondary" :disabled="busy" @click="emit('openProject', preparedProjectId!)">进入已准备项目</button><button class="primary" :disabled="busy || uploadingDocuments || !documentsValid">{{ uploadingDocuments ? '文档解析中…' : busy ? '正在准备并启动…' : preparedProjectId ? '重试启动并进入' : '确认并运行' }}</button></footer>
        </form>
      </section>
    </div>
  </section>
</template>

<style scoped>
.field { width: 100%; min-width: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-muted); padding: 9px 12px; color: var(--text); font-size: 13px; }
.field:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.primary, .secondary { border-radius: 8px; padding: 8px 13px; font-size: 13px; font-weight: 600; white-space: nowrap; }
.primary { background: var(--accent); color: white; }
.secondary { border: 1px solid var(--border); color: var(--text); background: var(--surface); }
button:disabled { opacity: .5; cursor: not-allowed; }
button:not(:disabled):hover { filter: brightness(.96); }
textarea { resize: vertical; }
</style>
