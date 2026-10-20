<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import type { VoiceCaption } from './voice-presentation';

const props = defineProps<{ captions: VoiceCaption[] }>();
const panelId = useId();
const expanded = ref(false);
const entries = computed(() => props.captions.flatMap(caption => [
  ...(caption.question ? [{ key: `${caption.id}:question`, speaker: '你', text: caption.question }] : []),
  ...(caption.answer ? [{ key: `${caption.id}:answer`, speaker: 'OpenClawX', text: caption.answer }] : []),
]));
const current = computed(() => entries.value.at(-1));
</script>

<template>
  <section v-if="entries.length" class="voice-captions" aria-label="语音字幕">
    <div class="voice-caption-row">
      <span class="voice-caption-tag">{{ current?.speaker }}</span>
      <p class="voice-caption-preview" :title="current?.text">{{ current?.text }}</p>
      <div class="voice-caption-controls">
        <button type="button" class="voice-caption-expand" :aria-expanded="expanded" :aria-controls="panelId" @click="expanded = !expanded">
          <span>{{ expanded ? '收起字幕' : '展开字幕' }}</span>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" :class="{ flipped: expanded }"><path d="m5 7 5 5 5-5"/></svg>
        </button>
      </div>
    </div>
    <div v-if="expanded" :id="panelId" class="voice-caption-history" tabindex="0" aria-label="全部语音字幕">
      <p class="voice-caption-note">本页语音记录 · 最近 {{ captions.length }} 轮</p>
      <article v-for="entry in entries" :key="entry.key" class="voice-caption-entry" :class="{ 'voice-caption-user': entry.speaker === '你' }">
        <span class="voice-caption-tag">{{ entry.speaker }}</span><p>{{ entry.text }}</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.voice-captions{width:100%;max-width:100%;min-width:0;overflow:hidden;color:var(--text)}.voice-caption-row{display:flex;width:100%;max-width:100%;align-items:center;gap:9px;min-width:0;padding-top:9px}.voice-caption-tag{flex-shrink:0;font-size:10px;font-weight:600;color:var(--accent)}.voice-caption-preview{display:block;flex:1 1 0;min-width:0;max-width:100%;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:22px}.voice-caption-controls{display:flex;align-items:center;flex:0 0 auto;color:var(--muted)}.voice-caption-controls button{display:flex;align-items:center;justify-content:center;border-radius:7px;min-height:30px}.voice-caption-controls button:hover{background:var(--surface);color:var(--accent)}.voice-caption-controls button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.voice-caption-controls .voice-caption-expand{gap:4px;padding:0 7px;font-size:11px}.voice-caption-expand svg{width:14px;height:14px}.flipped{transform:rotate(180deg)}.voice-caption-history{width:100%;max-width:100%;max-height:240px;overflow:auto;overscroll-behavior:contain;margin-top:9px;border-top:1px solid var(--border);padding-top:9px}.voice-caption-note{font-size:10px;color:var(--muted);margin:0 0 9px}.voice-caption-entry{display:flex;max-width:100%;min-width:0;align-items:flex-start;gap:10px;padding:8px 10px;margin-bottom:6px;border-radius:10px;background:var(--surface)}.voice-caption-entry p{min-width:0;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-size:12px;line-height:1.8}.voice-caption-entry .voice-caption-tag{line-height:22px}.voice-caption-user{background:var(--accent-soft)}.voice-caption-user .voice-caption-tag{color:var(--muted)}
@media(max-width:520px){.voice-caption-row{flex-wrap:wrap;gap:5px}.voice-caption-preview{flex-basis:calc(100% - 65px)}.voice-caption-controls{margin-left:auto}.voice-caption-controls button{min-height:36px}.voice-caption-history{max-height:200px}}
</style>
