<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import type { DataSource } from '../../services/api';

export type DataAppCreateDraft = { tableId: string; name: string; idea: string };
const props = defineProps<{ source: DataSource; tableId: string; busy: boolean; error: string; notice?: string; credentialRequired?: boolean; suspended?: boolean }>();
const emit = defineEmits<{ close: []; submit: [draft: DataAppCreateDraft]; repairConnection: [] }>();
const draft = ref<DataAppCreateDraft>({ tableId: props.tableId, name: '', idea: '' });
const tables = computed(() => props.source.tables || []);
const table = computed(() => tables.value.find(item => item.id === draft.value.tableId));
const input = ref<HTMLInputElement | null>(null);
const form = ref<HTMLFormElement | null>(null);
const canSubmit = computed(() => !props.busy && Boolean(table.value) && Boolean(draft.value.idea.trim()));
const example = '帮助我快速理解这些数据，提供统计、筛选与明细查询。请根据数据内容设计清晰、易用且适配手机的只读页面。';
const previousFocus = document.activeElement as HTMLElement | null;
function close() { if (!props.busy) emit('close'); }
function keydown(event: KeyboardEvent) {
  if (props.suspended) return;
  if (event.key === 'Escape') { event.preventDefault(); close(); }
  if (event.key === 'Tab') {
    const controls = Array.from(form.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary') || []).filter(element => element.getClientRects().length);
    const first = controls[0]; const last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); form.value?.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === form.value)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
}
onMounted(async () => { document.addEventListener('keydown', keydown); await nextTick(); input.value?.focus(); });
onUnmounted(() => { document.removeEventListener('keydown', keydown); previousFocus?.focus(); });
function submit() {
  if (!canSubmit.value) return;
  emit('submit', { ...draft.value, name: draft.value.name.trim() || `${props.source.name}应用`, idea: draft.value.idea.trim() });
}
</script>

<template>
  <div class="absolute inset-0 z-30 grid place-items-center bg-slate-950/35 p-4 backdrop-blur-[1px]">
    <form ref="form" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="data-app-create-title" :aria-busy="busy" class="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl" @submit.prevent="submit">
      <div class="flex shrink-0 items-start justify-between gap-3"><div><h2 id="data-app-create-title" class="text-xl font-bold">创建数据应用</h2><p class="mt-2 text-sm text-[var(--muted)]">说明你想解决的问题，AI 将在专属项目中制作应用。</p></div><button type="button" :disabled="busy" aria-label="关闭创建应用" class="rounded px-2 py-1 text-[var(--muted)] disabled:opacity-50" @click="close">×</button></div>
      <div class="mt-5 min-h-0 overflow-y-auto"><fieldset :disabled="busy" class="min-w-0 space-y-4 disabled:opacity-70">
        <div class="rounded-xl bg-[var(--surface-muted)] p-3"><p class="break-words text-xs text-[var(--muted)]">数据对象：{{ source.name }}</p><div class="mt-2 flex items-center justify-between gap-2"><b class="text-sm">使用整个数据对象</b><span class="text-xs text-emerald-700">全部 {{ tables.length }} 张表已选中</span></div><ul class="mt-3 max-h-36 space-y-2 overflow-y-auto text-xs"><li v-for="item in tables" :key="item.id" class="flex items-center gap-2"><span aria-hidden="true" class="text-emerald-600">✓</span><span class="break-words">{{ item.name }}</span></li></ul><p class="mt-3 text-xs leading-5 text-[var(--muted)]">AI 根据对象 Schema 生成 SQL 并验证查询，再制作页面；不会访问对象以外的表。默认只读。实时对象的新增、修改、删除须先由你确认操作，并开启对象写入；AI 测试不会修改原库。</p></div>
        <div>
          <label class="block"><span class="mb-1.5 block text-xs font-semibold">应用名称 <span class="font-normal text-[var(--muted)]">可选</span></span><input ref="input" v-model="draft.name" maxlength="120" :placeholder="`${source.name}应用`" class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]" /></label>
        </div>
        <label class="block"><span class="mb-1.5 block text-xs font-semibold">希望应用做什么？</span><textarea v-model="draft.idea" required maxlength="4000" rows="3" :placeholder="example" class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]" /><button type="button" class="mt-1 text-xs font-semibold text-[var(--accent)]" @click="draft.idea = example">填入示例后修改</button></label>
        <details class="rounded-lg border border-[var(--border)] p-3"><summary class="cursor-pointer text-xs font-semibold">查看各表字段</summary><div class="mt-2 max-h-48 space-y-3 overflow-auto text-xs"><section v-for="item in tables" :key="item.id"><b>{{ item.name }}</b><ul class="mt-2 space-y-2"><li v-for="column in item.columns" :key="column.id" class="break-words"><span>{{ column.name }}</span><span class="ml-2 text-[var(--muted)]">{{ column.description || '未填写说明' }}</span></li></ul></section></div></details>
      </fieldset></div>
      <p v-if="error" role="alert" class="mt-4 shrink-0 break-words rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{{ error }}</p>
      <button v-if="credentialRequired" type="button" class="mt-2 self-start rounded-lg border border-[var(--accent)] px-3 py-2 text-sm font-semibold text-[var(--accent)]" @click="emit('repairConnection')">补填密码并恢复连接 →</button>
      <p v-if="notice && !error" role="status" class="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">{{ notice }}</p>
      <p class="mt-4 shrink-0 text-xs leading-5 text-[var(--muted)]">自动建立专属项目并开始执行。页面交付后可在工作台打开，后续优化沿用同一项目。</p>
      <div class="mt-5 flex shrink-0 justify-end gap-2"><button type="button" :disabled="busy" class="rounded-lg border border-[var(--border)] px-4 py-2 text-sm disabled:opacity-50" @click="close">取消</button><button type="submit" :disabled="!canSubmit" class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{{ busy ? '准备项目…' : '创建并开始' }}</button></div>
    </form>
  </div>
</template>
