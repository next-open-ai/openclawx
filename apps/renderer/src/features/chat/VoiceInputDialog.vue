<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { asrCommand, consumeAsrEvents, realtimeVoiceCapabilities } from '../../services/realtime-voice';
import type { AsrEvent } from '@openclawx/contracts';
import VoiceControlBar from './VoiceControlBar.vue';
import { voiceEnvelope } from './voice-presentation';

const props = withDefaults(defineProps<{ testMode?: boolean; inline?: boolean; autoStart?: boolean }>(), { testMode: false, inline: false, autoStart: false });
const emit = defineEmits<{ close: []; transcript: [text: string]; preview: [text: string]; busy: [active: boolean]; 'session-start': [] }>();
const state = ref<'idle' | 'connecting' | 'recording' | 'finishing' | 'done' | 'error'>('idle');
const text = ref(''); const error = ref(''); const seconds = ref(0);
const paused = ref(false); const levels = ref<number[]>([]);
watch(text, value => { if (props.inline) emit('preview', value); });
watch(state, value => emit('busy', ['connecting', 'recording', 'finishing'].includes(value)), { immediate: true });
let id = ''; let controller: AbortController | undefined;
let stream: MediaStream | undefined; let context: AudioContext | undefined;
let source: MediaStreamAudioSourceNode | undefined; let node: ScriptProcessorNode | undefined;
let pumpTimer: number | undefined; let clock: number | undefined;
let chunks: Uint8Array[] = []; let size = 0; let uploading: Promise<void> | undefined;
let generation = 0;
const labels = { idle: '准备录音', connecting: '正在连接', recording: '正在识别', finishing: '等待最终修订', done: '识别完成', error: '识别未完成' };

function pcm(input: Float32Array, rate: number) {
  const ratio = rate / 16000; const samples = Math.floor(input.length / ratio); const bytes = new Uint8Array(samples * 2); const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples; i++) {
    let sum = 0; const start = Math.floor(i * ratio); const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    for (let j = start; j < end; j++) sum += input[j];
    const value = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    view.setInt16(i * 2, value * (value < 0 ? 32768 : 32767), true);
  }
  return bytes;
}
async function flush() {
  if (uploading) { await uploading; return flush(); }
  if (!id || !size) return;
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  chunks = []; size = 0;
  const activeId = id;
  uploading = (async () => {
    for (let start = 0; start < bytes.length; start += 9600) {
      if (id !== activeId) return;
      const part = bytes.subarray(start, start + 9600); let binary = '';
      for (const value of part) binary += String.fromCharCode(value);
      await asrCommand('audio', { session_id: activeId, audio: btoa(binary) });
    }
  })();
  try { await uploading; } finally { uploading = undefined; }
}
function stopCapture() {
  levels.value = [];
  window.clearInterval(pumpTimer); window.clearInterval(clock); pumpTimer = undefined; clock = undefined;
  node?.disconnect(); source?.disconnect(); stream?.getTracks().forEach((track) => track.stop());
  void context?.close().catch(() => undefined); node = undefined; source = undefined; context = undefined; stream = undefined;
}
async function closeRemote() {
  controller?.abort(); controller = undefined;
  const closing = id; id = ''; chunks = []; size = 0;
  if (closing) await asrCommand('close', { session_id: closing }).catch(() => undefined);
}
async function fail(cause: unknown) {
  if (state.value === 'done' || state.value === 'error') return;
  error.value = cause instanceof Error ? cause.message : String(cause); state.value = 'error'; stopCapture(); await closeRemote();
}
function event(event: AsrEvent) {
  if (event.type === 'connected' && state.value === 'connecting') {
    context = new AudioContext(); source = context.createMediaStreamSource(stream!); node = context.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (value) => {
      if (state.value !== 'recording' || paused.value) return;
      const samples = value.inputBuffer.getChannelData(0);
      levels.value = voiceEnvelope(samples);
      const bytes = pcm(samples, context!.sampleRate); chunks.push(bytes); size += bytes.length;
      if (size > 128_000) void fail('上传过慢，录音已停止，已识别文字仍可使用。');
    };
    source.connect(node); node.connect(context.destination); void context.resume().catch(fail);
    state.value = 'recording'; pumpTimer = window.setInterval(() => { void flush().catch(fail); }, 250);
    clock = window.setInterval(() => { seconds.value++; if (seconds.value >= 115) void finish(); }, 1000);
  } else if (event.type === 'transcript') text.value = event.text;
  else if (event.type === 'completed') { text.value = event.text; state.value = 'done'; stopCapture(); void closeRemote(); }
  else if (event.type === 'error') void fail(event.message);
  else if (event.type === 'closed' && state.value !== 'done' && state.value !== 'error') void fail('识别连接已关闭，已收到的文字仍可使用。');
}
async function start() {
  if (!['idle', 'done', 'error'].includes(state.value)) return;
  const token = ++generation; state.value = 'connecting'; error.value = ''; seconds.value = 0; paused.value = false;
  await closeRemote();
  await uploading?.catch(() => undefined);
  if (token !== generation) return;
  try {
    const capabilities = await realtimeVoiceCapabilities();
    if (!capabilities.asr?.enabled) throw new Error('语音输入未启用或未配置密钥，请先在设置 > 语音中完成配置。');
    if (token !== generation) return;
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (token !== generation) { mic.getTracks().forEach((track) => track.stop()); return; }
    stream = mic;
    const created = await asrCommand('session'); const createdId = String(created.session_id || '');
    if (token !== generation) { if (createdId) await asrCommand('close', { session_id: createdId }); return; }
    if (!createdId) throw new Error('服务未返回 ASR 会话。');
    id = createdId; emit('session-start'); text.value = ''; controller = new AbortController(); const activeController = controller;
    void consumeAsrEvents(id, activeController.signal, value => {
      if (!activeController.signal.aborted && token === generation) event(value);
    }).then(() => {
      if (!activeController.signal.aborted && !['done', 'error'].includes(state.value)) void fail('识别事件连接已断开。');
    }).catch((cause) => { if (!activeController.signal.aborted) void fail(cause); });
  } catch (cause) { if (token === generation) await fail(cause); }
}
async function finish() {
  if (state.value !== 'recording') return;
  state.value = 'finishing'; stopCapture();
  try { await flush(); if (id) await asrCommand('finish', { session_id: id }); } catch (cause) { await fail(cause); }
}
async function cancel() { generation++; stopCapture(); await closeRemote(); emit('close'); }
function togglePause() { paused.value = !paused.value; levels.value = []; stream?.getAudioTracks().forEach(track => { track.enabled = !paused.value; }); }
async function confirm() { const value = text.value.trim(); if (!value || !['done', 'error'].includes(state.value)) return; emit('transcript', value); await cancel(); }
onBeforeUnmount(() => { generation++; stopCapture(); void closeRemote(); });
onMounted(() => { if (props.autoStart) void start(); });
</script>

<template>
  <VoiceControlBar v-if="inline" mode="input" :captions="text ? [{ id: 'asr-current', question: text, answer: '' }] : []" :status="paused && state === 'recording' ? '已暂停收音' : labels[state]" :seconds="seconds" :levels="levels" :active="state === 'recording' && !paused" :paused="paused" :can-start="['idle', 'done', 'error'].includes(state)" :can-pause="state === 'recording'" :can-finish="state === 'recording'" :error="error" @start="start" @pause="togglePause" @finish="finish" @close="cancel" />
  <div v-else class="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="语音输入">
    <section class="w-full max-w-xl rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
      <header class="flex items-center justify-between"><div><h2 class="font-bold">{{ props.testMode ? 'ASR 配置测试' : '语音输入' }}</h2><p class="mt-1 text-xs text-[var(--muted)]">只转文字，不调用 Agent、不播音、不自动发送 · 最多 2 分钟</p></div><button type="button" @click="cancel">关闭</button></header>
      <p class="my-5 text-center font-semibold" aria-live="polite">{{ labels[state] }} · {{ seconds }} 秒</p>
      <textarea v-model="text" rows="7" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm" :readonly="!['done', 'error', 'idle'].includes(state)" placeholder="边说边出字；停止后等待最终修订，可编辑再确认。" aria-label="识别文字" />
      <p v-if="error" role="alert" class="mt-3 rounded-xl bg-rose-500/10 p-3 text-sm text-rose-700">{{ error }}</p>
      <p v-if="state === 'done' && !text.trim()" class="mt-3 text-sm text-[var(--muted)]">未识别到有效语音，可以重新录音。</p>
      <footer class="mt-5 flex flex-wrap justify-end gap-3">
        <button type="button" class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm" @click="cancel">取消</button>
        <button v-if="['idle', 'done', 'error'].includes(state)" type="button" class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm text-white" @click="start">{{ state === 'idle' ? '开始录音' : '重新录音' }}</button>
        <button v-if="state === 'recording'" type="button" class="rounded-xl bg-rose-600 px-4 py-2 text-sm text-white" @click="finish">停止并识别</button>
        <button type="button" class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-40" :disabled="!text.trim() || !['done', 'error'].includes(state)" @click="confirm">{{ props.testMode ? '完成测试' : '填入输入框' }}</button>
      </footer>
    </section>
  </div>
</template>
