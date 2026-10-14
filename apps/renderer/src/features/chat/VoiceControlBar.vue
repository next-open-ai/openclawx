<script setup lang="ts">
import VoiceCaptionStrip from './VoiceCaptionStrip.vue';
import type { VoiceCaption } from './voice-presentation';
withDefaults(defineProps<{
  mode: 'input' | 'realtime'; status: string; seconds: number; levels: number[];
  active?: boolean; paused?: boolean; canStart?: boolean; canPause?: boolean;
  canFinish?: boolean; error?: string; captions?: VoiceCaption[];
  usage?: string;
  canInterrupt?: boolean;
}>(), { active: false, paused: false, canStart: false, canPause: false, canFinish: false, error: '' });
defineEmits<{ start: []; pause: []; finish: []; close: []; interrupt: [] }>();
</script>

<template>
  <section class="voice-dock" :class="{ 'voice-dock-active': active }" :aria-label="mode === 'input' ? '语音输入控制' : '实时对话控制'">
    <div class="voice-dock-main">
      <div class="voice-dock-signal">
        <div class="voice-dock-orb" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>
        </div>
        <div class="voice-dock-wave" role="img" :aria-label="active ? '实时音频声波' : '音频暂停或未连接'">
          <span v-for="index in 28" :key="index" :style="{ height: `${4 + (active ? levels[index - 1] || 0 : 0) * 26}px` }" />
        </div>
        <div class="voice-dock-label"><strong>{{ mode === 'input' ? '语音输入' : '实时对话' }}</strong><span aria-live="polite">{{ status }}</span></div>
        <time class="voice-dock-time">{{ String(Math.floor(seconds / 60)).padStart(2, '0') }}:{{ String(Math.floor(seconds % 60)).padStart(2, '0') }}</time>
        <span v-if="usage" class="voice-dock-usage">{{ usage }}</span>
      </div>
      <div class="voice-dock-actions">
        <button v-if="canInterrupt" type="button" @click="$emit('interrupt')">打断回答</button>
        <button v-if="canStart" type="button" class="voice-dock-start" @click="$emit('start')">{{ error ? '重试' : '开始' }}</button>
        <button v-if="canPause" type="button" :aria-label="paused ? '继续收音' : '暂停收音'" :aria-pressed="paused" @click="$emit('pause')">
          <svg v-if="paused" viewBox="0 0 24 24" fill="currentColor"><path d="m8 5 11 7-11 7z"/></svg>
          <svg v-else viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5" width="3" height="14" rx="1"/><rect x="14" y="5" width="3" height="14" rx="1"/></svg>
          <span>{{ paused ? '继续' : '暂停' }}</span>
        </button>
        <button v-if="canFinish" type="button" @click="$emit('finish')"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg><span>{{ mode === 'input' ? '结束录入' : '结束通话' }}</span></button>
        <button type="button" class="voice-dock-close" aria-label="关闭语音并保留已有内容" @click="$emit('close')">×</button>
      </div>
    </div>
    <p v-if="error" role="alert" class="voice-dock-error">{{ error }}</p>
    <VoiceCaptionStrip v-if="captions?.length" :captions="captions" />
    <p v-else-if="!error" class="voice-dock-hint">{{ mode === 'input' ? '文字实时写入草稿，可随时发送 · 发送时结束录入' : '全双工实时交流 · 字幕将在这里显示，不占用输入框' }}</p>
  </section>
</template>

<style scoped>
.voice-dock{width:100%;max-width:100%;min-width:0;overflow:hidden;border:1px solid var(--border);border-radius:15px;background:var(--surface-muted);padding:12px 14px;transition:background .25s,border-color .25s}
.voice-dock-active{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 25%,var(--border))}
.voice-dock-main,.voice-dock-signal,.voice-dock-actions{display:flex;align-items:center;gap:12px}.voice-dock-main{width:100%;max-width:100%;min-width:0;justify-content:space-between;flex-wrap:wrap}.voice-dock-signal{max-width:100%;min-width:0;flex-wrap:wrap;gap:10px}.voice-dock-orb{display:grid;place-items:center;width:32px;height:32px;border-radius:11px;color:var(--accent);background:var(--surface);box-shadow:0 3px 10px color-mix(in srgb,var(--accent) 8%,transparent)}
.voice-dock-orb svg{width:17px;height:17px}.voice-dock-wave{height:32px;display:flex;align-items:center;gap:3px;color:var(--accent)}.voice-dock-wave span{display:block;width:3px;border-radius:3px;background:currentColor;transition:height .09s ease-out;opacity:.8}.voice-dock-label{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--muted)}.voice-dock-label strong{font-size:12px;color:var(--text);font-weight:600}.voice-dock-time{font:11px ui-monospace,monospace;color:var(--muted)}.voice-dock-actions{gap:5px;flex-wrap:wrap}.voice-dock-actions button{display:flex;align-items:center;justify-content:center;gap:5px;font-size:11px;padding:7px 8px;border-radius:9px;min-height:32px;color:var(--text)}.voice-dock-actions button:hover{background:var(--surface)}.voice-dock-actions svg{width:13px;height:13px}.voice-dock-actions .voice-dock-start{background:var(--accent);color:white;padding:7px 13px}.voice-dock-actions .voice-dock-close{font-size:20px;line-height:1;color:var(--muted);width:28px}.voice-dock-hint{font-size:10px;color:var(--muted);margin:7px 0 0}.voice-dock-error{font-size:12px;color:var(--danger,#c0392b);margin:8px 0 0;overflow-wrap:anywhere}
.voice-dock-usage{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-left:1px solid var(--border);padding-left:10px;font-size:10px;color:var(--muted)}
@media(max-width:520px){.voice-dock{padding:10px}.voice-dock-wave{gap:2px}.voice-dock-wave span{width:2px}.voice-dock-orb{display:none}.voice-dock-main{gap:6px}.voice-dock-signal{gap:7px}.voice-dock-actions button{min-height:40px}}
@media(prefers-reduced-motion:reduce){.voice-dock,.voice-dock-wave span{transition:none}}
</style>
