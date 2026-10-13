<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import type { WorkflowExecutionSummary } from '@workmate/contracts';
import * as orch from '../../services/orchestration';
import { downloadAssetBestEffort, openAssetBestEffort } from '../../app/platform-actions';

const props = defineProps<{ workflowId: string }>();
const emit = defineEmits<{ openProject: [id: string] }>();
const items = ref<WorkflowExecutionSummary[]>([]);
const loading = ref(false); const loaded = ref(false); const error = ref(''); const actionError = ref(''); const acting = ref('');
let timer: ReturnType<typeof setTimeout> | undefined; let disposed = false;
const labels: Record<WorkflowExecutionSummary['status'], string> = { draft: '待启动', running: '执行中', 'waiting-approval': '等待审批', completed: '执行完成', failed: '执行失败', cancelled: '已取消', unavailable: '项目不可用' };
function elapsed(ms: number) { const seconds = Math.floor(ms / 1000); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; }
async function refresh() {
  if (loading.value || disposed) return;
  clearTimeout(timer); loading.value = true; error.value = '';
  try { const result = await orch.listWorkflowRuns(props.workflowId); if (!disposed) { items.value = result.items; loaded.value = true; } }
  catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : '无法读取运行记录'; }
  finally {
    if (!disposed) {
      loading.value = false;
      if (!error.value && items.value.some(item => item.status === 'running' || item.status === 'waiting-approval')) timer = setTimeout(() => void refresh(), 4000);
    }
  }
}
async function start(item: WorkflowExecutionSummary) {
  if (acting.value) return;
  acting.value = item.id; actionError.value = '';
  try { await orch.confirmProject(item.projectId, { resumeIncomplete: item.status !== 'draft' }); await refresh(); }
  catch (cause) { actionError.value = cause instanceof Error ? cause.message : '无法启动，请查看项目详情'; }
  finally { acting.value = ''; }
}
async function assetAction(id: string, download: boolean) {
  actionError.value = '';
  try { if (download) await downloadAssetBestEffort(id); else await openAssetBestEffort(id); }
  catch (cause) { actionError.value = cause instanceof Error ? cause.message : '无法打开成果，请在项目中查看'; }
}
onMounted(refresh);
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); });
</script>

<template>
  <section class="mt-5 border-t border-[var(--border)] pt-4" aria-label="运行历史">
    <header class="flex items-center justify-between gap-3"><h3 class="text-sm font-semibold">运行记录</h3><button class="action" :disabled="loading" @click="refresh">{{ loading ? '正在刷新…' : '刷新' }}</button></header>
    <p v-if="error" role="alert" class="mt-3 text-sm text-rose-600">{{ error }}<span v-if="loaded">；下方为上次读取的记录，尚未更新。</span></p>
    <p v-if="actionError" role="alert" class="mt-3 text-sm text-rose-600">{{ actionError }}</p>
    <p v-if="!loaded && loading" role="status" class="py-5 text-sm text-[var(--muted)]">正在读取执行状态与成果…</p>
    <p v-else-if="loaded && !items.length" class="py-5 text-sm text-[var(--muted)]">暂无运行记录。点击运行，填写本次要求后开始。旧版未关联的项目仍可在项目菜单查看。</p>
    <div class="mt-3 space-y-3">
      <article v-for="item in items" :key="item.id" class="rounded-lg border border-[var(--border)] p-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-3 text-xs"><span class="rounded-md bg-[var(--surface-muted)] px-2 py-1 font-semibold" :class="item.status === 'failed' ? 'text-rose-600' : item.status === 'completed' ? 'text-emerald-600' : 'text-[var(--accent)]'">{{ labels[item.status] }}</span><time class="text-[var(--muted)]">{{ new Date(item.createdAt).toLocaleString() }}</time></div>
          <div class="flex gap-2"><button v-if="item.status === 'draft' || item.status === 'failed' || item.status === 'cancelled'" class="action" :disabled="!!acting || !!error" @click="start(item)">{{ acting === item.id ? '正在提交…' : item.status === 'draft' ? '启动' : '恢复未完成步骤' }}</button><button v-if="item.status !== 'unavailable'" class="action" @click="emit('openProject', item.projectId)">{{ item.status === 'waiting-approval' ? '进入项目审批' : '查看执行详情' }}</button></div>
        </div>
        <p class="mt-3 whitespace-pre-wrap break-words text-sm">{{ item.input || '按工作流定义执行' }}</p>
        <details v-if="item.documents?.length" class="mt-2 text-xs text-[var(--muted)]"><summary class="cursor-pointer">参考文档 · {{ item.documents.length }} 个（非交付物）</summary><p v-for="document in item.documents" :key="document.path" class="mt-2 break-all">{{ document.name }} · {{ document.path }}</p></details>
        <p class="mt-2 text-xs text-[var(--muted)]">步骤 {{ item.completedTasks }}/{{ item.totalTasks }} · 累计 {{ elapsed(item.elapsedMs) }} · {{ item.attemptCount }} 轮调度</p>
        <p v-if="item.error" class="mt-2 whitespace-pre-wrap break-words text-xs text-rose-600">{{ item.error }}</p>
        <p v-if="item.status === 'failed' || item.status === 'cancelled'" class="mt-2 text-xs text-[var(--muted)]">恢复会保留已完成步骤及成果，只继续未完成部分。</p>
        <div v-if="item.artifacts.length" class="mt-3 grid gap-2 sm:grid-cols-2">
          <div v-for="artifact in item.artifacts" :key="artifact.assetId || artifact.path" class="min-w-0 rounded-lg bg-[var(--surface-muted)] p-3">
            <p class="break-words text-sm font-medium">{{ artifact.assetName || artifact.path.split(/[\\/]/).pop() }}</p>
            <p class="mt-1 text-xs text-[var(--muted)]">{{ artifact.partial ? '未完成尝试的产物，请核验' : artifact.assetId ? '已登记资产' : '已登记文件，可在项目中查看' }}</p>
            <div v-if="artifact.assetId" class="mt-2 flex gap-3"><button class="text-xs text-[var(--accent)]" @click="assetAction(artifact.assetId!, false)">查看成果</button><button class="text-xs text-[var(--accent)]" @click="assetAction(artifact.assetId!, true)">下载</button></div>
          </div>
        </div>
        <p v-else-if="item.status === 'completed'" class="mt-3 text-xs text-[var(--muted)]">执行已结束，暂无已登记文件；文字结果请在项目详情查看。文件任务请核验实际交付。</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.action { border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 12px; white-space: nowrap; }
button:disabled { opacity: .5; cursor: not-allowed; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
