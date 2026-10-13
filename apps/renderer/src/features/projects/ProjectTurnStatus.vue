<script setup lang="ts">
import { computed } from 'vue';
import type { ProjectTask } from '../../app/projects.js';
import { turnIssue } from './project-conversation-presentation.js';

const props = defineProps<{ task?: ProjectTask; content?: string }>();
const issue = computed(() => turnIssue(props.task, props.content));
const failure = computed(() => props.task?.transcript?.failure);
</script>

<template>
  <div v-if="issue || failure" class="mt-2 min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs leading-5">
    <p v-if="issue" :role="task?.status === 'failed' ? 'alert' : 'status'" class="whitespace-pre-wrap break-words" :class="task?.status === 'failed' ? 'text-rose-600' : 'text-[var(--muted)]'">{{ issue }}</p>
    <details v-if="failure" class="text-[var(--muted)]">
      <summary class="cursor-pointer">运行诊断</summary>
      <p class="mt-1 break-words">{{ failure.code }} · {{ failure.phase }} · {{ Math.round(failure.elapsedMs / 1000) }} 秒<span v-if="failure.status"> · HTTP {{ failure.status }}</span></p>
      <p class="whitespace-pre-wrap break-words">{{ failure.signature }}</p>
    </details>
  </div>
</template>
