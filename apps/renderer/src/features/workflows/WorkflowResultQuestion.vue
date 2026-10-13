<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import type { WorkflowResultEvidence } from '@workmate/contracts';
import { workflowResultEvidence } from '../../services/orchestration';

const props = defineProps<{ sessionId?: string; disabled: boolean }>();
const emit = defineEmits<{ change: [value: WorkflowResultEvidence | null] }>();
const evidence = ref<WorkflowResultEvidence | null>(null); const loading = ref(false); const error = ref('');
let generation = 0;
const reference = computed(() => evidence.value?.reference);
function clear() { generation++; evidence.value = null; loading.value = false; error.value = ''; emit('change', null); }
watch(() => props.sessionId, clear);
onBeforeUnmount(() => { generation++; });
async function select(invocationId: string) {
  if (!props.sessionId || props.disabled || loading.value) return;
  const token = ++generation; const sessionId = props.sessionId;
  loading.value = true; error.value = ''; evidence.value = null; emit('change', null);
  try {
    const result = await workflowResultEvidence(sessionId, invocationId);
    if (generation !== token) return;
    evidence.value = result.evidence; emit('change', result.evidence);
  } catch (cause) { if (generation === token) error.value = cause instanceof Error ? cause.message : '成果依据读取失败，请重试。'; }
  finally { if (generation === token) loading.value = false; }
}
defineExpose({ select, clear, reference, loading });
</script>

<template>
  <div v-if="loading || error || evidence" class="mb-3 min-w-0 rounded-xl border border-[var(--border)] bg-[var(--accent-soft)] px-3 py-2.5" aria-label="成果问答依据">
    <p v-if="loading" role="status" class="text-xs text-[var(--muted)]">正在读取真实成果依据…</p>
    <p v-if="error" role="alert" class="text-xs text-rose-600">{{ error }}</p>
    <div v-if="evidence" class="flex min-w-0 items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="break-words text-xs font-semibold">基于成果提问 · {{ evidence.workflowName }}</p>
        <p class="mt-1 text-[11px] leading-5 text-[var(--muted)]">{{ evidence.status === 'completed' ? '已完成' : '部分输出，尚未完成交付' }} · 仅问答，不修改文件或重跑 · 使用当前对话模型</p>
        <p class="text-[11px] leading-5 text-[var(--muted)]">依据为已保存文本与文件清单，未读取文件正文{{ evidence.truncated ? '；文本已截断' : '' }}。可连续提问。</p>
        <p class="text-[11px] leading-5 text-[var(--muted)]">答案保存在本对话，按本对话的共享范围可见。</p>
      </div>
      <button type="button" class="shrink-0 rounded-md px-2 py-1 text-xs text-[var(--muted)] hover:bg-[var(--surface)] disabled:opacity-40" :disabled="disabled" @click="clear">取消引用</button>
    </div>
  </div>
</template>
