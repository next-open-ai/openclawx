<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { parameterValidator, parameterValidationMessage } from '@workmate/contracts';
import type { TaskParameterProjectPreview } from '@workmate/contracts';
import { templateTasksApi as api } from '../../services/template-tasks';
import { parameterDataRequest } from '../../services/task-parameter-bridge';
import ProjectApplicationButton from './ProjectApplicationButton.vue';

const props = defineProps<{ projectId:string; projectName:string; running:boolean; canWrite:boolean }>();
const known = ref(false), definitionId = ref<string|null>(null), error = ref(''), busy = ref(false);
const dialog = ref<HTMLDialogElement>(), frame = ref<HTMLIFrameElement>();
const preview = ref<TaskParameterProjectPreview>(), channel = ref(''), result = ref('');
const isReport=ref(false),reportHtml=ref('');
let generation = 0, infoGeneration = 0;
async function identify() {
  const epoch = ++infoGeneration; known.value = false; error.value = '';
  try {
    const info = await api.parameterProjectInfo(props.projectId);
    if (epoch !== infoGeneration) return;
    definitionId.value = info.definitionId;isReport.value=info.kind==='report'; known.value = true;
  } catch(cause) { if(epoch === infoGeneration) error.value = cause instanceof Error ? cause.message : '预览入口读取失败'; }
}
function invalidate() { generation++; channel.value = ''; preview.value = undefined;reportHtml.value=''; busy.value = false; result.value = ''; }
function close() { invalidate(); dialog.value?.close(); }
async function reload() {
  if (props.running || busy.value) return;
  invalidate(); const epoch = generation; busy.value = true; error.value = '';
  try {
    if(isReport.value){const snapshot=await api.previewReportProject(props.projectId);if(epoch===generation)reportHtml.value=snapshot.html;return;}
    const snapshot = await api.previewParameterProject(props.projectId);
    if (epoch !== generation) return;
    preview.value = snapshot; channel.value = crypto.randomUUID();
  } catch(cause) { if(epoch === generation) error.value = cause instanceof Error ? cause.message : '参数预览失败'; }
  finally { if(epoch === generation) busy.value = false; }
}
async function open() { dialog.value?.showModal(); await reload(); }
function send(message:Record<string,unknown>) {
  frame.value?.contentWindow?.postMessage({...message,channel:channel.value},'*');
}
async function receive(event:MessageEvent) {
  if (!dialog.value?.open || !preview.value || !channel.value || event.source !== frame.value?.contentWindow) return;
  const message = event.data;
  if (message?.type === 'workmate.task.ready') {
    send({type:'workmate.task.init',parameters:JSON.parse(JSON.stringify(preview.value.parameters)),submitLabel:'测试参数（不保存）'}); return;
  }
  if (message?.channel !== channel.value) return;
  if (message.type === 'workmate.task.request') {
    const active = channel.value;
    try { const data = await parameterDataRequest(message.path,message.query); if(active === channel.value) send({type:'workmate.task.response',id:message.id,data}); }
    catch(cause) { if(active === channel.value) send({type:'workmate.task.response',id:message.id,error:cause instanceof Error ? cause.message : '数据查询失败'}); }
  } else if (message.type === 'workmate.task.submit') {
    try {
      const parsed = parameterValidator(preview.value.schema).safeParse(message.parameters);
      if (!parsed.success) { send({type:'workmate.task.saved',error:parameterValidationMessage(parsed.error,preview.value.schema).replace('默认参数','测试参数').replace('请打开“设置默认参数”填写并应用后重试。','请填写后重新测试。')}); return; }
      result.value = JSON.stringify(parsed.data,null,2);
      send({type:'workmate.task.saved',notice:'参数校验通过，仅供测试；未保存模板或创建任务。'});
    } catch(cause) { send({type:'workmate.task.saved',error:cause instanceof Error ? cause.message : '参数校验失败'}); }
  }
}
watch(() => props.projectId, () => { close(); void identify(); }, {immediate:true});
watch(() => props.running, running => { if(running) {invalidate(); if(dialog.value?.open) error.value='项目正在编辑，完成后请重新加载预览。';} });
onMounted(() => window.addEventListener('message',receive));
onBeforeUnmount(() => {infoGeneration++;invalidate();window.removeEventListener('message',receive);});
</script>

<template>
  <ProjectApplicationButton v-if="known && !definitionId" :project-id="projectId" :project-name="projectName" :running="running" :can-write="canWrite" />
  <button v-else-if="known" type="button" :disabled="running" aria-haspopup="dialog" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold hover:border-[var(--accent)] disabled:opacity-40" @click="open">{{isReport?'预览任务报告':'预览并测试数据'}}</button>
  <button v-else type="button" :disabled="!error" :title="error" class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs disabled:opacity-40" @click="identify">{{ error ? '预览入口加载失败 · 重试' : '正在加载预览入口…' }}</button>
  <Teleport to="body">
    <dialog ref="dialog" :aria-label="isReport?'任务报告设计预览':'参数 UI 预览与数据测试'" class="m-auto w-[min(1120px,calc(100vw-24px))] max-h-[92dvh] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text)] shadow-2xl" @cancel="close">
      <header class="flex items-start justify-between gap-3 border-b border-[var(--border)] p-5">
        <div class="min-w-0"><h2 class="font-bold">{{isReport?'任务报告查看 · 设计预览':'参数 UI · 预览与数据测试'}}</h2><p class="mt-1 truncate text-xs text-[var(--muted)]">{{ projectName }}</p></div>
        <button type="button" class="shrink-0 rounded-lg border border-[var(--border)] px-3 py-2 text-xs" @click="close">关闭</button>
      </header>
      <div class="space-y-4 p-5">
        <p class="rounded-xl bg-[var(--surface-muted)] p-3 text-xs leading-6 text-[var(--muted)]">{{isReport?'当前为设计示例，非真实任务结果；正式报告只读取本次运行结果，不查询业务接口。':'使用当前用户有权访问的技能和数据。测试提交只校验并展示参数，不保存模板、不创建任务。'}} 完成后返回任务模板即可同步草稿，无需在此发布静态应用。</p>
        <button type="button" :disabled="busy || running" class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs disabled:opacity-40" @click="reload">重新加载最新成果</button>
        <p v-if="busy" role="status" class="text-sm text-[var(--muted)]">正在加载参数界面…</p>
        <p v-if="error" role="alert" class="text-sm text-rose-600">{{ error }}</p>
        <iframe v-if="preview" ref="frame" :key="channel" :srcdoc="preview.html" title="参数 UI 数据测试" sandbox="allow-scripts" referrerpolicy="no-referrer" class="h-[55dvh] min-h-[260px] w-full rounded-xl border border-[var(--border)] bg-white" />
        <iframe v-if="reportHtml" :srcdoc="reportHtml" title="任务报告设计预览" sandbox="allow-scripts" referrerpolicy="no-referrer" class="h-[55dvh] min-h-[260px] w-full rounded-xl border border-[var(--border)] bg-white" />
        <details v-if="result"><summary class="cursor-pointer text-sm">测试参数（未保存）</summary><pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--surface-muted)] p-3 text-xs">{{ result }}</pre></details>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
dialog::backdrop { background: rgb(15 23 42 / 35%); backdrop-filter: blur(3px); }
</style>
