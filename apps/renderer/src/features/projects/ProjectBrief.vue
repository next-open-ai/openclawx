<script setup lang="ts">
defineProps<{ goal: string }>();
</script>

<template>
  <details v-if="goal.trim()" class="project-brief text-xs">
    <summary class="w-fit cursor-pointer rounded-md px-1 py-1 font-medium text-[var(--muted)] hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">项目说明</summary>
    <div class="project-brief-content mt-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-[var(--muted)]">{{ goal }}</div>
  </details>
</template>

<style scoped>
.project-brief-content {
  max-height: min(12rem, 25vh);
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.65;
}
</style>
