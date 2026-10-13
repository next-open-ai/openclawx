<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { WorkflowDefinition, WorkflowExecutionSummary } from '@workmate/contracts';
import * as orch from '../../services/orchestration';
import { downloadAssetBestEffort, openAssetBestEffort } from '../../app/platform-actions';
import { useAssets } from '../../app/assets';
import WorkflowRunDocuments from './WorkflowRunDocuments.vue';

const props = defineProps<{
  sessionId?: string; projectId?: string; visible: boolean; disabled: boolean; employeeIds: string[];
  readOnly?: boolean;
  ensureSession: () => Promise<string | null>;
  hideTrigger?: boolean;
}>();
const emit = defineEmits<{ openProject: [id: string]; openWorkflows: []; selectResult: [id: string] }>();
const items = ref<WorkflowExecutionSummary[]>([]);
const loading = ref(false); const readError = ref(''); const actionError = ref('');
const opening = ref(false); const dialogOpen = ref(false); const busy = ref(false); const uploading = ref(false); const documentsValid = ref(true);
const definitions = ref<WorkflowDefinition[]>([]); const definitionsLoading = ref(false);
const error = ref(''); const search = ref(''); const selectedId = ref(''); const input = ref(''); const fileIds = ref<string[]>([]);
const requestId = ref(''); const sourceSessionId = ref(''); const locked = ref(false);
const { archiveArtifact, archiveBundle } = useAssets();
const assetBusy = ref(false);
const dialog = ref<HTMLElement>();
const scopeId = computed(() => props.projectId ?? props.sessionId);
const selected = computed(() => definitions.value.find(item => item.id === selectedId.value));
const choices = computed(() => definitions.value.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(search.value.trim().toLowerCase())));
const unavailableEmployee = computed(() => selected.value?.nodes.some(node => !props.employeeIds.includes(node.employeeId)));
const labels: Record<WorkflowExecutionSummary['status'], string> = { draft: '待启动', running: '执行中', 'waiting-approval': '等待审批', completed: '已完成', failed: '需要处理', cancelled: '已停止', unavailable: '项目不可用' };
let generation = 0; let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined;
let refreshRequested = false;
let returnFocus: HTMLElement | null = null;

async function refresh(force = false) {
  if (!scopeId.value || !props.visible || disposed) return;
  if (loading.value) { if (force) refreshRequested = true; return; }
  clearTimeout(timer); const sessionId = scopeId.value; const token = generation;
  loading.value = true; readError.value = '';
  try {
    const result = await (props.projectId ? orch.listProjectWorkflowInvocations(sessionId) : orch.listChatWorkflowInvocations(sessionId));
    if (!disposed && token === generation) items.value = result.items;
  } catch (cause) { if (!disposed && token === generation) readError.value = message(cause); }
  finally {
    if (!disposed && token === generation) {
      loading.value = false;
      if (refreshRequested) { refreshRequested = false; void refresh(); }
      else if (props.visible && !readError.value && items.value.some(item => ['running', 'waiting-approval'].includes(item.status))) timer = setTimeout(() => void refresh(), 3000);
    }
  }
}
watch(() => [scopeId.value, !!props.projectId, props.visible] as const, () => {
  generation++; clearTimeout(timer); refreshRequested = false; loading.value = false; readError.value = ''; actionError.value = '';
  items.value = []; dialogOpen.value = false;
  if (props.visible) void refresh();
}, { immediate: true });
async function loadDefinitions() {
  definitionsLoading.value = true; error.value = '';
  try { definitions.value = (await orch.listDefinitions('workflows')).items; }
  catch (cause) { error.value = message(cause); }
  finally { definitionsLoading.value = false; }
}
async function open() {
  if (props.disabled || props.readOnly || opening.value || busy.value) return;
  opening.value = true; actionError.value = '';
  const initialSession = scopeId.value;
  try {
    const sessionId = await props.ensureSession();
    if (!sessionId) throw new Error('无法打开调用来源，请检查本机服务后重试');
    await nextTick();
    if (scopeId.value !== sessionId) return;
    if (!props.visible || (initialSession && scopeId.value !== initialSession)) return;
    sourceSessionId.value = sessionId; requestId.value = crypto.randomUUID();
    input.value = ''; fileIds.value = []; selectedId.value = ''; search.value = ''; locked.value = false;
    documentsValid.value = true; uploading.value = false;
    returnFocus = document.activeElement as HTMLElement; dialogOpen.value = true;
    await nextTick(); dialog.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    await loadDefinitions();
  } catch (cause) { actionError.value = message(cause); }
  finally { opening.value = false; }
}
function choose(id: string) {
  if (locked.value || busy.value || uploading.value) return;
  selectedId.value = id; requestId.value = crypto.randomUUID(); fileIds.value = [];
  documentsValid.value = true; error.value = '';
}
function close() {
  if (busy.value || uploading.value) return;
  dialogOpen.value = false; returnFocus?.focus();
}
function dialogKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); close(); }
  if (event.key !== 'Tab') return;
  const elements = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary') ?? [])].filter(element => element.getClientRects().length);
  if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
  else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
}
async function run() {
  if (!selected.value || busy.value || uploading.value || !documentsValid.value || unavailableEmployee.value || props.disabled || props.readOnly) return;
  busy.value = true; locked.value = true; error.value = '';
  const sessionId = sourceSessionId.value;
  try {
    const invoke = props.projectId ? orch.invokeProjectWorkflow : orch.invokeChatWorkflow;
    await invoke(sessionId, selected.value.id, { requestId: requestId.value, input: input.value, fileIds: fileIds.value });
    dialogOpen.value = false; returnFocus?.focus();
  } catch (cause) { if (sessionId === scopeId.value) error.value = message(cause); }
  finally { busy.value = false; if (sessionId === scopeId.value) await refresh(true); }
}
async function act(item: WorkflowExecutionSummary, cancel = false) {
  if (busy.value || props.readOnly) return;
  if (cancel && !window.confirm(`停止“${item.workflowName}”本次执行？已完成成果会保留。`)) return;
  busy.value = true; actionError.value = '';
  const token = generation;
  try {
    if (cancel) await orch.cancelProject(item.projectId);
    else if (scopeId.value) await (props.projectId ? orch.resumeProjectWorkflowInvocation(scopeId.value, item.id) : orch.resumeChatWorkflowInvocation(scopeId.value, item.id));
  } catch (cause) { if (!disposed && token === generation) actionError.value = message(cause); }
  finally { busy.value = false; await refresh(true); }
}
async function assetAction(id: string, download: boolean) {
  actionError.value = '';
  try { await (download ? downloadAssetBestEffort(id) : openAssetBestEffort(id)); }
  catch (cause) { actionError.value = message(cause); }
}
async function openDeliverable(item: WorkflowExecutionSummary, artifact: WorkflowExecutionSummary['artifacts'][number], download: boolean) {
  if (assetBusy.value) return;
  if (artifact.assetId) return assetAction(artifact.assetId, download);
  if (!artifact.runId) { emit('openProject', item.projectId); return; }
  assetBusy.value = true; actionError.value = '';
  try {
    // Archive only an explicitly registered deliverable, never scan a workspace.
    const input = { runId: artifact.runId, projectId: item.projectId };
    const asset = artifact.path === 'output/index.html' ? await archiveBundle(input) : await archiveArtifact({ ...input, relativePath: artifact.path });
    artifact.assetId = asset.id; artifact.assetName = asset.name;
    await assetAction(asset.id, download);
  } catch (cause) { actionError.value = `成果打开未完成：${message(cause)}。原文件可在执行项目中查看。`; }
  finally { assetBusy.value = false; }
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : '操作未完成，请重试'; }
onBeforeUnmount(() => { disposed = true; generation++; clearTimeout(timer); });
defineExpose({ open, opening, busy });
</script>

<template>
  <section class="min-w-0" :class="{ 'mb-3': !hideTrigger || items.length || readError || loading || actionError }" :aria-label="projectId ? '项目工作流' : '对话工作流'">
    <header v-if="!hideTrigger || items.length || readError" class="flex flex-wrap items-center justify-between gap-2">
      <button v-if="!hideTrigger" type="button" class="action" :disabled="disabled || readOnly || opening || busy" @click="open">{{ opening ? '正在准备…' : '调用工作流' }}</button>
      <button v-if="items.length || readError" type="button" class="link" :disabled="loading" @click="refresh(true)">{{ loading ? '正在更新…' : '刷新工作流状态' }}</button>
    </header>
    <p v-if="readError" role="alert" class="mt-2 text-xs text-rose-600">{{ readError }}；下方记录可能尚未更新，请刷新重试。</p>
    <p v-if="loading && !items.length" role="status" class="mt-2 text-xs text-[var(--muted)]">正在读取工作流调用记录…</p>
    <p v-if="actionError" role="alert" class="mt-2 text-xs text-rose-600">{{ actionError }}</p>
    <div v-if="items.length" class="mt-3 max-h-[34vh] space-y-3 overflow-y-auto" aria-label="工作流调用记录">
      <article v-for="item in items" :key="item.id" class="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <header class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="min-w-0 break-words text-sm font-semibold">{{ item.workflowName }} <span class="ml-2 text-xs font-normal" :class="item.status === 'failed' ? 'text-rose-600' : 'text-[var(--muted)]'">{{ labels[item.status] }}</span></h3>
          <time class="text-xs text-[var(--muted)]">{{ new Date(item.createdAt).toLocaleString() }}</time>
        </header>
        <p class="mt-2 whitespace-pre-wrap break-words text-sm">{{ item.input || '按工作流定义执行' }}</p>
        <p role="status" class="mt-2 text-xs text-[var(--muted)]">步骤 {{ item.completedTasks }}/{{ item.totalTasks }} · {{ Math.floor(item.elapsedMs / 1000) }} 秒</p>
        <details v-if="item.documents.length" class="mt-2 text-xs text-[var(--muted)]"><summary>参考文档 · {{ item.documents.length }} 个</summary><p v-for="document in item.documents" :key="document.path" class="mt-1 break-words">{{ document.name }}</p></details>
        <p v-if="item.error" role="alert" class="mt-2 whitespace-pre-wrap break-words text-xs text-rose-600">{{ item.error }}</p>
        <details v-if="item.resultText" class="mt-3" :open="item.status === 'completed'"><summary class="cursor-pointer text-xs font-medium">{{ item.status === 'completed' ? '结果节选' : '当前输出（尚未完成）' }}</summary><p class="mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6">{{ item.resultText }}</p></details>
        <div v-if="item.artifacts.length" class="mt-3 grid gap-2 sm:grid-cols-2">
          <div v-for="artifact in item.artifacts" :key="artifact.assetId || artifact.path" class="min-w-0 rounded-lg bg-[var(--surface-muted)] p-3">
            <p class="break-all text-xs font-medium">{{ artifact.assetName || artifact.path.split(/[\\/]/).pop() }}</p>
            <p class="mt-1 text-xs text-[var(--muted)]">{{ artifact.partial ? '部分产物，请核验' : artifact.assetId ? '已登记资产' : '已登记文件' }}</p>
            <div v-if="artifact.assetId || (artifact.runId && item.status !== 'running' && item.status !== 'waiting-approval')" class="mt-2 flex gap-3"><button type="button" class="link" :disabled="assetBusy" @click="openDeliverable(item, artifact, false)">查看成果</button><button type="button" class="link" :disabled="assetBusy" @click="openDeliverable(item, artifact, true)">下载</button></div>
          </div>
        </div>
        <p v-else-if="item.status === 'completed'" class="mt-2 text-xs text-[var(--muted)]">暂无已登记文件，文字结果以执行详情为准。</p>
        <footer class="mt-3 flex flex-wrap gap-2">
          <button v-if="!projectId && ['completed','failed','cancelled'].includes(item.status)" type="button" class="action" :disabled="disabled || readOnly || busy || !!readError" @click="emit('selectResult', item.id)">基于成果提问</button>
          <button v-if="item.status !== 'unavailable'" type="button" class="action" @click="emit('openProject', item.projectId)">{{ item.status === 'waiting-approval' ? '进入审批' : '查看详情 / 继续协作' }}</button>
          <button v-if="['draft','failed','cancelled'].includes(item.status)" type="button" class="action" :disabled="busy || !!readError || readOnly" @click="act(item)">{{ item.status === 'draft' ? '启动原项目' : '恢复未完成步骤' }}</button>
          <button v-if="['running','waiting-approval'].includes(item.status)" type="button" class="action" :disabled="busy || !!readError || readOnly" @click="act(item, true)">停止工作流</button>
        </footer>
      </article>
    </div>
    <Teleport to="body">
      <div v-if="dialogOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" @keydown="dialogKey">
        <section ref="dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-call-title" class="flex max-h-[90dvh] w-full max-w-2xl flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl">
          <header class="flex items-center justify-between gap-4"><h2 id="workflow-call-title" class="text-lg font-semibold">调用工作流</h2><button type="button" class="action" :disabled="busy || uploading" @click="close">关闭</button></header>
          <div class="mt-4 min-h-0 space-y-4 overflow-y-auto">
            <p class="text-xs leading-5 text-[var(--muted)]">让一组数字员工协作完成任务。各员工使用自己的模型、技能与审批规则，运行可能产生模型费用；不会切换当前聊天模型。</p>
            <p v-if="error" role="alert" class="text-sm text-rose-600">{{ error }} <button v-if="!locked" type="button" class="link" @click="loadDefinitions">重新加载</button></p>
            <input v-model="search" aria-label="搜索工作流" class="field" placeholder="搜索工作流名称或用途" :disabled="locked || definitionsLoading" />
            <p v-if="definitionsLoading" role="status" class="text-sm text-[var(--muted)]">正在加载工作流…</p>
            <p v-else-if="!choices.length" class="text-sm text-[var(--muted)]">{{ search ? '没有匹配的工作流，请换个关键词。' : '还没有工作流，请先到工作流菜单创建。' }} <button v-if="!search && !locked" type="button" class="link" @click="close(); emit('openWorkflows')">管理工作流</button></p>
            <div class="max-h-40 space-y-2 overflow-y-auto" role="group" aria-label="选择工作流">
              <button v-for="definition in choices" :key="definition.id" type="button" :aria-pressed="selectedId === definition.id" :disabled="locked || uploading" class="w-full rounded-xl border p-3 text-left" :class="selectedId === definition.id ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)]'" @click="choose(definition.id)"><strong class="text-sm">{{ definition.name }}</strong><span class="ml-3 text-xs text-[var(--muted)]">{{ definition.nodes.length }} 步 · {{ new Set(definition.nodes.map(node => node.employeeId)).size }} 位员工</span><p class="mt-1 break-words text-xs text-[var(--muted)]">{{ definition.description }}</p></button>
            </div>
            <template v-if="selected">
              <p v-if="unavailableEmployee" role="alert" class="text-sm text-rose-600">流程中有已移除的员工，请先到工作流菜单编辑。</p>
              <label class="block text-sm font-medium">本次要求 <span class="font-normal text-[var(--muted)]">（可选）</span><textarea v-model="input" aria-label="工作流本次要求" maxlength="12000" rows="3" class="field mt-2" placeholder="例如：分析九月数据，输出结论与建议" :disabled="locked" /></label>
              <WorkflowRunDocuments :key="requestId" :workflow-id="selected.id" :request-id="requestId" :disabled="locked" @change="fileIds = $event" @uploading="uploading = $event" @valid="documentsValid = $event" />
              <p class="text-xs text-[var(--muted)]">新建独立执行项目，进度与成果会显示在{{ projectId ? '本项目' : '本对话' }}。继续修改成果可进入执行详情，不会自动重跑整条流程。{{ projectId ? '仅显示你发起的调用，不自动继承本项目材料或共享权限。' : '' }}</p>
              <p v-if="locked && !busy" class="text-xs text-[var(--muted)]">本次要求已锁定，重试会复用原调用；如需更改，请关闭后重新选择。</p>
            </template>
          </div>
          <footer class="mt-5 flex justify-end gap-3"><button type="button" class="action" :disabled="busy || uploading" @click="close">取消</button><button type="button" class="primary" :disabled="!selected || busy || uploading || !documentsValid || unavailableEmployee || disabled || readOnly" @click="run">{{ busy ? '正在启动…' : locked ? '重试本次调用' : '确认并运行' }}</button></footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.action { border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 12px; }
.link { font-size: 12px; color: var(--accent); }
.primary { border-radius: 8px; background: var(--accent); color: white; padding: 9px 16px; font-size: 13px; font-weight: 600; }
.field { width: 100%; min-width: 0; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-muted); padding: 10px 12px; font-size: 13px; }
button:disabled { opacity: .5; cursor: not-allowed; }
button:focus-visible, .field:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
