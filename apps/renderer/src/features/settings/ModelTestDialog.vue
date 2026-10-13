<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { ConfiguredModel, ProviderInstance } from '../../app/model-config';
import { effectiveProviderBaseUrl } from '../../app/model-config';
import { testConfiguredModelCapability } from '../../services/api';

const props = defineProps<{ model: ConfiguredModel; instance: ProviderInstance }>();
const emit = defineEmits<{ close: []; tested: [result: { ok: boolean; summary: string }] }>();
const running = ref(false);
const result = ref<{ ok: boolean; title: string; detail: string; latencyMs: number } | null>(null);
const prompt = ref(({ image: '一只放在木桌上的青花瓷杯，柔和自然光，专业产品摄影，画面简洁', video: '一只橘猫在阳光下的草地上缓慢奔跑，镜头平稳跟随', tts: '你好，这是 Workmate 语音模型测试。', embedding: 'Workmate 模型测试', 'quantum-code': '请给出一个创建 Bell 态的最小 Qiskit 示例。', decision: '这是一次低风险的连接测试，是否允许继续？', ontology: '问题“钱一直没退回来”是否与候选实体“退款未到账”语义一致？请简短回答。', chat: '请用一句话介绍你自己。', vision: '请描述上传图片的主要内容。', asr: '请上传一段音频进行转写测试。' } as Record<string, string>)[props.model.capability]);
const media = ref<{ mimeType: string; base64: string } | null>(null);
const sample = ref<{ name: string; dataUrl: string; base64: string; extension: string } | null>(null);
const progress = ref(0);
const elapsedSeconds = ref(0);
let progressTimer: ReturnType<typeof setInterval> | null = null;

const capabilityName = computed(() => ({ chat: '对话', vision: '图片理解', image: '图片生成', video: '视频生成', embedding: 'Embedding', asr: '语音识别', tts: '语音合成', 'quantum-code': '量子代码', decision: '决策判断', ontology: '本体语义匹配' } as Record<string, string>)[props.model.capability] || props.model.capability);
const testDescription = computed(() => props.model.capability === 'embedding'
  ? '发送一段最小文本并验证返回向量及维度。'
  : props.model.capability === 'image'
    ? '使用下方测试需求真实生成一张 1024×1024 图片并在弹窗中预览；本次调用可能产生费用。'
    : props.model.capability === 'video'
      ? '使用下方测试需求提交真实视频生成任务，完成后在弹窗中预览；生成可能需要数分钟。'
    : props.model.capability === 'tts'
      ? '使用下方文本执行真实语音合成，并在弹窗中试听结果；本次调用可能产生费用。'
      : props.model.capability === 'decision'
        ? '发送一个有限判断问题，验证决策协议、鉴权和结构化结果。'
      : props.model.capability === 'quantum-code'
        ? '向量子代码模型发送测试任务，并展示真实返回内容。'
    : props.model.capability === 'vision'
      ? '上传一张测试图片，向模型发起真实图片理解请求并展示回答。'
      : props.model.capability === 'asr'
        ? '上传一段不超过 2 MB 的音频，执行真实语音转写并展示结果。'
        : '使用下方预设需求发起真实对话并展示模型回答。');
const progressStage = computed(() => {
  if (progress.value < 18) return '正在校验配置并连接模型…';
  if (progress.value < 48) return props.model.capability === 'image' ? '生成任务已提交，模型正在构图…' : props.model.capability === 'video' ? '视频任务已提交，正在排队生成…' : '请求已提交，等待模型响应…';
  if (progress.value < 78) return props.model.capability === 'image' ? '模型正在渲染图片，请稍候…' : props.model.capability === 'video' ? '模型正在生成视频，请耐心等待…' : '模型正在处理测试内容…';
  return '正在等待模型完成并整理结果…';
});

function stopProgress() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
}

function startProgress(startedAt: number) {
  stopProgress();
  progress.value = 8;
  elapsedSeconds.value = 0;
  progressTimer = setInterval(() => {
    elapsedSeconds.value = Math.floor((performance.now() - startedAt) / 1_000);
    const step = progress.value < 42 ? 2.8 : progress.value < 72 ? 1.25 : progress.value < 88 ? 0.45 : 0.12;
    progress.value = Math.min(92, progress.value + step);
  }, 500);
}

onBeforeUnmount(stopProgress);

function selectSample(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { result.value = { ok: false, title: '样本过大', detail: '请选择不超过 2 MB 的测试文件。', latencyMs: 0 }; return; }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || '');
    sample.value = { name: file.name, dataUrl, base64: dataUrl.split(',', 2)[1] || '', extension: file.name.split('.').pop() || (props.model.capability === 'asr' ? 'wav' : 'png') };
  };
  reader.readAsDataURL(file);
}

async function runTest() {
  running.value = true; result.value = null;
  const startedAt = performance.now();
  startProgress(startedAt);
  try {
    let detail = '';
    const tested = await testConfiguredModelCapability({ type: props.instance.type, baseUrl: effectiveProviderBaseUrl(props.instance, props.model.capability), workspaceId: undefined, apiKey: props.instance.apiKey, apiSecret: props.instance.apiSecret, appId: props.instance.appId, model: props.model.modelId, capability: props.model.capability, voice: props.model.voice, imageProtocol: props.model.imageProtocol, prompt: prompt.value, size: props.model.capability === 'video' ? '1920x1080' : '1024x1024', imageDataUrl: props.model.capability === 'vision' ? sample.value?.dataUrl : undefined, audioBase64: props.model.capability === 'asr' ? sample.value?.base64 : undefined, audioExtension: props.model.capability === 'asr' ? sample.value?.extension : undefined });
    media.value = tested.media || null;
    detail = props.model.capability === 'embedding' ? `真实向量请求成功，返回 ${Array.isArray(tested.result.vectors) ? tested.result.vectors.length : 1} 组向量。` : props.model.capability === 'image' ? '图片生成成功，结果如下。' : props.model.capability === 'video' ? '视频生成成功，结果如下。' : props.model.capability === 'tts' ? '语音合成成功，可直接试听。' : props.model.capability === 'asr' ? String(tested.result.text || '转写成功。').slice(0, 1200) : String(tested.result.content || '模型调用成功。').slice(0, 1200);
    const value = { ok: true, title: `${capabilityName.value}模型测试通过`, detail, latencyMs: Math.round(performance.now() - startedAt) };
    result.value = value; emit('tested', { ok: true, summary: detail });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    result.value = { ok: false, title: `${capabilityName.value}模型测试失败`, detail, latencyMs: Math.round(performance.now() - startedAt) };
    emit('tested', { ok: false, summary: detail });
  } finally {
    stopProgress();
    progress.value = 100;
    elapsedSeconds.value = Math.floor((performance.now() - startedAt) / 1_000);
    running.value = false;
  }
}
</script>

<template>
  <div class="fixed inset-0 z-[80] grid place-items-center overflow-hidden bg-slate-950/35 p-4 backdrop-blur-[2px]">
    <section class="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)] shadow-[0_28px_90px_rgba(15,23,42,.28)]" role="dialog" aria-modal="true" aria-labelledby="model-test-title" :aria-busy="running">
      <header class="flex shrink-0 items-start gap-3 border-b border-[var(--border)] px-5 py-4">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[var(--accent-soft)] text-xs font-black text-[var(--accent)]">TEST</span>
        <div class="min-w-0 flex-1"><h2 id="model-test-title" class="truncate text-base font-bold">测试 {{ model.modelId }}</h2><p class="mt-1 text-xs text-[var(--muted)]">{{ instance.name }} · {{ capabilityName }}</p></div>
        <button class="grid h-8 w-8 place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-35" type="button" aria-label="关闭" :disabled="running" :title="running ? '测试完成后可关闭' : '关闭'" @click="emit('close')">×</button>
      </header>
      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-5">
        <div class="rounded-2xl bg-[var(--surface-muted)] px-4 py-3 text-xs leading-relaxed text-[var(--muted)]">{{ testDescription }}</div>
        <dl class="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-xs"><dt class="text-[var(--muted)]">能力</dt><dd class="font-semibold">{{ capabilityName }}</dd><dt class="text-[var(--muted)]">模型 ID</dt><dd class="break-all font-mono">{{ model.modelId }}</dd><dt class="text-[var(--muted)]">服务地址</dt><dd class="truncate" :title="effectiveProviderBaseUrl(instance)">{{ effectiveProviderBaseUrl(instance) }}</dd></dl>
        <label class="grid gap-1.5 text-xs font-semibold"><span>测试需求</span><textarea v-model="prompt" class="min-h-24 resize-y rounded-2xl border border-[var(--border)] bg-[var(--background)] p-3 font-normal leading-relaxed outline-none focus:border-[var(--accent)]" /></label>
        <div v-if="running" class="rounded-2xl border border-[var(--accent)]/20 bg-[var(--accent-soft)]/55 p-4" aria-live="polite">
          <div class="mb-2 flex items-center justify-between gap-3 text-xs"><span class="font-semibold text-[var(--accent)]">{{ progressStage }}</span><span class="shrink-0 tabular-nums text-[var(--muted)]">{{ elapsedSeconds }} 秒 · {{ Math.round(progress) }}%</span></div>
          <div class="h-2.5 overflow-hidden rounded-full bg-white/75 shadow-inner" role="progressbar" aria-label="模型测试进度" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(progress)">
            <div class="relative h-full overflow-hidden rounded-full bg-gradient-to-r from-indigo-500 via-blue-500 to-cyan-400 shadow-[0_0_14px_rgba(79,70,229,.35)] transition-[width] duration-500 ease-out" :style="{ width: `${progress}%` }"><span class="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/45 to-transparent" /></div>
          </div>
          <p class="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">长任务可能需要一些时间，可以继续停留在此窗口等待结果。</p>
        </div>
        <label v-if="model.capability === 'vision' || model.capability === 'asr'" class="flex cursor-pointer items-center justify-between rounded-2xl border border-dashed border-[var(--border)] px-4 py-3 text-xs hover:border-[var(--accent)]"><span>{{ sample?.name || (model.capability === 'vision' ? '选择测试图片' : '选择测试音频') }}</span><span class="font-semibold text-[var(--accent)]">浏览…</span><input class="hidden" type="file" :accept="model.capability === 'vision' ? 'image/*' : 'audio/*'" @change="selectSample" /></label>
        <img v-if="model.capability === 'vision' && sample" class="max-h-40 w-full rounded-2xl object-contain" :src="sample.dataUrl" alt="视觉模型测试样本" />
        <img v-if="media?.mimeType.startsWith('image/')" class="max-h-[min(20rem,42dvh)] w-full rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] object-contain" :src="`data:${media.mimeType};base64,${media.base64}`" alt="模型测试生成结果" />
        <video v-else-if="media?.mimeType.startsWith('video/')" class="max-h-[min(20rem,42dvh)] w-full rounded-2xl border border-[var(--border)] bg-black object-contain" :src="`data:${media.mimeType};base64,${media.base64}`" controls />
        <audio v-else-if="media?.mimeType.startsWith('audio/')" class="w-full" :src="`data:${media.mimeType};base64,${media.base64}`" controls />
        <div v-if="result" :class="['rounded-2xl border p-4', result.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-rose-300 bg-rose-50 text-rose-900']" role="status">
          <div class="flex items-center justify-between gap-3"><strong class="text-sm">{{ result.title }}</strong><span class="text-[11px] tabular-nums">{{ result.latencyMs }} ms</span></div><p class="mt-2 text-xs leading-relaxed">{{ result.detail }}</p>
        </div>
      </div>
      <footer class="flex shrink-0 justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-5 py-4"><button class="rounded-xl border border-[var(--border)] px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40" type="button" :disabled="running" @click="emit('close')">{{ running ? '请等待测试完成' : '关闭' }}</button><button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50" type="button" :disabled="running" @click="runTest">{{ running ? '测试中…' : result ? '重新测试' : '开始测试' }}</button></footer>
    </section>
  </div>
</template>
