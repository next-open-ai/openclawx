<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from '../../app/i18n';

const props = defineProps<{ modelValue: string; contextId: string; required?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const { t } = useI18n();
const revealed = ref(false);
watch(() => props.contextId, () => { revealed.value = false; });
function update(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="flex min-w-0 items-stretch overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] focus-within:border-[var(--accent)]">
    <input class="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm font-normal text-[var(--text)] outline-none" :type="revealed ? 'text' : 'password'" :value="modelValue" :required="required" autocomplete="off" autocapitalize="off" :spellcheck="false" placeholder="sk-…" :aria-label="t('settings.apiKey')" @input="update" />
    <button type="button" class="shrink-0 px-3 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]" :aria-label="t(revealed ? 'settings.hideApiKey' : 'settings.showApiKey')" :aria-pressed="revealed" @click="revealed = !revealed">{{ t(revealed ? 'settings.hideApiKey' : 'settings.showApiKey') }}</button>
  </div>
</template>
