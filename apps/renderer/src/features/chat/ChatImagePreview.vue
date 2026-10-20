<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import type { ChatImageAttachment } from '@openclawx/contracts';
import { loadChatImageUrl } from '../../services/orchestration';
const props = defineProps<{ sessionId?: string; image: ChatImageAttachment; index: number }>();
const url = ref('');
const error = ref('');
let controller: AbortController | undefined;
function clear() {
  controller?.abort();
  if (url.value) URL.revokeObjectURL(url.value);
  url.value = '';
}
watch([() => props.sessionId, () => props.image.id], async () => {
  clear(); error.value = '';
  if (!props.sessionId) return;
  const current = new AbortController(); controller = current;
  try {
    const loaded = await loadChatImageUrl(props.sessionId, props.image.id, current.signal);
    if (current.signal.aborted) URL.revokeObjectURL(loaded); else url.value = loaded;
  } catch { if (!current.signal.aborted) error.value = '图片不可用，请重新上传'; }
}, { immediate: true });
onBeforeUnmount(clear);
</script>
<template>
  <figure class="w-28 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-muted)]">
    <a v-if="url" :href="url" target="_blank" rel="noopener" :title="image.name"><img :src="url" :alt="image.name" class="h-20 w-full object-contain" /></a>
    <div v-else class="flex h-20 items-center justify-center p-2 text-xs" role="status">{{ error || '加载图片…' }}</div>
    <figcaption class="truncate px-2 py-1 text-xs" :title="image.name">{{ index + 1 }}. {{ image.name }}</figcaption>
  </figure>
</template>
