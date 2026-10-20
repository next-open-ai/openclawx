<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { DEFAULT_EMBEDDING_META, suggestedSpeechVoices } from '@openclawx/contracts';
import { useI18n } from '../../app/i18n';
import {
  imageGenerationProtocols,
  classifyCapabilityFailure,
  effectiveProviderBaseUrl,
  inferImageGenerationProtocol,
  modelCapabilities,
  modelLikelySupportsCapability,
  modelHealthIsStale,
  providerCanBuiltinWebSearch,
  providerInstanceReady,
  providerSuggestedByCapability,
  providerSupportsOpenAiModelList,
  uniqueModels,
  type ConfiguredModel,
  type ImageGenerationProtocol,
  type CapabilityBinding,
  type ModelCapability,
  type ProviderInstance,
} from '../../app/model-config';
import { listProviderModels, testEmbeddingConnection } from '../../services/api.js';
import { useNotify } from '../../app/notify';
import ModelTestDialog from './ModelTestDialog.vue';

const props = defineProps<{
  instances: ProviderInstance[];
  models: ConfiguredModel[];
  activeChatModelId: string | null;
  activeEmbeddingModelId: string | null;
  capabilityBindings: CapabilityBinding[];
}>();

const emit = defineEmits<{
  'update:models': [value: ConfiguredModel[]];
  'update:activeChatModelId': [value: string | null];
  'update:activeEmbeddingModelId': [value: string | null];
  'update:capabilityBindings': [value: CapabilityBinding[]];
  'configure-provider': [providerId: string];
  'test-realtime': [];
  dirty: [];
}>();

const { t } = useI18n();
const notify = useNotify();

const draftProviderId = ref('');
const draftCapability = ref<ModelCapability>('chat');
const draftModelId = ref('');
const draftImageProtocol = ref<ImageGenerationProtocol | ''>('');
const pickerOpen = ref(false);
const remoteModels = ref<string[]>([]);
const remoteLoading = ref(false);
const remoteError = ref('');
const search = ref('');
const showAllRemoteModels = ref(false);
const testingEmbeddingId = ref('');
const embeddingTestMessage = ref<Record<string, { ok: boolean; text: string }>>({});
const testingModel = ref<ConfiguredModel | null>(null);
const realtimeConfigModel = ref<ConfiguredModel | null>(null);
const realtimeVoiceDraft = ref('');
const volcengineRealtimeVoices = [
  { id: 'zh_female_vv_jupiter_bigtts', name: 'VV 女声', detail: '自然亲和，适合通用助手', tone: '自然' },
  { id: 'zh_female_xiaohe_jupiter_bigtts', name: '小荷女声', detail: '清晰年轻，适合客服与陪伴', tone: '清晰' },
  { id: 'zh_male_yunzhou_jupiter_bigtts', name: '云舟男声', detail: '沉稳自然，适合专业工作场景', tone: '沉稳' },
  { id: 'zh_male_xiaotian_jupiter_bigtts', name: '小天男声', detail: '明快有活力，适合轻松交流', tone: '活力' },
  { id: 'saturn_zh_female_aojiaonvyou_tob', name: '傲娇女友', detail: '情感表现丰富，使用前需确认已开通', tone: '情感' },
];
const qwenRealtimeVoices = [
  { id: 'longanqian_v3.1', name: '龙安浅 3.1', detail: '自然均衡，适合通用语音助手', tone: '自然' },
  { id: 'longanhuan_v3.1', name: '龙安欢 3.1', detail: '明快亲和，适合轻松交流', tone: '亲和' },
  { id: 'longanlingxin_v3.1', name: '龙安聆心 3.1', detail: '细腻温和，适合陪伴与服务场景', tone: '温和' },
  { id: 'longanfengyue_v3.1', name: '龙安风悦 3.1', detail: '清晰有表现力，适合内容讲解', tone: '清晰' },
  { id: 'xunanchuan_v3.1', name: '巡南川 3.1', detail: '沉稳专业，适合工作与知识问答', tone: '沉稳' },
];
const qwenOmniRealtimeVoices = [
  { id: 'Tina', name: '甜甜 Tina', detail: '温暖自然，适合多语言实时助手', tone: '温暖' },
];

function openRealtimeConfig(model: ConfiguredModel) {
  realtimeConfigModel.value = model;
  realtimeVoiceDraft.value = model.voice || suggestedSpeechVoices(instanceById.value[model.providerInstanceId]?.type ?? '', model.modelId)[0] || '';
}

function openDefaultRealtimeConfig() {
  const boundId = boundModelId('realtime');
  const model = visibleModels.value.find((item) => item.capability === 'realtime' && item.id === boundId)
    ?? visibleModels.value.find((item) => item.capability === 'realtime');
  if (model) openRealtimeConfig(model);
}

defineExpose({ openDefaultRealtimeConfig });

function saveRealtimeConfig() {
  const model = realtimeConfigModel.value;
  if (!model) return;
  patchModel(model.id, { voice: realtimeVoiceDraft.value.trim() || undefined });
  realtimeConfigModel.value = null;
}

function testRealtimeFromConfig() {
  realtimeConfigModel.value = null;
  emit('test-realtime');
}

function realtimeVoiceName(voice?: string) {
  if (!voice) return '尚未选择';
  return [...volcengineRealtimeVoices, ...qwenRealtimeVoices, ...qwenOmniRealtimeVoices].find((item) => item.id === voice)?.name || voice;
}
function boundModelId(capability: ModelCapability) {
  return props.capabilityBindings.find((item) => item.capability === capability && item.enabled)?.modelId ?? null;
}

const instanceById = computed(() => Object.fromEntries(props.instances.map((item) => [item.id, item])));
const realtimeConfigProvider = computed(() => realtimeConfigModel.value ? instanceById.value[realtimeConfigModel.value.providerInstanceId] : undefined);
const realtimeVoices = computed(() => {
  if (realtimeConfigProvider.value?.type !== 'qwen') return volcengineRealtimeVoices;
  return /omni/i.test(realtimeConfigModel.value?.modelId || '') ? qwenOmniRealtimeVoices : qwenRealtimeVoices;
});
const realtimeProviderLabel = computed(() => realtimeConfigProvider.value?.type === 'qwen' ? '通义千问实时语音' : '火山实时语音');
const realtimeProtocolSummary = computed(() => realtimeConfigProvider.value?.type === 'qwen'
  ? '支持实时双向语音与 Function Calling；联网搜索由 OpenClawX Tool 提供，避免与工具调用冲突。'
  : '支持实时双向语音与 Function Calling；通话参数由火山 SeedDuplex 协议适配。');
const realtimeMeteringSummary = computed(() => realtimeConfigProvider.value?.type === 'qwen'
  ? '计量：优先显示阿里结算帧返回的 Token/字符，同时保留本地音频时长。'
  : '计量：上游返回用量时显示真实计量；否则显示输入/输出音频时长，不推算账单金额。');
const readyInstances = computed(() => props.instances.filter((item) => providerInstanceReady(item)));
const visibleModels = computed(() =>
  props.models.filter((item) => {
    const instance = instanceById.value[item.providerInstanceId];
    return Boolean(instance && providerInstanceReady(instance));
  }),
);

const draftInstance = computed(() => readyInstances.value.find((item) => item.id === draftProviderId.value) ?? null);
const draftCapabilities = computed<ModelCapability[]>(() => {
  const type = draftInstance.value?.type;
  if (type === 'volcengine') return draftInstance.value?.service === 'realtime' ? ['realtime'] : draftInstance.value?.service === 'speech' ? ['asr', 'tts'] : ['chat'];
  return type === 'iflytek' ? ['asr', 'tts'] : modelCapabilities;
});

const recommendedModels = computed(() => {
  const instance = draftInstance.value;
  if (!instance) return [] as string[];
  const catalog = providerSuggestedByCapability[instance.type]?.[draftCapability.value] ?? [];
  const q = search.value.trim().toLowerCase();
  return uniqueModels(catalog).filter((item) => !q || item.toLowerCase().includes(q));
});
const catalogModels = computed(() => {
  const recommended = new Set(providerSuggestedByCapability[draftInstance.value?.type ?? 'openai-compatible']?.[draftCapability.value] ?? []);
  const q = search.value.trim().toLowerCase();
  return uniqueModels(remoteModels.value)
    .filter((item) => !recommended.has(item))
    .filter((item) => showAllRemoteModels.value || modelLikelySupportsCapability(item, draftCapability.value))
    .filter((item) => !q || item.toLowerCase().includes(q));
});

watch(
  () => readyInstances.value.map((item) => item.id).join(','),
  () => {
    if (!draftProviderId.value || !readyInstances.value.some((item) => item.id === draftProviderId.value)) {
      draftProviderId.value = readyInstances.value[0]?.id ?? '';
    }
  },
  { immediate: true },
);

watch(draftProviderId, () => {
  if (!draftCapabilities.value.includes(draftCapability.value)) draftCapability.value = draftCapabilities.value[0] ?? 'chat';
  draftImageProtocol.value = '';
  showAllRemoteModels.value = false;
});
watch(draftCapability, () => { draftImageProtocol.value = ''; showAllRemoteModels.value = false; });

function emitModels(
  next: ConfiguredModel[],
  activeChatId = props.activeChatModelId,
  activeEmbeddingId = props.activeEmbeddingModelId,
) {
  emit('update:models', next);
  emit('update:activeChatModelId', activeChatId);
  emit('update:activeEmbeddingModelId', activeEmbeddingId);
  emit('dirty');
}

function capabilityLabel(capability: ModelCapability) {
  return t(`settings.capability.${capability}`);
}

function imageProtocolLabel(protocol: ImageGenerationProtocol) {
  return t(`settings.imageProtocol.${protocol}`);
}

function addModel(modelId: string, makeDefault = true) {
  const trimmed = modelId.trim();
  const instance = draftInstance.value;
  if (!trimmed || !instance) return;
  const exists = props.models.some(
    (item) => item.providerInstanceId === instance.id && item.capability === draftCapability.value && item.modelId === trimmed,
  );
  if (exists) {
    pickerOpen.value = false;
    return;
  }
  const entry: ConfiguredModel = {
    id: crypto.randomUUID(),
    providerInstanceId: instance.id,
    capability: draftCapability.value,
    modelId: trimmed,
    meta: draftCapability.value === 'embedding' ? { ...DEFAULT_EMBEDDING_META } : undefined,
    imageProtocol: draftCapability.value === 'image' && draftImageProtocol.value ? draftImageProtocol.value : undefined,
    decisionProtocol: draftCapability.value === 'decision' ? 'system-one-v1' : undefined,
    supportsBuiltinWebSearch: draftCapability.value === 'chat' && instance.type === 'qwen' ? true : undefined,
  };
  const next = [...props.models, entry];
  let activeChatId = props.activeChatModelId;
  let activeEmbeddingId = props.activeEmbeddingModelId;
  if (draftCapability.value === 'chat' && (makeDefault || !props.activeChatModelId)) activeChatId = entry.id;
  if (draftCapability.value === 'embedding' && (makeDefault || !props.activeEmbeddingModelId)) activeEmbeddingId = entry.id;
  emitModels(next, activeChatId, activeEmbeddingId);
  draftModelId.value = '';
  pickerOpen.value = false;
}

function removeModel(id: string) {
  const next = props.models.filter((item) => item.id !== id);
  const activeChatId = props.activeChatModelId === id ? next.find((item) => item.capability === 'chat')?.id ?? null : props.activeChatModelId;
  const activeEmbeddingId = props.activeEmbeddingModelId === id
    ? next.find((item) => item.capability === 'embedding')?.id ?? null
    : props.activeEmbeddingModelId;
  emitModels(next, activeChatId, activeEmbeddingId);
  if (props.capabilityBindings.some((item) => item.modelId === id)) {
    emit('update:capabilityBindings', props.capabilityBindings.filter((item) => item.modelId !== id));
  }
}

function patchModel(id: string, patchValue: Partial<ConfiguredModel>) {
  emitModels(props.models.map((item) => (item.id === id ? { ...item, health: undefined, ...patchValue } : item)));
}

function patchEmbeddingMeta(
  model: ConfiguredModel,
  key: 'dimension' | 'maxBatch' | 'maxInputChars' | 'normalize',
  rawValue: string | boolean,
) {
  const prev = model.meta ?? {};
  const next = { ...prev };
  if (key === 'normalize') {
    next.normalize = Boolean(rawValue);
  } else {
    const num = Math.max(0, Math.round(Number(rawValue) || 0));
    if (num > 0) (next as Record<string, number>)[key] = num;
    else delete (next as Record<string, number | boolean | undefined>)[key];
  }
  patchModel(model.id, { meta: Object.keys(next).length ? next : undefined });
}

function setDefaultChat(id: string) {
  emit('update:activeChatModelId', id);
  emit('dirty');
}

function setDefaultEmbedding(id: string) {
  emit('update:activeEmbeddingModelId', id);
  const next = props.capabilityBindings.filter((item) => item.capability !== 'embedding');
  next.push({ capability: 'embedding', modelId: id, enabled: true, updatedAt: new Date().toISOString() });
  emit('update:capabilityBindings', next);
  emit('dirty');
}

function setDefaultCapability(capability: ModelCapability, id: string) {
  const next = props.capabilityBindings.filter((item) => item.capability !== capability);
  next.push({ capability, modelId: id, enabled: true, updatedAt: new Date().toISOString() });
  emit('update:capabilityBindings', next);
  emit('dirty');
}

function toggleBuiltinWebSearch(model: ConfiguredModel, enabled: boolean) {
  const instance = instanceById.value[model.providerInstanceId];
  if (!instance || !providerCanBuiltinWebSearch(instance.type) || model.capability !== 'chat') return;
  emitModels(
    props.models.map((item) =>
      item.id === model.id
        ? { ...item, supportsBuiltinWebSearch: enabled || undefined }
        : item,
    ),
  );
}

function toggleVision(model: ConfiguredModel, enabled: boolean) {
  emitModels(props.models.map((item) => item.id === model.id ? { ...item, supportsVision: enabled } : item));
}

function modelSupportsBuiltinToggle(model: ConfiguredModel) {
  const instance = instanceById.value[model.providerInstanceId];
  return model.capability === 'chat' && Boolean(instance && providerCanBuiltinWebSearch(instance.type));
}

async function testEmbeddingModel(model: ConfiguredModel) {
  const instance = instanceById.value[model.providerInstanceId];
  if (!instance) return;
  testingEmbeddingId.value = model.id;
  embeddingTestMessage.value = { ...embeddingTestMessage.value, [model.id]: { ok: false, text: t('settings.providerTesting') } };
  try {
    const result = await testEmbeddingConnection({
      type: instance.type,
      baseUrl: effectiveProviderBaseUrl(instance),
      apiKey: instance.apiKey,
      model: model.modelId,
    });
    const dimension = Number(result.detail.dimension) || model.meta?.dimension || 0;
    const nextMeta = {
      ...(model.meta ?? {}),
      ...(dimension > 0 ? { dimension } : {}),
    };
    patchModel(model.id, {
      meta: Object.keys(nextMeta).length ? nextMeta : undefined,
      health: { status: 'available', checkedAt: new Date().toISOString(), summary: `${result.message} [${result.status}]` },
    });
    embeddingTestMessage.value = {
      ...embeddingTestMessage.value,
      [model.id]: { ok: true, text: `${result.message} [${result.status}]` },
    };
    notify.success('notify.providerTestOk', result.message);
  } catch (cause) {
    const text = notify.errorMessage(cause);
    patchModel(model.id, { health: { status: classifyCapabilityFailure(text), checkedAt: new Date().toISOString(), summary: text.slice(0, 500) } });
    embeddingTestMessage.value = { ...embeddingTestMessage.value, [model.id]: { ok: false, text } };
    notify.error(cause, 'notify.providerTestFailed');
  } finally {
    testingEmbeddingId.value = '';
  }
}

function eventChecked(event: Event): boolean {
  return Boolean((event.target as HTMLInputElement | null)?.checked);
}

function eventInputValue(event: Event): string {
  return String((event.target as HTMLInputElement | null)?.value ?? '');
}

function patchImageProtocol(model: ConfiguredModel, event: Event) {
  const value = eventInputValue(event) as ImageGenerationProtocol | '';
  if (!value || imageGenerationProtocols.includes(value)) patchModel(model.id, { imageProtocol: value || undefined });
}

function qwenImageWorkspaceMissing(model: ConfiguredModel) {
  if (model.capability !== 'image' || !/^qwen-image-3(?:\.|-|$)/i.test(model.modelId)) return false;
  const instance = instanceById.value[model.providerInstanceId];
  if (!instance || instance.type !== 'qwen' || instance.workspaceId?.trim()) return false;
  try { return new URL(instance.baseUrl).hostname.includes('dashscope'); } catch { return false; }
}

async function fetchRemoteModels() {
  const instance = draftInstance.value;
  if (!instance) return;
  remoteLoading.value = true;
  remoteError.value = '';
  try {
    remoteModels.value = await listProviderModels({
      type: instance.type,
      baseUrl: effectiveProviderBaseUrl(instance, draftCapability.value),
      workspaceId: undefined,
      apiKey: instance.apiKey,
    });
  } catch (cause) {
    remoteModels.value = [];
    remoteError.value = cause instanceof Error ? cause.message : '拉取失败';
  } finally {
    remoteLoading.value = false;
  }
}

async function openPicker() {
  pickerOpen.value = true;
  search.value = '';
  remoteError.value = '';
  remoteModels.value = [];
  showAllRemoteModels.value = false;
  if (draftInstance.value && providerSupportsOpenAiModelList(draftInstance.value.type)) {
    await fetchRemoteModels();
  }
}

function modelRowLabel(model: ConfiguredModel) {
  const instance = instanceById.value[model.providerInstanceId];
  return `${instance?.name ?? '未知连接'} · ${model.modelId}`;
}

function modelHealthLabel(model: ConfiguredModel) {
  if (modelHealthIsStale(model)) return t('settings.modelHealth.stale');
  return t(`settings.modelHealth.${model.health?.status ?? 'unverified'}`);
}

function modelHealthClass(model: ConfiguredModel) {
  if (modelHealthIsStale(model)) return 'text-amber-600';
  if (model.health?.status === 'available') return 'text-emerald-600';
  if (model.health?.status === 'temporarily_unavailable') return 'text-amber-600';
  if (model.health) return 'text-rose-600';
  return 'text-[var(--muted)]';
}

function modelHealthHelp(model: ConfiguredModel) {
  if (modelHealthIsStale(model)) return t('settings.modelHealthHelp.stale');
  if (model.health?.status === 'configuration_error') return t('settings.modelHealthHelp.configuration_error');
  if (model.health?.status === 'permission_error') return t('settings.modelHealthHelp.permission_error');
  if (model.health?.status === 'temporarily_unavailable') return t('settings.modelHealthHelp.temporarily_unavailable');
  return '';
}

function clearModelHealth(model: ConfiguredModel) {
  patchModel(model.id, { health: undefined });
}

function recordModelTest(model: ConfiguredModel, result: { ok: boolean; summary: string }) {
  patchModel(model.id, { health: { status: result.ok ? 'available' : classifyCapabilityFailure(result.summary), checkedAt: new Date().toISOString(), summary: result.summary.slice(0, 500) } });
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p class="text-xs leading-relaxed text-[var(--muted)]">{{ t('settings.configuredModelsHelp') }}</p>
      </div>
      <button
        class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:border-[var(--accent)] disabled:opacity-40"
        type="button"
        :disabled="!readyInstances.length"
        @click="openPicker"
      >
        {{ t('settings.modelAdd') }}
      </button>
    </div>

    <p v-if="!readyInstances.length" class="rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-xs text-[var(--muted)]">
      {{ t('settings.modelsNeedProvider') }}
    </p>

    <div v-else-if="visibleModels.length" class="overflow-hidden rounded-xl border border-[var(--border)]">
      <div class="grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 bg-[var(--surface-muted)]/50 px-3 py-2 text-[10px] font-bold uppercase tracking-[.06em] text-[var(--muted)]">
        <span>{{ t('settings.modelColumn') }}</span>
        <span>{{ t('settings.modelTypeColumn') }}</span>
        <span>{{ t('settings.builtinSearchColumn') }}</span>
        <span>{{ t('settings.systemDefaultColumn') }}</span>
        <span></span>
      </div>
      <div v-for="model in visibleModels" :key="model.id" class="border-t border-[var(--border)]">
        <div class="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-2 px-3 py-2.5">
          <div class="min-w-0">
            <p class="truncate text-sm font-medium">{{ modelRowLabel(model) }}</p>
            <p class="truncate text-[11px] text-[var(--muted)]">{{ instanceById[model.providerInstanceId]?.type }}</p>
            <p :class="['mt-0.5 truncate text-[10px] font-semibold', modelHealthClass(model)]" :title="model.health?.summary">
              {{ modelHealthLabel(model) }}<template v-if="model.health?.checkedAt"> · {{ new Date(model.health.checkedAt).toLocaleString() }}</template>
            </p>
            <p v-if="modelHealthHelp(model)" class="mt-0.5 max-w-xl text-[10px] leading-relaxed text-[var(--muted)]" :title="model.health?.summary">{{ modelHealthHelp(model) }}</p>
            <button v-if="model.health" class="mt-1 text-[10px] font-semibold text-[var(--accent)] hover:underline" type="button" @click="clearModelHealth(model)">{{ t('settings.modelHealthClear') }}</button>
            <label v-if="model.capability === 'chat'" class="mt-1 flex items-center gap-1.5 text-xs text-[var(--muted)]" title="仅当此模型确实支持图片输入时开启；当前仅支持 Pi 单员工对话，不会替换主模型。">
              <input type="checkbox" :checked="Boolean(model.supportsVision)" @change="toggleVision(model, eventChecked($event))" />支持图片理解
            </label>
          </div>
          <span class="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] font-bold text-[var(--muted)]">{{ capabilityLabel(model.capability) }}</span>
          <label v-if="modelSupportsBuiltinToggle(model)" class="flex cursor-pointer items-center gap-1.5 text-xs" :title="t('settings.builtinSearchHelp')">
            <input
              :checked="Boolean(model.supportsBuiltinWebSearch)"
              type="checkbox"
              @change="toggleBuiltinWebSearch(model, eventChecked($event))"
            />
            <span class="text-[var(--muted)]">{{ t('settings.builtinSearch') }}</span>
          </label>
          <span v-else class="text-[11px] text-[var(--muted)]">—</span>
          <label v-if="model.capability === 'chat'" class="flex cursor-pointer items-center gap-1.5 text-xs">
            <input :checked="activeChatModelId === model.id" name="default-chat-model" type="radio" @change="setDefaultChat(model.id)" />
            <span class="text-[var(--muted)]">{{ t('settings.activeChatModel') }}</span>
          </label>
          <label v-else-if="model.capability === 'embedding'" class="flex cursor-pointer items-center gap-1.5 text-xs">
            <input :checked="activeEmbeddingModelId === model.id" name="default-embedding-model" type="radio" @change="setDefaultEmbedding(model.id)" />
            <span class="text-[var(--muted)]">{{ t('settings.activeEmbeddingModel') }}</span>
          </label>
          <label v-else class="flex cursor-pointer items-center gap-1.5 text-xs">
            <input :checked="boundModelId(model.capability) === model.id" :name="`default-${model.capability}-model`" type="radio" @change="setDefaultCapability(model.capability, model.id)" />
            <span class="text-[var(--muted)]">{{ capabilityLabel(model.capability) }}</span>
          </label>
          <div class="flex items-center gap-1">
            <button v-if="model.capability === 'realtime'" class="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-2.5 py-1.5 text-xs font-semibold text-[var(--accent)] hover:border-[var(--accent)]" type="button" @click="openRealtimeConfig(model)">配置实时语音</button>
            <button class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]" type="button" @click="model.capability === 'realtime' ? emit('test-realtime') : testingModel = model">测试</button>
            <button class="rounded-md px-2 py-1 text-lg leading-none text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-rose-600" type="button" @click="removeModel(model.id)">×</button>
          </div>
        </div>
        <p v-if="model.capability === 'vision'" class="border-t border-dashed border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)]">用于主模型不能看图时的定向识别；请选择确实支持图片输入的模型，设为默认后在员工应用模型能力中开启“图片理解”。不会替换主模型。</p>
        <p v-else-if="model.capability === 'decision'" class="border-t border-dashed border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)]">有限问题决策模型，不进入聊天主模型选择器。设为默认后，可在“决策守卫”中选择并用于 Tool 执行前安检和主模型按需判断。</p>
        <p v-else-if="model.capability === 'ontology'" class="border-t border-dashed border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)]">仅在本体名称与别名规则未命中时，对受限候选进行语义消歧；超时、不可用或低置信度时自动退回普通检索。</p>
        <div v-if="model.capability === 'embedding'" class="grid gap-3 border-t border-dashed border-[var(--border)] bg-[var(--surface)]/50 px-3 py-3 sm:grid-cols-3">
          <label class="grid gap-1 text-[11px] font-semibold text-[var(--muted)]">
            <span>Dimension</span>
            <input
              class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-xs font-normal"
              type="number"
              min="1"
              :value="model.meta?.dimension ?? DEFAULT_EMBEDDING_META.dimension"
              @input="patchEmbeddingMeta(model, 'dimension', eventInputValue($event))"
            />
          </label>
          <label class="grid gap-1 text-[11px] font-semibold text-[var(--muted)]">
            <span>Max Batch</span>
            <input
              class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-xs font-normal"
              type="number"
              min="1"
              :value="model.meta?.maxBatch ?? DEFAULT_EMBEDDING_META.maxBatch"
              @input="patchEmbeddingMeta(model, 'maxBatch', eventInputValue($event))"
            />
          </label>
          <label class="grid gap-1 text-[11px] font-semibold text-[var(--muted)]">
            <span>Max Input Chars</span>
            <input
              class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-xs font-normal"
              type="number"
              min="1"
              :value="model.meta?.maxInputChars ?? DEFAULT_EMBEDDING_META.maxInputChars"
              @input="patchEmbeddingMeta(model, 'maxInputChars', eventInputValue($event))"
            />
          </label>
          <label
            class="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-[var(--border)]/70 bg-[var(--surface-muted)]/45 px-3 py-2 text-[11px] text-[var(--muted)] sm:col-span-3"
            title="将向量转换为单位长度，使余弦相似度和点积检索结果更稳定。知识库语义检索通常建议开启。"
          >
            <input
              type="checkbox"
              :checked="model.meta?.normalize ?? DEFAULT_EMBEDDING_META.normalize"
              @change="patchEmbeddingMeta(model, 'normalize', eventChecked($event))"
            />
            <span class="font-semibold text-[var(--text)]">向量归一化</span>
            <span class="grid h-4 w-4 place-items-center rounded-full border border-[var(--border)] text-[10px] font-bold text-[var(--muted)]" aria-label="向量归一化说明">?</span>
            <span class="min-w-[260px] flex-1 leading-relaxed">将向量转换为单位长度，使余弦相似度和点积检索更稳定，知识库语义检索通常建议开启。</span>
          </label>
          <div class="sm:col-span-3 flex flex-wrap items-center gap-3">
            <button
              class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:border-[var(--accent)] disabled:opacity-50"
              type="button"
              :disabled="testingEmbeddingId === model.id"
              @click="testEmbeddingModel(model)"
            >
              {{ testingEmbeddingId === model.id ? 'Testing…' : '测试 Embedding' }}
            </button>
            <p v-if="embeddingTestMessage[model.id]" :class="['text-xs', embeddingTestMessage[model.id].ok ? 'text-emerald-600' : 'text-rose-600']">
              {{ embeddingTestMessage[model.id].text }}
            </p>
          </div>
        </div>
        <div v-else-if="model.capability === 'image'" class="space-y-2 border-t border-dashed border-[var(--border)] bg-[var(--surface)]/50 px-3 py-3">
          <div v-if="qwenImageWorkspaceMissing(model)" class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span>{{ t('settings.qwenImageWorkspaceRequired') }}</span>
            <button class="rounded-md border border-amber-400 bg-white px-2.5 py-1.5 font-semibold" type="button" @click="emit('configure-provider', model.providerInstanceId)">
              {{ t('settings.configureProvider') }}
            </button>
          </div>
          <details>
            <summary class="cursor-pointer text-[11px] font-semibold text-[var(--muted)]">
              {{ t('settings.imageInvocationMode') }}：{{ model.imageProtocol ? imageProtocolLabel(model.imageProtocol) : t('settings.imageProtocolAuto') }}
            </summary>
            <label class="mt-2 grid gap-1.5 text-[11px] font-semibold text-[var(--muted)] sm:grid-cols-[minmax(0,1fr)_2fr] sm:items-center">
              <span>{{ t('settings.imageProtocol') }}</span>
              <select
                class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-xs"
                :value="model.imageProtocol ?? ''"
                @change="patchImageProtocol(model, $event)"
              >
                <option value="">{{ t('settings.imageProtocolAuto') }}</option>
                <option v-for="protocol in imageGenerationProtocols" :key="protocol" :value="protocol">{{ imageProtocolLabel(protocol) }}</option>
              </select>
            </label>
            <p class="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
              {{ t('settings.imageProtocolResolved') }}：{{ imageProtocolLabel(inferImageGenerationProtocol(instanceById[model.providerInstanceId]?.type ?? 'openai-compatible', model.modelId)) }}。{{ t('settings.imageProtocolAdvancedHelp') }}
            </p>
          </details>
        </div>
        <div v-else-if="model.capability === 'realtime'" class="flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-[var(--border)] bg-[var(--surface)]/50 px-3 py-2.5 text-[11px]">
          <span class="text-[var(--muted)]">当前音色 <strong class="ml-1 text-[var(--text)]">{{ realtimeVoiceName(model.voice) }}</strong></span>
          <button class="font-semibold text-[var(--accent)] hover:underline" type="button" @click="openRealtimeConfig(model)">更换音色与配置</button>
        </div>
        <div v-else-if="model.capability === 'tts'" class="border-t border-dashed border-[var(--border)] bg-[var(--surface)]/50 px-3 py-3">
          <label class="grid gap-1.5 text-[11px] font-semibold text-[var(--muted)] sm:grid-cols-[minmax(0,1fr)_2fr] sm:items-center">
            <span>{{ t('settings.defaultVoice') }}</span>
            <input
              class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-xs font-normal"
              :placeholder="suggestedSpeechVoices(instanceById[model.providerInstanceId]?.type ?? '', model.modelId)[0] || t('settings.defaultVoicePlaceholder')"
              :list="`speech-voices-${model.id}`"
              :value="model.voice ?? ''"
              @input="patchModel(model.id, { voice: eventInputValue($event).trim() || undefined })"
            />
          </label>
          <datalist :id="`speech-voices-${model.id}`">
            <option v-for="voice in suggestedSpeechVoices(instanceById[model.providerInstanceId]?.type ?? '', model.modelId)" :key="voice" :value="voice" />
          </datalist>
          <p class="mt-1.5 text-[11px] leading-relaxed text-[var(--muted)]">{{ t('settings.defaultVoiceHelp') }}</p>
        </div>
      </div>
    </div>
    <p v-if="visibleModels.length && !activeEmbeddingModelId" class="mt-2 text-[11px] text-[var(--muted)]">
      {{ t('settings.activeEmbeddingModelHint') }}
    </p>
    <p v-if="!visibleModels.length" class="text-xs text-[var(--muted)]">{{ t('settings.configuredModelsEmpty') }}</p>

    <div v-if="realtimeConfigModel" class="fixed inset-0 z-[60] grid place-items-center bg-slate-950/45 p-4" @click.self="realtimeConfigModel = null">
      <article class="flex max-h-[min(88vh,760px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="realtime-config-title">
        <header class="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h3 id="realtime-config-title" class="text-lg font-bold">配置实时语音</h3>
            <p class="mt-1 text-xs leading-relaxed text-[var(--muted)]">{{ instanceById[realtimeConfigModel.providerInstanceId]?.name }} · {{ realtimeConfigModel.modelId }}</p>
          </div>
          <button class="grid h-8 w-8 place-items-center rounded-lg text-lg text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" aria-label="关闭" @click="realtimeConfigModel = null">×</button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div class="flex items-start justify-between gap-3 rounded-xl border border-[var(--accent)]/20 bg-[var(--accent-soft)]/45 px-4 py-3">
            <div><strong class="text-sm">选择默认音色</strong><p class="mt-1 text-xs text-[var(--muted)]">已筛选常用中文音色，保存后用于新建的实时语音会话。</p></div>
            <span class="shrink-0 rounded-lg bg-[var(--surface)] px-2 py-1 text-[10px] font-semibold text-[var(--accent)]">{{ realtimeProviderLabel }}</span>
          </div>
          <p class="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">{{ realtimeProtocolSummary }}</p>
          <p class="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">{{ realtimeMeteringSummary }}</p>
          <p v-if="realtimeConfigProvider?.type === 'qwen' && /omni/i.test(realtimeConfigModel.modelId) && !realtimeConfigProvider.workspaceId?.trim()" class="mt-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            当前 Omni Realtime 建议在 Provider 高级设置中填写百炼业务空间 ID；Qwen Audio Realtime 可继续使用共享地址。
          </p>
          <div class="mt-4 grid gap-2 sm:grid-cols-2">
            <button v-for="voice in realtimeVoices" :key="voice.id" type="button" :class="['rounded-xl border p-3 text-left transition active:scale-[.99]', realtimeVoiceDraft === voice.id ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm' : 'border-[var(--border)] hover:border-[var(--accent)]/45 hover:bg-[var(--surface-muted)]/55']" @click="realtimeVoiceDraft = voice.id">
              <span class="flex items-center justify-between gap-3"><strong class="text-sm">{{ voice.name }}</strong><span class="rounded-md bg-[var(--surface)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">{{ voice.tone }}</span></span>
              <span class="mt-1 block text-[11px] leading-relaxed text-[var(--muted)]">{{ voice.detail }}</span>
              <code class="mt-2 block truncate text-[10px] text-[var(--muted)]">{{ voice.id }}</code>
            </button>
          </div>
          <label class="mt-5 grid gap-1.5 text-xs font-semibold text-[var(--text)]">
            <span>自定义或克隆音色 ID</span>
            <input v-model="realtimeVoiceDraft" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-mono text-xs font-normal focus:border-[var(--accent)] focus:outline-none" placeholder="选择上方音色，或填写已开通的音色 ID" />
            <small class="font-normal leading-relaxed text-[var(--muted)]">自定义音色需要已在供应商控制台授权。选择不兼容的音色时，连接测试会返回明确错误。</small>
          </label>
        </div>
        <footer class="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-5 py-4">
          <button class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:border-[var(--accent)]" type="button" @click="testRealtimeFromConfig">进入通话测试</button>
          <div class="flex gap-2"><button class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold" type="button" @click="realtimeConfigModel = null">取消</button><button class="rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white disabled:opacity-45" type="button" :disabled="!realtimeVoiceDraft.trim()" @click="saveRealtimeConfig">应用配置</button></div>
        </footer>
      </article>
    </div>

    <div v-if="pickerOpen" class="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4" @click.self="pickerOpen = false">
      <article class="flex max-h-[min(85vh,680px)] w-full max-w-lg flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header class="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h3 class="text-lg font-bold">{{ t('settings.modelAddTitle') }}</h3>
            <p class="mt-1 text-xs text-[var(--muted)]">{{ t('settings.modelAddHelp') }}</p>
          </div>
          <button class="text-xl text-[var(--muted)]" type="button" @click="pickerOpen = false">×</button>
        </header>

        <div class="space-y-3 border-b border-[var(--border)] px-5 py-4">
          <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('settings.pickProvider') }}</span>
            <select v-model="draftProviderId" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm font-normal">
              <option v-for="instance in readyInstances" :key="instance.id" :value="instance.id">
                {{ instance.name }} · {{ t(`provider.${instance.type}`) }}
              </option>
            </select>
          </label>
          <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('settings.pickCapability') }}</span>
            <select v-model="draftCapability" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm font-normal">
              <option v-for="capability in draftCapabilities" :key="capability" :value="capability">{{ capabilityLabel(capability) }}</option>
            </select>
          </label>
          <details v-if="draftCapability === 'image'" class="text-xs text-[var(--muted)]">
            <summary class="cursor-pointer font-semibold">{{ t('settings.advancedConnection') }}</summary>
            <label class="mt-2 grid gap-1.5 font-semibold">
              <span>{{ t('settings.imageProtocol') }}</span>
              <select v-model="draftImageProtocol" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm font-normal">
                <option value="">{{ t('settings.imageProtocolAuto') }}</option>
                <option v-for="protocol in imageGenerationProtocols" :key="protocol" :value="protocol">{{ imageProtocolLabel(protocol) }}</option>
              </select>
              <span class="font-normal leading-relaxed">{{ t('settings.imageProtocolAdvancedHelp') }}</span>
            </label>
          </details>
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model="search"
              class="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              type="search"
              :placeholder="t('settings.chatModelSearch')"
            />
            <button
              v-if="draftInstance && providerSupportsOpenAiModelList(draftInstance.type)"
              class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:border-[var(--accent)] disabled:opacity-50"
              type="button"
              :disabled="remoteLoading"
              @click="fetchRemoteModels"
            >
              {{ remoteLoading ? t('settings.modelListLoading') : t('settings.modelListFetch') }}
            </button>
          </div>
          <p v-if="remoteError" class="text-xs text-rose-600">{{ remoteError }}</p>
        </div>

        <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-3">
          <section v-if="recommendedModels.length">
            <p class="mb-2 text-[11px] font-bold uppercase tracking-[.06em] text-[var(--muted)]">{{ t('settings.recommendedModels') }}</p>
            <ul class="space-y-1">
            <li v-for="name in recommendedModels" :key="`recommended:${name}`">
              <button
                class="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-[var(--surface-muted)]"
                type="button"
                @click="addModel(name, draftCapability === 'chat')"
              >
                <span class="truncate font-medium">{{ name }}</span>
                <span class="shrink-0 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] font-semibold text-[var(--accent)]">{{ t('settings.recommended') }}</span>
              </button>
            </li>
            </ul>
          </section>
          <section v-if="remoteModels.length">
            <div class="mb-2 flex items-center justify-between gap-3">
              <p class="text-[11px] font-bold uppercase tracking-[.06em] text-[var(--muted)]">{{ t('settings.providerModelCatalog') }}</p>
              <label class="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--muted)]">
                <input v-model="showAllRemoteModels" type="checkbox" />
                <span>{{ t('settings.showAllModels') }}</span>
              </label>
            </div>
            <p v-if="!showAllRemoteModels" class="mb-2 text-[11px] text-[var(--muted)]">{{ t('settings.catalogFilteredHelp') }}</p>
            <ul v-if="catalogModels.length" class="space-y-1">
              <li v-for="name in catalogModels" :key="`catalog:${name}`">
                <button class="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-[var(--surface-muted)]" type="button" @click="addModel(name, draftCapability === 'chat')">
                  <span class="truncate font-medium">{{ name }}</span>
                  <span class="shrink-0 text-[11px] text-[var(--accent)]">{{ t('settings.chatModelAdd') }}</span>
                </button>
              </li>
            </ul>
            <p v-else class="py-4 text-center text-xs text-[var(--muted)]">{{ t('settings.filteredCatalogEmpty') }}</p>
          </section>
          <p v-if="!recommendedModels.length && !catalogModels.length" class="py-6 text-center text-xs text-[var(--muted)]">{{ t('settings.chatModelSearchEmpty') }}</p>
        </div>

        <footer class="border-t border-[var(--border)] px-5 py-4">
          <p class="mb-2 text-xs font-semibold text-[var(--muted)]">{{ t('settings.chatModelManual') }}</p>
          <div class="flex gap-2">
            <input
              v-model="draftModelId"
              class="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              type="text"
              :placeholder="t('settings.chatModelCustomPlaceholder')"
              @keydown.enter.prevent="addModel(draftModelId, draftCapability === 'chat')"
            />
            <button class="shrink-0 rounded-lg bg-[var(--text)] px-3 py-2 text-xs font-semibold text-[var(--surface)]" type="button" @click="addModel(draftModelId, draftCapability === 'chat')">
              {{ t('settings.chatModelAdd') }}
            </button>
          </div>
        </footer>
      </article>
    </div>
  </div>
  <ModelTestDialog v-if="testingModel && instanceById[testingModel.providerInstanceId]" :model="testingModel" :instance="instanceById[testingModel.providerInstanceId]" @close="testingModel = null" @tested="recordModelTest(testingModel!, $event)" />
</template>
