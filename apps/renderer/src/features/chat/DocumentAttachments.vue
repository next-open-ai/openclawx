<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChatFileAttachment } from '@workmate/contracts';
const props = defineProps<{ disabled: boolean; compact?: boolean; uploadFile: (file: File) => Promise<{ attachment: ChatFileAttachment; warning?: string }> }>();
const emit = defineEmits<{ change: [fileIds: string[]]; uploading: [value: boolean]; valid: [value: boolean] }>();
const picker = ref<HTMLInputElement>();
const uploading = ref(false); const error = ref('');
const entries = ref<Array<{ key: string; file: File; attachment?: ChatFileAttachment; error?: string }>>([]);
const bytes = computed(() => entries.value.reduce((sum, item) => sum + item.file.size, 0));
const size = (value: number) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(value / 1024))} KB`;
function notify() { emit('change', entries.value.flatMap(item => item.attachment ? [item.attachment.id] : [])); emit('valid', entries.value.every(item => !!item.attachment)); }
async function upload() {
  if (uploading.value || props.disabled) return;
  uploading.value = true; emit('uploading', true);
  try {
    for (const item of entries.value.filter(item => !item.attachment)) {
      item.error = undefined;
      try { const result = await props.uploadFile(item.file); item.attachment = result.attachment; if (result.warning) error.value = result.warning; }
      catch (cause) { item.error = cause instanceof Error ? cause.message : '文档上传失败'; }
    }
  } finally { uploading.value = false; emit('uploading', false); notify(); }
}
async function select(event: Event) {
  const input = event.target as HTMLInputElement; const selected = [...(input.files ?? [])]; input.value = '';
  await addFiles(selected);
}
async function addFiles(selected: File[]) {
  if (props.disabled || uploading.value) return;
  error.value = '';
  if (entries.value.length + selected.length > 10 || bytes.value + selected.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024) { error.value = '最多 10 个文档，合计不超过 50 MB。'; return; }
  for (const file of selected) {
    if (!/\.(pdf|docx|pptx|ppsx|xlsx|xls|csv|md|txt|html|htm)$/i.test(file.name) || !file.size) { error.value = `不支持或为空的文件：${file.name}`; continue; }
    entries.value.push({ key: crypto.randomUUID(), file });
  }
  notify(); await upload();
}
function remove(key: string) { if (!props.disabled && !uploading.value) { entries.value = entries.value.filter(item => item.key !== key); notify(); } }
defineExpose({ addFiles, openPicker: () => picker.value?.click() });
</script>

<template>
  <section :class="['rounded-xl border border-[var(--border)] p-3', compact ? 'mt-2 max-h-48 overflow-y-auto' : 'mt-4']" aria-label="本次运行文档">
    <div class="flex items-center justify-between gap-3"><div><h3 class="text-sm font-semibold">参考文档 <span class="font-normal text-[var(--muted)]">（可选）</span></h3><p class="mt-1 text-xs text-[var(--muted)]">最多 10 个，合计 50 MB · 原件与解析文本随项目保留</p></div><button type="button" class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--accent)] disabled:opacity-40" :disabled="disabled || uploading" @click="picker?.click()">{{ uploading ? '上传并解析中…' : '添加文档' }}</button></div>
    <input ref="picker" type="file" multiple accept=".pdf,.docx,.pptx,.ppsx,.xlsx,.xls,.csv,.md,.txt,.html,.htm" class="hidden" aria-label="选择参考文档" :disabled="disabled || uploading" @change="select" />
    <p v-if="!entries.length" class="mt-3 text-xs leading-5 text-[var(--muted)]">支持 PDF、Word（DOCX）、PPT、Excel、CSV、Markdown、TXT、HTML。文档内容作为业务材料，不改变员工权限。</p>
    <ul v-else class="mt-3 space-y-2">
      <li v-for="item in entries" :key="item.key" class="flex items-start gap-3 rounded-lg bg-[var(--surface-muted)] p-2">
        <div class="min-w-0 flex-1"><p class="truncate text-sm">{{ item.file.name }} <span class="text-xs text-[var(--muted)]">{{ size(item.file.size) }}</span></p><p :class="['mt-1 text-xs',item.error ? 'text-rose-600' : 'text-[var(--muted)]']">{{ item.error || item.attachment?.summary || '等待上传并解析…' }}</p></div>
        <button type="button" :aria-label="`移除 ${item.file.name}`" class="text-xs text-[var(--muted)] disabled:opacity-40" :disabled="disabled || uploading" @click="remove(item.key)">移除</button>
      </li>
    </ul>
    <p v-if="error" role="alert" class="mt-2 text-xs text-rose-600">{{ error }}</p>
    <button v-if="entries.some(item => item.error)" type="button" class="mt-2 text-xs text-[var(--accent)] underline disabled:opacity-40" :disabled="disabled || uploading" @click="upload">重试失败文档</button>
  </section>
</template>
