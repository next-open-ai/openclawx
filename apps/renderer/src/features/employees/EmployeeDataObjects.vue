<script setup lang="ts">
import { computed, onMounted, ref, onBeforeUnmount } from 'vue';
import { liveDataRequest } from '../../services/live-data';
const props = defineProps<{ employeeId: string; engine: string }>();
type Source = { id: string; name: string; fileType: string; tableCount: number; accessMode?: string };
const sources = ref<Source[]>([]), loading = ref(false), error = ref(''), search = ref('');
const modelValue = ref<string[]>([]), savedIds = ref<string[]>([]), saving = ref(false), ready = ref(false), feedback = ref('');
const controller = new AbortController(); onBeforeUnmount(() => controller.abort());
const dirty = computed(() => JSON.stringify([...modelValue.value].sort()) !== JSON.stringify([...savedIds.value].sort()));
const filtered = computed(() => sources.value.filter(s => s.name.toLowerCase().includes(search.value.toLowerCase())));
const stale = computed(() => modelValue.value.filter(id => !sources.value.some(s => s.id === id)));
async function refresh() {
  loading.value = true; error.value = '';
  try {
    sources.value = await liveDataRequest<Source[]>('/sources', 'GET', undefined, controller.signal);
    if (!ready.value) {
      const value = await liveDataRequest<{ dataSourceIds: string[] }>(`/agent-associations/${encodeURIComponent(props.employeeId)}`, 'GET', undefined, controller.signal);
      modelValue.value = [...value.dataSourceIds]; savedIds.value = [...value.dataSourceIds]; ready.value = true;
    }
  }
  catch { error.value = '数据对象读取失败，请检查登录状态或数据服务后重试。'; }
  finally { loading.value = false; }
}
function toggle(id: string) {
  feedback.value = '';
  modelValue.value = modelValue.value.includes(id) ? modelValue.value.filter(v => v !== id) : [...modelValue.value, id];
}
async function save() {
  saving.value = true; error.value = ''; feedback.value = '';
  try {
    const value = await liveDataRequest<{ dataSourceIds: string[] }>(`/agent-associations/${encodeURIComponent(props.employeeId)}`, 'PUT', { dataSourceIds: modelValue.value }, controller.signal);
    savedIds.value = [...value.dataSourceIds]; modelValue.value = [...value.dataSourceIds]; feedback.value = modelValue.value.length ? '数据关联已保存，后续工具调用按此范围检查。' : '数据关联已清空，问数已关闭。';
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败，请重试。'; }
  finally { saving.value = false; }
}
onMounted(refresh);
</script>

<template>
  <section class="grid gap-3 rounded-xl border border-[var(--border)] p-4 sm:col-span-2" aria-label="数据问数">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div><h4 class="text-sm font-semibold">数据问数</h4><p class="mt-1 text-xs text-[var(--muted)]">只读访问勾选的数据对象；本区域单独保存，不选并保存即关闭。</p></div>
      <button type="button" class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs" :disabled="loading || saving" @click="refresh">{{ loading ? '读取中…' : '刷新对象' }}</button>
    </div>
    <p class="text-xs text-[var(--muted)]">查询内容会发送至当前智能体使用的模型，并进入对话记录。敏感字段不提供给模型；仅支持私有对话／项目。</p>
    <p v-if="engine === 'dsh'" class="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">当前 DSH 引擎暂不提供问数工具，请选择 Pi 或 AgentScope。已选对象仍可保存。</p>
    <p v-else-if="!engine" class="text-xs text-[var(--muted)]">跟随默认引擎时，问数仅在默认引擎为 Pi 或 AgentScope 时可用。</p>
    <input v-model="search" type="search" placeholder="搜索数据对象" aria-label="搜索数据对象" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm" />
    <p v-if="error" role="alert" class="text-xs text-red-600">{{ error }}</p>
    <p v-else-if="loading" role="status" class="text-xs text-[var(--muted)]">正在读取当前用户的数据对象…</p>
    <p v-else-if="!filtered.length" class="rounded-lg border border-dashed border-[var(--border)] p-4 text-xs text-[var(--muted)]">{{ sources.length ? '没有匹配的对象。' : '暂无数据对象，请先到数据工作台导入或创建。' }}</p>
    <div v-else class="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
      <label v-for="s in filtered" :key="s.id" class="flex cursor-pointer items-start gap-3 rounded-lg border p-3" :class="modelValue.includes(s.id) ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)]'">
        <input type="checkbox" :checked="modelValue.includes(s.id)" :disabled="!ready || loading || saving || (!modelValue.includes(s.id) && modelValue.length >= 24)" class="mt-1 accent-[var(--accent)]" @change="toggle(s.id)" />
        <span class="min-w-0"><span class="block break-words text-sm font-medium">{{ s.name }}</span><span class="mt-1 block text-xs text-[var(--muted)]">{{ s.fileType }} · {{ s.tableCount }} 张表 · {{ s.accessMode === 'live' ? '实时只读' : s.accessMode === 'snapshot' ? '本地副本' : '本地数据' }}</span></span>
      </label>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted)]"><span>已选择 {{ modelValue.length }} / 24 个对象{{ dirty ? ' · 未保存' : '' }}</span><div class="flex items-center gap-3"><button v-if="modelValue.length" :disabled="saving || loading" type="button" class="text-[var(--accent)]" @click="modelValue = []; feedback = ''">清空关联</button><button type="button" class="rounded-lg bg-[var(--accent)] px-3 py-2 font-semibold text-white disabled:opacity-50" :disabled="!ready || loading || saving || !dirty" @click="save">{{ saving ? '保存中…' : '保存数据关联' }}</button></div></div>
    <p v-if="feedback" role="status" class="text-xs text-emerald-700">{{ feedback }}</p>
    <p v-if="!loading && !error && stale.length" role="status" class="text-xs text-amber-700">{{ stale.length }} 个已关联对象已删除或不可访问，运行时将拒绝访问。可清空后重新选择。</p>
  </section>
</template>
