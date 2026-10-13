<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n, localeOptions, type Locale } from '../../app/i18n';
import ExperienceSettingsCard from './ExperienceSettingsCard.vue';
import { themeOptions, type ThemePreference, useTheme } from '../../app/theme';
import { applyRecommendedProviderSetup, resolveDecisionRuntime, useModelConfig, type ModelSettings, type ProviderInstance } from '../../app/model-config';
import type { Employee, EmployeeId } from '../../app/workspace';
import type { AuthUser } from '../../services/auth';
import { employeeDisplayName } from '../../app/employees';
import ProviderInstancesEditor from './ProviderInstancesEditor.vue';
import EnvironmentSettingsCard from './EnvironmentSettingsCard.vue';
import ConfiguredModelsEditor from './ConfiguredModelsEditor.vue';
import LocalEmbeddingSettingsCard from './LocalEmbeddingSettingsCard.vue';
import UsageStatsPanel from './UsageStatsPanel.vue';
import LocalUsersPanel from './LocalUsersPanel.vue';
import AccountSecurityPanel from './AccountSecurityPanel.vue';
import PptxEnhancedSettingsCard from './PptxEnhancedSettingsCard.vue';
import DoclingEnhancedSettingsCard from './DoclingEnhancedSettingsCard.vue';
import RealtimeVoiceSettingsCard from './RealtimeVoiceSettingsCard.vue';
import { deleteArchivedAssets, getRuntimeStatus, getServerRuntimeConfig, runStorageCleanup, saveServerRuntimeConfig, scanStorageCleanup, subscribeRuntimeStatus, testDecisionRuntime, type RuntimeStatusResponse, type StorageCleanupReport } from '../../services/api';
import DshRuntimeInstallCard from '../dsh/DshRuntimeInstallCard.vue';
import { searchProviderIds, useSearchConfig, type SearchProviderId } from '../../app/search-config';
import { knowledgeProviderMeta, useKnowledgeConfig } from '../../app/kb-config';
import {
  DEFAULT_AUTO_SCHEDULE_MAX_AGENTS,
  MAX_AUTO_SCHEDULE_MAX_AGENTS,
  MIN_AUTO_SCHEDULE_MAX_AGENTS,
  useAutoScheduleConfig,
  type AutoScheduleConfig,
} from '../../app/auto-schedule-config';
import { useNotify } from '../../app/notify';
import { cleanupChatAttachments, getChatAttachmentStats } from '../../services/orchestration';

const props = defineProps<{
  employees: Employee[];
  defaultEmployeeId: EmployeeId;
  currentUser?: AuthUser | null;
  localUsers?: AuthUser[];
  isAdmin?: boolean;
  authBusy?: boolean;
  /** 外部（如启动引导弹窗）指定的初始 tab；消费后通过 focus-consumed 通知清空。 */
  focusTab?: 'providers' | 'models' | null;
  ensureVoiceConversation?: () => Promise<string | null>;
}>();
const emit = defineEmits<{
  setDefaultEmployee: [id: EmployeeId];
  openEnvironment: [];
  openCheck: [];
  createLocalUser: [payload: { username: string; displayName: string; password: string; role: 'admin' | 'member' }];
  updateLocalUser: [payload: { userId: string; displayName?: string; password?: string; role?: 'admin' | 'member'; disabled?: boolean }];
  deleteLocalUser: [userId: string];
  'focus-consumed': [];
  'open-work': [conversationId: string, title: string];
}>();
const { t, locale, setLocale } = useI18n();
const { preference, setTheme } = useTheme();
const { settings, load, save } = useModelConfig();
const { settings: searchSettings, load: loadSearch, save: saveSearch, defaults: searchDefaults } = useSearchConfig();
const {
  providerSettings: knowledgeProviderSettings,
  loadProviders: loadKnowledgeProviders,
  saveProviders: saveKnowledgeProviders,
} = useKnowledgeConfig();
const notify = useNotify();
const dirty = ref(false);
const realtimeTestRequest = ref(0);
const configuredModelsEditor = ref<InstanceType<typeof ConfiguredModelsEditor> | null>(null);

function openRealtimeModelConfig() {
  configuredModelsEditor.value?.openDefaultRealtimeConfig();
}
const decisionTest = ref('');
const decisionTesting = ref(false);
const decisionModels = computed(() => settings.value.models.filter((item) => item.capability === 'decision'));
const autoConfigSummary = ref('');
const {
  config: autoScheduleStored,
  load: loadAutoScheduleConfig,
  save: saveAutoScheduleConfigStore,
  clampMaxAgents,
} = useAutoScheduleConfig();
const autoScheduleDraft = ref<AutoScheduleConfig>({
  preferMinimal: true,
  strongFitOnly: true,
  maxAgents: DEFAULT_AUTO_SCHEDULE_MAX_AGENTS,
});
const autoScheduleDirty = ref(false);
const runtimeSettings = ref({
  sidecarPoolSize: 1,
  sidecarSharedMaxRuns: 8,
  enabledEngines: ['pi', 'agentscope', 'dsh'] as Array<'pi' | 'agentscope' | 'dsh'>,
  defaultEngine: 'pi' as 'pi' | 'agentscope' | 'dsh',
});
const ENGINE_OPTIONS = [
  { id: 'pi' as const, label: 'pi（进程内默认）' },
  { id: 'agentscope' as const, label: 'agentscope（Python Sidecar）' },
  { id: 'dsh' as const, label: 'dsh（编码 Harness）' },
];
const runtimeStatus = ref<RuntimeStatusResponse | null>(null);
const attachmentStats = ref<{ bytes: number; count: number; limitBytes: number; warning: boolean } | null>(null);
const attachmentCleanupBusy = ref(false);
const attachmentCleanupPreview = ref('');
function attachmentBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
async function loadAttachmentStats() { attachmentStats.value = await getChatAttachmentStats().catch(() => null); }
async function previewAttachmentCleanup() {
  attachmentCleanupBusy.value = true;
  try { const result = await cleanupChatAttachments(true); attachmentCleanupPreview.value = `可清理 ${result.count} 个过期附件，共 ${attachmentBytes(result.bytes)}`; }
  finally { attachmentCleanupBusy.value = false; }
}
async function runAttachmentCleanup() {
  attachmentCleanupBusy.value = true;
  try { const result = await cleanupChatAttachments(false); attachmentCleanupPreview.value = `已清理 ${result.count} 个附件，释放 ${attachmentBytes(result.bytes)}`; await loadAttachmentStats(); }
  finally { attachmentCleanupBusy.value = false; }
}
const storageReport = ref<StorageCleanupReport | null>(null);
const storageBusy = ref(false);
const storageMessage = ref('');
const selectedLargeAssets = ref<string[]>([]);
async function scanStorage() {
  storageBusy.value = true;
  storageMessage.value = '';
  try {
    storageReport.value = await scanStorageCleanup();
    selectedLargeAssets.value = selectedLargeAssets.value.filter((id) => storageReport.value?.largeAssets.some((asset) => asset.id === id));
  } catch (error) { notify.error(error instanceof Error ? error.message : '空间扫描失败'); }
  finally { storageBusy.value = false; }
}
async function cleanSafeStorage() {
  if (!storageReport.value?.safeCleanup.count || !window.confirm(`确认清理 ${storageReport.value.safeCleanup.count} 处无主或过期中间文件？正式资产不会被删除。`)) return;
  storageBusy.value = true;
  try {
    const result = await runStorageCleanup();
    storageReport.value = result.scan;
    storageMessage.value = `已释放 ${attachmentBytes(result.bytes)}`;
    notify.pushRaw('success', '清理完成', storageMessage.value);
  } catch (error) { notify.error(error instanceof Error ? error.message : '清理失败'); }
  finally { storageBusy.value = false; }
}
async function deleteSelectedLargeAssets() {
  const ids = [...selectedLargeAssets.value];
  if (!ids.length || !window.confirm(`确认永久删除选中的 ${ids.length} 个资产？删除后无法恢复。`)) return;
  storageBusy.value = true;
  try {
    const result = await deleteArchivedAssets(ids);
    selectedLargeAssets.value = [];
    storageMessage.value = `已删除 ${result.deleted} 个资产`;
    await scanStorage();
  } catch (error) { notify.error(error instanceof Error ? error.message : '资产删除失败'); }
  finally { storageBusy.value = false; }
}
const runtimeStatusLoading = ref(false);
const runtimeStatusAutoRefresh = ref(true);
const runtimeStatusPending = ref(false);
const runtimeStatusLive = ref(false);
const languageLabel: Record<Locale, string> = { 'zh-CN': '简体中文', 'en-US': 'English' };
type SettingsTab = 'appearance' | 'providers' | 'models' | 'decision' | 'search' | 'knowledge' | 'account' | 'usage' | 'environment' | 'users' | 'general';
const tab = ref<SettingsTab>('providers');

// 外部指定初始 tab（启动引导弹窗「去配置」跳转）：应用一次后通知父组件清空，
// 避免用户手动切换后再返回设置页时又被强制跳回。
watch(
  () => props.focusTab,
  (next) => {
    if (!next) return;
    tab.value = next;
    emit('focus-consumed');
  },
);
const tabs: Array<{ id: SettingsTab; labelKey: string }> = [
  { id: 'appearance', labelKey: 'settings.tabAppearance' },
  { id: 'providers', labelKey: 'settings.tabProviders' },
  { id: 'models', labelKey: 'settings.tabModels' },
  { id: 'decision', labelKey: 'settings.tabDecision' },
  { id: 'search', labelKey: 'settings.tabSearch' },
  { id: 'knowledge', labelKey: 'settings.tabKnowledge' },
  { id: 'account', labelKey: 'settings.tabAccount' },
  { id: 'users', labelKey: 'settings.tabUsers' },
  { id: 'usage', labelKey: 'settings.tabUsage' },
  { id: 'environment', labelKey: 'settings.tabEnvironment' },
  { id: 'general', labelKey: 'settings.tabGeneral' },
];

onMounted(() => {
  if (props.focusTab) {
    tab.value = props.focusTab;
    emit('focus-consumed');
  }
  void load();
  void loadSearch();
  void loadKnowledgeProviders();
  void loadRuntimeSettings();
  void loadRuntimeStatus();
  void loadAttachmentStats();
  void (async () => {
    await loadAutoScheduleConfig();
    autoScheduleDraft.value = { ...autoScheduleStored.value };
  })();
});

let runtimeStatusStreamCleanup: (() => void) | null = null;
let runtimeStatusFallbackTimer: ReturnType<typeof setInterval> | null = null;

function stopRuntimeStatusLiveUpdates() {
  runtimeStatusStreamCleanup?.();
  runtimeStatusStreamCleanup = null;
  if (runtimeStatusFallbackTimer) {
    clearInterval(runtimeStatusFallbackTimer);
    runtimeStatusFallbackTimer = null;
  }
  runtimeStatusLive.value = false;
}

function startRuntimeStatusLiveUpdates() {
  stopRuntimeStatusLiveUpdates();
  if (tab.value !== 'general' || !runtimeStatusAutoRefresh.value) return;
  runtimeStatusStreamCleanup = subscribeRuntimeStatus({
    onMessage(value) {
      runtimeStatus.value = value;
      runtimeStatusLive.value = true;
      if (runtimeStatusFallbackTimer) {
        clearInterval(runtimeStatusFallbackTimer);
        runtimeStatusFallbackTimer = null;
      }
      runtimeStatusLoading.value = false;
      runtimeStatusPending.value = false;
    },
    onError() {
      runtimeStatusLive.value = false;
      if (runtimeStatusFallbackTimer) return;
      runtimeStatusFallbackTimer = setInterval(() => {
        if (tab.value !== 'general' || !runtimeStatusAutoRefresh.value || document.visibilityState !== 'visible') return;
        void loadRuntimeStatus({ silent: true });
      }, 3000);
    },
  });
}

watch([tab, runtimeStatusAutoRefresh], () => {
  startRuntimeStatusLiveUpdates();
}, { immediate: true });

onUnmounted(() => {
  stopRuntimeStatusLiveUpdates();
});

function onDirty() {
  dirty.value = true;
}

async function testDecision() {
  const runtime = resolveDecisionRuntime(settings.value);
  if (!runtime) { decisionTest.value = '请先在“模型”中登记决策判断模型并在此选择。'; return; }
  decisionTesting.value = true; decisionTest.value = '';
  try {
    const result = await testDecisionRuntime(runtime as unknown as Record<string, unknown>);
    decisionTest.value = `连接正常 · ${Number(result.latencyMs || 0)} ms`;
  } catch (error) { decisionTest.value = error instanceof Error ? error.message : String(error); }
  finally { decisionTesting.value = false; }
}

function providerRuntimeFingerprint(instance: ProviderInstance | undefined) {
  if (!instance) return '';
  return JSON.stringify({
    type: instance.type,
    baseUrl: instance.baseUrl.trim(),
    workspaceId: instance.workspaceId?.trim() || '',
    appId: instance.appId?.trim() || '',
    apiKey: instance.apiKey,
    apiSecret: instance.apiSecret || '',
    disableThinking: instance.disableThinking,
  });
}

function updateProviderInstances(next: ProviderInstance[]) {
  const previous = new Map(settings.value.providerInstances.map((item) => [item.id, providerRuntimeFingerprint(item)]));
  const changed = new Set(next
    .filter((item) => previous.has(item.id) && previous.get(item.id) !== providerRuntimeFingerprint(item))
    .map((item) => item.id));
  settings.value.providerInstances = next;
  if (changed.size) {
    settings.value.models = settings.value.models.map((model) => changed.has(model.providerInstanceId)
      ? { ...model, health: undefined }
      : model);
  }
}

async function saveModelConfig() {
  try {
    const next: ModelSettings = JSON.parse(JSON.stringify(settings.value));
    if (next.decisionRuntime?.enabled && !resolveDecisionRuntime(next)) {
      throw new Error('启用决策守卫前，请先选择一个配置完整的“决策判断”应用模型。');
    }
    const instanceIds = new Set(next.providerInstances.map((item) => item.id));
    next.models = next.models.filter((item) => instanceIds.has(item.providerInstanceId) && item.modelId.trim());
    if (next.activeChatModelId && !next.models.some((item) => item.id === next.activeChatModelId && item.capability === 'chat')) {
      next.activeChatModelId = next.models.find((item) => item.capability === 'chat')?.id ?? null;
    }
    if (next.activeEmbeddingModelId && !next.models.some((item) => item.id === next.activeEmbeddingModelId && item.capability === 'embedding')) {
      next.activeEmbeddingModelId = next.models.find((item) => item.capability === 'embedding')?.id ?? null;
    }
    for (const [employeeId, modelId] of Object.entries(next.employeeDefaultModelIds)) {
      if (!next.models.some((item) => item.id === modelId && item.capability === 'chat')) delete next.employeeDefaultModelIds[employeeId];
    }
    await save(next);
    dirty.value = false;
    notify.success('notify.saved');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

async function autoConfigureProvider(instance: ProviderInstance) {
  try {
    const result = applyRecommendedProviderSetup(settings.value, instance, [props.defaultEmployeeId]);
    if (result.manualRequired) {
      autoConfigSummary.value = t('settings.providerAutoManualRequired');
      tab.value = 'models';
      return;
    }
    await save(result.settings);
    dirty.value = false;
    const capabilities = result.configured.map((item) => t(`settings.capability.${item}`)).join('、');
    autoConfigSummary.value = t('settings.providerAutoConfigured', { count: result.addedModels, capabilities });
    notify.success('notify.saved', autoConfigSummary.value);
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

async function saveSearchConfig() {
  try {
    await saveSearch();
    dirty.value = false;
    notify.success('notify.saved');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

async function saveKnowledgeProviderConfig() {
  try {
    await saveKnowledgeProviders();
    dirty.value = false;
    notify.success('notify.saved');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

function resetSearchEndpoint(id: SearchProviderId) {
  const item = searchSettings.value.providers.find((provider) => provider.id === id);
  if (item) item.baseUrl = searchDefaults[id].baseUrl;
  onDirty();
}

async function loadRuntimeSettings() {
  try {
    const value = await getServerRuntimeConfig() as {
      sidecarPoolSize?: number;
      sidecarSharedMaxRuns?: number;
      enabledEngines?: string[];
      defaultEngine?: string;
    };
    runtimeSettings.value.sidecarPoolSize = Math.max(1, Number(value.sidecarPoolSize) || 1);
    runtimeSettings.value.sidecarSharedMaxRuns = Math.max(1, Number(value.sidecarSharedMaxRuns) || 8);
    const enabled = Array.isArray(value.enabledEngines)
      ? value.enabledEngines
        .map((id) => String(id).trim().toLowerCase())
        .filter((id): id is 'pi' | 'agentscope' | 'dsh' => id === 'pi' || id === 'agentscope' || id === 'dsh')
      : [];
    runtimeSettings.value.enabledEngines = enabled.length ? [...new Set(enabled)] : ['pi', 'agentscope', 'dsh'];
    const def = String(value.defaultEngine || 'pi').trim().toLowerCase();
    runtimeSettings.value.defaultEngine =
      (def === 'pi' || def === 'agentscope' || def === 'dsh') && runtimeSettings.value.enabledEngines.includes(def)
        ? def
        : runtimeSettings.value.enabledEngines[0] || 'pi';
  } catch {
    runtimeSettings.value.sidecarPoolSize = 1;
    runtimeSettings.value.sidecarSharedMaxRuns = 8;
    runtimeSettings.value.enabledEngines = ['pi', 'agentscope', 'dsh'];
    runtimeSettings.value.defaultEngine = 'pi';
  }
}

function toggleEnabledEngine(id: 'pi' | 'agentscope' | 'dsh') {
  const set = new Set(runtimeSettings.value.enabledEngines);
  if (set.has(id)) {
    if (set.size <= 1) return;
    set.delete(id);
  } else {
    set.add(id);
  }
  runtimeSettings.value.enabledEngines = ENGINE_OPTIONS.map((item) => item.id).filter((item) => set.has(item));
  if (!runtimeSettings.value.enabledEngines.includes(runtimeSettings.value.defaultEngine)) {
    runtimeSettings.value.defaultEngine = runtimeSettings.value.enabledEngines[0] || 'pi';
  }
}

async function saveAutoScheduleSettings() {
  try {
    const saved = await saveAutoScheduleConfigStore({
      preferMinimal: Boolean(autoScheduleDraft.value.preferMinimal),
      strongFitOnly: Boolean(autoScheduleDraft.value.strongFitOnly),
      maxAgents: clampMaxAgents(autoScheduleDraft.value.maxAgents),
    });
    autoScheduleDraft.value = { ...saved };
    autoScheduleDirty.value = false;
    notify.success(t('settings.autoScheduleSaved'));
  } catch (error) {
    notify.error(error);
  }
}

function markAutoScheduleDirty() {
  autoScheduleDirty.value = true;
}

async function saveRuntimeSettings() {
  try {
    const enabled: Array<'pi' | 'agentscope' | 'dsh'> = runtimeSettings.value.enabledEngines.length
      ? runtimeSettings.value.enabledEngines
      : ['pi' as const];
    const defaultEngine: 'pi' | 'agentscope' | 'dsh' = enabled.includes(runtimeSettings.value.defaultEngine)
      ? runtimeSettings.value.defaultEngine
      : (enabled[0] ?? 'pi');
    const payload = {
      sidecarPoolSize: Math.max(1, Number(runtimeSettings.value.sidecarPoolSize) || 1),
      sidecarSharedMaxRuns: Math.max(1, Number(runtimeSettings.value.sidecarSharedMaxRuns) || 8),
      enabledEngines: enabled,
      defaultEngine,
    };
    const saved = await saveServerRuntimeConfig(payload) as {
      sidecarPoolSize?: number;
      sidecarSharedMaxRuns?: number;
      enabledEngines?: string[];
      defaultEngine?: string;
    };
    runtimeSettings.value.sidecarPoolSize = Math.max(1, Number(saved.sidecarPoolSize) || payload.sidecarPoolSize);
    runtimeSettings.value.sidecarSharedMaxRuns = Math.max(1, Number(saved.sidecarSharedMaxRuns) || payload.sidecarSharedMaxRuns);
    const savedEnabled: Array<'pi' | 'agentscope' | 'dsh'> = Array.isArray(saved.enabledEngines)
      ? saved.enabledEngines
        .map((id) => String(id).trim().toLowerCase())
        .filter((id): id is 'pi' | 'agentscope' | 'dsh' => id === 'pi' || id === 'agentscope' || id === 'dsh')
      : payload.enabledEngines;
    runtimeSettings.value.enabledEngines = savedEnabled.length ? savedEnabled : payload.enabledEngines;
    const savedDefault = String(saved.defaultEngine || payload.defaultEngine).trim().toLowerCase();
    runtimeSettings.value.defaultEngine =
      (savedDefault === 'pi' || savedDefault === 'agentscope' || savedDefault === 'dsh')
        ? savedDefault
        : payload.defaultEngine;
    await loadRuntimeStatus();
    notify.success('notify.saved');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

async function loadRuntimeStatus(options: { silent?: boolean } = {}) {
  if (runtimeStatusPending.value) return;
  runtimeStatusPending.value = true;
  runtimeStatusLoading.value = !options.silent;
  try {
    runtimeStatus.value = await getRuntimeStatus();
  } catch {
    runtimeStatus.value = null;
  } finally {
    runtimeStatusPending.value = false;
    runtimeStatusLoading.value = false;
  }
}

function refreshRuntimeStatus() {
  void loadRuntimeStatus();
}

function formatTimestamp(value?: number) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function formatDurationFrom(value?: number) {
  if (!value) return '-';
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return `${minutes}m ${remainSeconds}s`;
}

function waitReasonLabel(value?: string) {
  switch (value) {
    case 'session-lane': return '等待同会话串行';
    case 'user-capacity': return '等待用户并发配额';
    case 'global-capacity': return '等待全局并发配额';
    case 'capacity': return '等待 sidecar 容量';
    default: return '运行中';
  }
}

function runtimeSeverityClass(level: 'info' | 'warn' | 'danger') {
  if (level === 'danger') return 'border-red-300 bg-red-50 text-red-700';
  if (level === 'warn') return 'border-amber-300 bg-amber-50 text-amber-700';
  return 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)]';
}

function dispatcherAlerts() {
  const status = runtimeStatus.value?.dispatcher;
  if (!status) return [] as Array<{ level: 'warn' | 'danger'; text: string }>;
  const alerts: Array<{ level: 'warn' | 'danger'; text: string }> = [];
  if (status.counts.running >= status.limits.global) alerts.push({ level: 'danger', text: '全局并发已打满' });
  if (status.runs.some((item) => item.waitReason === 'user-capacity')) alerts.push({ level: 'warn', text: '存在 run 等待用户并发配额' });
  if (status.runs.some((item) => item.waitReason === 'session-lane')) alerts.push({ level: 'warn', text: '存在 run 等待同会话串行' });
  if (status.runs.some((item) => item.state === 'queued' && Date.now() - item.queuedAt >= 30_000)) alerts.push({ level: 'danger', text: '存在排队超过 30 秒的 run' });
  return alerts;
}

function sidecarAlerts() {
  const status = runtimeStatus.value?.sidecar;
  if (!status) return [] as Array<{ level: 'warn' | 'danger'; text: string }>;
  const alerts: Array<{ level: 'warn' | 'danger'; text: string }> = [];
  const totalCapacity = Math.max(1, status.counts.sidecars) * status.limits.maxRuns;
  if (status.counts.sidecars > 0 && status.counts.activeRuns >= totalCapacity) alerts.push({ level: 'danger', text: 'Sidecar 池容量已打满' });
  if (status.counts.queued > 0) alerts.push({ level: 'warn', text: `存在 ${status.counts.queued} 个 run 等待 sidecar 容量` });
  if (status.counts.unhealthySidecars > 0) alerts.push({ level: 'danger', text: `存在 ${status.counts.unhealthySidecars} 个异常 sidecar 实例` });
  if (status.counts.coolingSidecars > 0) alerts.push({ level: 'warn', text: `存在 ${status.counts.coolingSidecars} 个 sidecar 处于冷却期` });
  if (status.runs.some((item) => item.state === 'queued' && Date.now() - item.queuedAt >= 30_000)) alerts.push({ level: 'danger', text: '存在 sidecar 排队超过 30 秒的 run' });
  return alerts;
}

function handleThemeChange(event: Event) {
  setTheme((event.target as HTMLSelectElement).value as ThemePreference);
}

function handleLocaleChange(event: Event) {
  setLocale((event.target as HTMLSelectElement).value as Locale);
}

function handleDefaultEmployeeChange(event: Event) {
  emit('setDefaultEmployee', (event.target as HTMLSelectElement).value as EmployeeId);
}
</script>

<template>
  <section :class="['mx-auto w-full px-6 py-16 sm:px-12', tab === 'users' || tab === 'general' || tab === 'models' ? 'max-w-6xl' : 'max-w-3xl']">
    <header class="mb-8">
      <p class="mb-2 text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">Workmate / PREFERENCES</p>
      <h1 class="text-4xl font-bold tracking-[-.045em]">{{ t('settings.title') }}</h1>
      <p class="mt-3 max-w-xl leading-relaxed text-[var(--muted)]">{{ t('settings.subtitleTabs') }}</p>
    </header>

    <nav class="mb-5 flex flex-wrap gap-2 border-b border-[var(--border)] pb-3">
      <button
        v-for="item in tabs"
        :key="item.id"
        :class="[
          'rounded-lg px-3 py-2 text-xs font-semibold transition',
          tab === item.id ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-muted)] text-[var(--muted)] hover:text-[var(--text)]',
        ]"
        type="button"
        @click="tab = item.id"
      >
        {{ t(item.labelKey) }}
      </button>
    </nav>

    <section v-if="tab === 'appearance'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <h2 class="mb-3 text-[17px] font-bold">{{ t('settings.appearance') }}</h2>
      <label class="flex items-center justify-between gap-6 border-t border-[var(--border)] py-4 text-sm">
        <strong>{{ t('settings.theme') }}</strong>
        <select class="min-w-36 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2" :value="preference" @change="handleThemeChange">
          <option v-for="option in themeOptions" :key="option" :value="option">{{ t(`theme.${option}`) }}</option>
        </select>
      </label>
      <label class="flex items-center justify-between gap-6 border-t border-[var(--border)] py-4 text-sm">
        <strong>{{ t('settings.language') }}</strong>
        <select class="min-w-36 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2" :value="locale" @change="handleLocaleChange">
          <option v-for="option in localeOptions" :key="option" :value="option">{{ languageLabel[option] }}</option>
        </select>
      </label>
    </section>

    <section v-else-if="tab === 'providers'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <h2 class="text-[17px] font-bold">{{ t('settings.tabProviders') }}</h2>
      <p class="mt-2 text-[13px] leading-relaxed text-[var(--muted)]">{{ t('settings.providersHelp') }}</p>
      <div class="mt-6">
        <ProviderInstancesEditor
          :instances="settings.providerInstances"
          :models="settings.models"
          @update:instances="updateProviderInstances"
          @dirty="onDirty"
          @auto-configure="autoConfigureProvider"
          @review-models="tab = 'models'"
        />
      </div>
      <div v-if="autoConfigSummary" class="mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-sm">
        <strong class="block text-emerald-700">{{ t('settings.providerAutoResultTitle') }}</strong>
        <p class="mt-1 text-xs leading-relaxed text-[var(--muted)]">{{ autoConfigSummary }} {{ t('settings.providerAutoFirstUse') }}</p>
        <button class="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold" type="button" @click="tab = 'models'">{{ t('settings.providerAutoReview') }}</button>
      </div>
      <div class="mt-6 flex items-center justify-between gap-3">
        <span class="text-[13px] text-[var(--muted)]">{{ dirty ? t('settings.saveHint') : t('settings.tabProvidersHint') }}</span>
        <button class="rounded-lg bg-[var(--accent)] px-3 py-2.5 text-[13px] font-semibold text-white" type="button" @click="saveModelConfig">{{ t('settings.save') }}</button>
      </div>
    </section>

    <section v-else-if="tab === 'decision'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <div v-if="settings.decisionRuntime">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div class="flex items-center gap-2"><h2 class="text-[17px] font-bold">决策守卫</h2><span class="rounded-full bg-[var(--surface-muted)] px-2 py-1 text-[10px] font-bold text-[var(--muted)]">默认关闭</span></div>
            <p class="mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--muted)]">选择 JEV 或未来兼容的决策应用模型，在 Tool 真正执行前进行风险判断，也可供主模型按需调用。关闭时不请求决策模型，不增加对话延迟。</p>
          </div>
          <label class="flex cursor-pointer items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm font-semibold"><input v-model="settings.decisionRuntime.enabled" type="checkbox" @change="onDirty" />启用决策守卫</label>
        </div>
        <div v-if="!decisionModels.length" class="mt-6 rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4 text-sm">
          <strong>尚未配置决策模型</strong><p class="mt-1 text-xs text-[var(--muted)]">请先在 Provider 中保存连接，再到“模型”新增能力为“决策判断”的模型。</p><button class="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold" type="button" @click="tab = 'models'">去配置应用模型</button>
        </div>
        <div class="mt-6 grid gap-4 sm:grid-cols-2">
          <label class="grid gap-1.5 text-xs font-semibold sm:col-span-2">决策应用模型<select v-model="settings.decisionRuntime.applicationModelId" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-normal" @change="onDirty"><option value="">请选择决策模型</option><option v-for="item in decisionModels" :key="item.id" :value="item.id">{{ item.label || item.modelId }}</option></select><span class="font-normal text-[var(--muted)]">连接地址与 API Key 统一由 Provider 管理，此处不再重复保存。</span></label>
          <label class="grid gap-1.5 text-xs font-semibold">运行模式<select v-model="settings.decisionRuntime.mode" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-normal" @change="onDirty"><option value="off">关闭</option><option value="observe">观察：判断但不拦截</option><option value="enforce">强制：高风险时拦截</option></select></label>
          <label class="grid gap-1.5 text-xs font-semibold">请求超时（ms）<input v-model.number="settings.decisionRuntime.timeoutMs" type="number" min="200" max="10000" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-normal" @input="onDirty" /></label>
          <label class="grid gap-1.5 text-xs font-semibold">网络失败策略<select v-model="settings.decisionRuntime.failurePolicy" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-normal" @change="onDirty"><option value="allow">自动放行，不影响主流程</option><option value="deny">拒绝执行，安全优先</option></select></label>
        </div>
        <div class="mt-5 grid gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-xs sm:grid-cols-3">
          <label class="flex items-center gap-2"><input v-model="settings.decisionRuntime.guardTools" type="checkbox" @change="onDirty" /> Tool 执行前安检</label>
          <label class="flex items-center gap-2"><input v-model="settings.decisionRuntime.agentTool" type="checkbox" @change="onDirty" /> 主模型按需调用</label>
          <label class="flex items-center gap-2"><input v-model="settings.decisionRuntime.mcpEnabled" type="checkbox" @change="onDirty" /> MCP 对外开放（预留）</label>
        </div>
        <div class="mt-6 flex flex-wrap items-center justify-between gap-3">
          <span class="text-xs text-[var(--muted)]">{{ decisionTest || (dirty ? '配置已修改，请保存后生效。' : '建议启用后先测试连接。') }}</span>
          <div class="flex gap-2"><button class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-xs font-semibold disabled:opacity-50" type="button" :disabled="decisionTesting || !settings.decisionRuntime.enabled || !settings.decisionRuntime.applicationModelId" @click="testDecision">{{ decisionTesting ? '测试中…' : '测试连接' }}</button><button class="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-xs font-semibold text-white" type="button" @click="saveModelConfig">保存配置</button></div>
        </div>
      </div>
    </section>

    <section v-else-if="tab === 'models'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <h2 class="text-[17px] font-bold">{{ t('settings.tabModels') }}</h2>
      <p class="mt-2 text-[13px] leading-relaxed text-[var(--muted)]">{{ t('settings.configuredModelsHelp') }}</p>
      <div class="mt-6">
        <ConfiguredModelsEditor
          ref="configuredModelsEditor"
          :instances="settings.providerInstances"
          :models="settings.models"
          :active-chat-model-id="settings.activeChatModelId"
          :active-embedding-model-id="settings.activeEmbeddingModelId"
          :capability-bindings="settings.capabilityBindings"
          @update:models="settings.models = $event"
          @update:active-chat-model-id="settings.activeChatModelId = $event"
          @update:active-embedding-model-id="settings.activeEmbeddingModelId = $event"
          @update:capability-bindings="settings.capabilityBindings = $event"
          @configure-provider="tab = 'providers'"
          @test-realtime="realtimeTestRequest += 1"
          @dirty="onDirty"
        />
      </div>
      <div class="mt-6 flex items-center justify-between gap-3">
        <span class="text-[13px] text-[var(--muted)]">{{ dirty ? t('settings.saveHint') : t('settings.tabModelsHint') }}</span>
        <button class="rounded-lg bg-[var(--accent)] px-3 py-2.5 text-[13px] font-semibold text-white" type="button" @click="saveModelConfig">{{ t('settings.save') }}</button>
      </div>
      <div class="mt-8 border-t border-[var(--border)] pt-8">
        <RealtimeVoiceSettingsCard :is-admin="isAdmin" :ensure-voice-conversation="ensureVoiceConversation" :test-request="realtimeTestRequest" @configure-model="openRealtimeModelConfig" @open-work="(id, title) => emit('open-work', id, title)" />
      </div>
    </section>

    <section v-else-if="tab === 'search'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-[17px] font-bold">{{ t('settings.tabSearch') }}</h2>
          <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--muted)]">{{ t('settings.searchHelp') }}</p>
        </div>
        <select v-model="searchSettings.defaultProvider" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm" @change="onDirty">
          <option value="auto">{{ t('settings.searchAuto') }}</option>
          <option v-for="id in searchProviderIds" :key="id" :value="id">{{ searchSettings.providers.find((item) => item.id === id)?.label }}</option>
        </select>
      </div>
      <div class="mt-5 divide-y divide-[var(--border)] border-y border-[var(--border)]">
        <article v-for="provider in searchSettings.providers" :key="provider.id" class="py-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <label class="flex items-center gap-2 text-sm font-bold"><input v-model="provider.enabled" type="checkbox" @change="onDirty" />{{ provider.label }}</label>
            <span class="text-xs text-[var(--muted)]">{{ provider.id === 'aliyun' ? t('settings.searchAliyunHint') : t('settings.searchEndpointHint') }}</span>
          </div>
          <div class="mt-3 grid gap-2 sm:grid-cols-[1fr_1.25fr_auto]">
            <input v-model="provider.apiKey" type="password" autocomplete="off" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm" :placeholder="t('settings.apiKey')" @input="onDirty" />
            <input v-model="provider.baseUrl" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm" placeholder="Endpoint" @input="onDirty" />
            <button class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold" type="button" @click="resetSearchEndpoint(provider.id)">{{ t('settings.searchReset') }}</button>
          </div>
        </article>
      </div>
      <div class="mt-5 flex items-center justify-between gap-3">
        <span class="text-xs text-[var(--muted)]">{{ t('settings.searchSaveHint') }}</span>
        <button class="rounded-lg bg-[var(--accent)] px-3 py-2.5 text-[13px] font-semibold text-white" type="button" @click="saveSearchConfig">{{ t('settings.save') }}</button>
      </div>
    </section>

    <section v-else-if="tab === 'knowledge'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <ExperienceSettingsCard />
      <div>
        <h2 class="text-[17px] font-bold">{{ t('settings.tabKnowledge') }}</h2>
        <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--muted)]">{{ t('settings.knowledgeHelp') }}</p>
      </div>
      <div class="mt-5 divide-y divide-[var(--border)] border-y border-[var(--border)]">
        <article v-for="provider in knowledgeProviderSettings.providers" :key="provider.id" class="py-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <label class="flex items-center gap-2 text-sm font-bold">
              <input
                v-model="provider.enabled"
                type="checkbox"
                :disabled="provider.id === 'lancedb'"
                @change="onDirty"
              />
              {{ knowledgeProviderMeta[provider.id].label }}
            </label>
            <span class="text-xs text-[var(--muted)]">
              {{ provider.id === 'lancedb' ? t('settings.knowledgeLocalHint') : t('settings.knowledgeCloudHint') }}
            </span>
          </div>
          <div v-if="provider.id !== 'lancedb'" class="mt-3 grid gap-2 sm:grid-cols-2">
            <input
              v-model="provider.defaultApiKey"
              type="password"
              autocomplete="off"
              class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm"
              :placeholder="provider.id === 'bailian' ? t('settings.knowledgeBailianApiKey') : t('settings.knowledgeDefaultApiKey')"
              @input="onDirty"
            />
            <input
              v-model="provider.defaultBaseUrl"
              class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm"
              :placeholder="t('settings.knowledgeDefaultBaseUrl')"
              @input="onDirty"
            />
          </div>
          <div v-if="provider.id === 'bailian'" class="mt-2 grid gap-2 sm:grid-cols-2">
            <input
              v-model="provider.defaultWorkspaceId"
              class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm sm:col-span-2"
              :placeholder="t('settings.knowledgeBailianWorkspace')"
              @input="onDirty"
            />
            <input
              v-model="provider.defaultAccessKeyId"
              autocomplete="off"
              class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm"
              :placeholder="t('settings.knowledgeBailianAccessKeyId')"
              @input="onDirty"
            />
            <input
              v-model="provider.defaultAccessKeySecret"
              type="password"
              autocomplete="off"
              class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm"
              :placeholder="t('settings.knowledgeBailianAccessKeySecret')"
              @input="onDirty"
            />
            <p class="sm:col-span-2 text-[11px] leading-relaxed text-[var(--muted)]">{{ t('settings.knowledgeBailianSharedHint') }}</p>
          </div>
        </article>
      </div>
      <div class="mt-5 flex items-center justify-between gap-3">
        <span class="text-xs text-[var(--muted)]">{{ t('settings.knowledgeSaveHint') }}</span>
        <button class="rounded-lg bg-[var(--accent)] px-3 py-2.5 text-[13px] font-semibold text-white" type="button" @click="saveKnowledgeProviderConfig">{{ t('settings.save') }}</button>
      </div>
    </section>

    <AccountSecurityPanel
      v-else-if="tab === 'account'"
      :current-user="currentUser ?? null"
      :busy="authBusy"
    />

    <LocalUsersPanel
      v-else-if="tab === 'users'"
      :current-user="currentUser ?? null"
      :is-admin="Boolean(isAdmin)"
      :users="localUsers ?? []"
      :busy="authBusy"
      @create="emit('createLocalUser', $event)"
      @update="emit('updateLocalUser', $event)"
      @remove="emit('deleteLocalUser', $event)"
    />

    <section v-else-if="tab === 'environment'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <h2 class="mb-4 text-[17px] font-bold">{{ t('settings.tabEnvironment') }}</h2>
      <EnvironmentSettingsCard @open-environment="emit('openEnvironment')" @open-check="emit('openCheck')" />
    </section>

    <section v-else-if="tab === 'usage'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <UsageStatsPanel />
    </section>

    <section v-else class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <h2 class="mb-1 text-[17px] font-bold">{{ t('settings.defaultEmployee') }}</h2>
      <p class="mb-3 text-[13px] leading-relaxed text-[var(--muted)]">{{ t('settings.employeeRuntimeMoved') }}</p>
      <label class="flex items-center justify-between gap-6 border-t border-[var(--border)] py-4 text-sm">
        <strong>{{ t('common.chooseEmployee') }}</strong>
        <select
          class="min-w-36 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2"
          :value="props.defaultEmployeeId"
          @change="handleDefaultEmployeeChange"
        >
          <option v-for="employee in employees" :key="employee.id" :value="employee.id">{{ employeeDisplayName(employee, t) }}</option>
        </select>
      </label>
      <div class="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-5">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div class="flex items-center gap-2">
              <h3 class="text-[16px] font-bold">存储清理</h3>
              <span class="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-600">安全扫描</span>
            </div>
            <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--muted)]">清理 7 天前的无主目录和已结束运行的中间文件；正式资产只列出大文件，由你确认后删除。</p>
          </div>
          <button class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-xs font-semibold disabled:opacity-50" type="button" :disabled="storageBusy" @click="scanStorage">
            {{ storageBusy ? '处理中…' : storageReport ? '重新扫描' : '扫描空间' }}
          </button>
        </div>

        <div v-if="storageReport" class="mt-4 grid gap-3 sm:grid-cols-2">
          <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <span class="text-xs text-[var(--muted)]">可安全清理</span>
            <strong class="mt-1 block text-xl">{{ attachmentBytes(storageReport.safeCleanup.bytes) }}</strong>
            <span class="text-[11px] text-[var(--muted)]">{{ storageReport.safeCleanup.count }} 处中间文件或无主目录</span>
          </div>
          <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <span class="text-xs text-[var(--muted)]">大资产（20 MB 以上）</span>
            <strong class="mt-1 block text-xl">{{ storageReport.largeAssets.length }} 个</strong>
            <span class="text-[11px] text-[var(--muted)]">不会随安全清理自动删除</span>
          </div>
        </div>

        <div v-if="storageReport" class="mt-4 flex flex-wrap items-center gap-2">
          <button v-if="isAdmin" class="rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40" type="button" :disabled="storageBusy || !storageReport.safeCleanup.count" @click="cleanSafeStorage">一键安全清理</button>
          <span v-else class="text-xs text-[var(--muted)]">仅管理员可清理系统中间文件。</span>
          <span class="text-xs text-[var(--muted)]">{{ storageMessage || (storageReport.safeCleanup.count ? '清理前会再次确认' : '当前没有可安全清理的内容') }}</span>
        </div>

        <div v-if="storageReport?.largeAssets.length" class="mt-5 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div class="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <div><strong class="text-sm">占空间较大的资产</strong><span class="ml-2 text-[11px] text-[var(--muted)]">勾选后删除</span></div>
            <button class="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-600 disabled:opacity-40" type="button" :disabled="storageBusy || !selectedLargeAssets.length" @click="deleteSelectedLargeAssets">删除所选</button>
          </div>
          <label v-for="asset in storageReport.largeAssets" :key="asset.id" class="flex cursor-pointer items-center gap-3 border-b border-[var(--border)] px-4 py-3 last:border-b-0 hover:bg-[var(--surface-muted)]">
            <input v-model="selectedLargeAssets" :value="asset.id" type="checkbox" class="h-4 w-4" />
            <span class="min-w-0 flex-1"><strong class="block truncate text-sm">{{ asset.name }}</strong><span class="text-[11px] text-[var(--muted)]">{{ new Date(asset.createdAt).toLocaleDateString() }} · {{ asset.mimeType }}</span></span>
            <strong class="shrink-0 text-xs">{{ attachmentBytes(asset.sizeBytes) }}</strong>
          </label>
        </div>
      </div>
      <div class="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-5">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 class="text-[16px] font-bold">对话临时附件</h3>
            <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--muted)]">附件默认仅属于对话，不会自动进入资产库或知识库。未发送文件保留 24 小时，已发送文件保留 30 天；删除对话时同步删除。</p>
          </div>
          <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-right"><strong class="block text-sm">{{ attachmentStats ? attachmentBytes(attachmentStats.bytes) : '—' }} / {{ attachmentStats ? attachmentBytes(attachmentStats.limitBytes) : '2 GB' }}</strong><small class="text-[10px] text-[var(--muted)]">{{ attachmentStats?.count ?? 0 }} 个附件</small></div>
        </div>
        <div class="mt-4 h-2 overflow-hidden rounded-full bg-[var(--surface)]"><div class="h-full rounded-full bg-[var(--accent)] transition-all" :style="{ width: `${Math.min(100, (attachmentStats?.bytes || 0) / (attachmentStats?.limitBytes || 1) * 100)}%` }" /></div>
        <div class="mt-4 flex flex-wrap items-center gap-2"><button class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold" type="button" :disabled="attachmentCleanupBusy" @click="previewAttachmentCleanup">预览清理</button><button class="rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50" type="button" :disabled="attachmentCleanupBusy" @click="runAttachmentCleanup">清理过期附件</button><span class="text-xs text-[var(--muted)]">{{ attachmentCleanupPreview }}</span></div>
      </div>
      <PptxEnhancedSettingsCard :is-admin="isAdmin" />
      <DoclingEnhancedSettingsCard :is-admin="isAdmin" />
      <div class="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="text-[16px] font-bold">{{ t('settings.autoScheduleTitle') }}</h3>
            <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--muted)]">{{ t('settings.autoScheduleHelp') }}</p>
          </div>
          <span class="rounded-full bg-[var(--surface)] px-3 py-1 text-xs font-semibold text-[var(--muted)]">
            {{ t('settings.autoScheduleDefaultHint').replace('{n}', String(DEFAULT_AUTO_SCHEDULE_MAX_AGENTS)) }}
          </span>
        </div>
        <div class="mt-4 grid gap-3">
          <label class="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-sm">
            <input v-model="autoScheduleDraft.preferMinimal" class="mt-0.5 h-4 w-4" type="checkbox" @change="markAutoScheduleDirty" />
            <span>
              <strong class="block">{{ t('settings.autoSchedulePreferMinimal') }}</strong>
              <span class="mt-1 block text-[12px] leading-relaxed text-[var(--muted)]">{{ t('settings.autoSchedulePreferMinimalHelp') }}</span>
            </span>
          </label>
          <label class="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-sm">
            <input v-model="autoScheduleDraft.strongFitOnly" class="mt-0.5 h-4 w-4" type="checkbox" @change="markAutoScheduleDirty" />
            <span>
              <strong class="block">{{ t('settings.autoScheduleStrongFit') }}</strong>
              <span class="mt-1 block text-[12px] leading-relaxed text-[var(--muted)]">{{ t('settings.autoScheduleStrongFitHelp') }}</span>
            </span>
          </label>
          <label class="grid max-w-xs gap-2 text-sm">
            <span class="font-medium text-[var(--muted)]">{{ t('settings.autoScheduleMaxAgents') }}</span>
            <input
              v-model.number="autoScheduleDraft.maxAgents"
              type="number"
              :min="MIN_AUTO_SCHEDULE_MAX_AGENTS"
              :max="MAX_AUTO_SCHEDULE_MAX_AGENTS"
              class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm"
              @input="markAutoScheduleDirty"
            />
            <span class="text-xs leading-relaxed text-[var(--muted)]">
              {{ t('settings.autoScheduleMaxAgentsHelp')
                .replace('{min}', String(MIN_AUTO_SCHEDULE_MAX_AGENTS))
                .replace('{max}', String(MAX_AUTO_SCHEDULE_MAX_AGENTS)) }}
            </span>
          </label>
        </div>
        <div class="mt-4 flex items-center justify-between gap-3">
          <span class="text-xs text-[var(--muted)]">{{ autoScheduleDirty ? t('settings.saveHint') : t('settings.autoScheduleSaveHint') }}</span>
          <button class="rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white" type="button" @click="saveAutoScheduleSettings">
            {{ t('settings.save') }}
          </button>
        </div>
      </div>
      <div class="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="text-[16px] font-bold">执行引擎</h3>
            <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--muted)]">
              选择本机可用引擎与默认引擎。数字员工可覆盖默认。运维强制请设 <code class="rounded bg-[var(--surface)] px-1">WORKMATE_AGENT_ENGINE_FORCE=1</code> 并指定 <code class="rounded bg-[var(--surface)] px-1">WORKMATE_AGENT_ENGINE</code>。
            </p>
          </div>
        </div>
        <div class="mt-4 grid gap-3 md:grid-cols-[1fr_220px] md:items-start">
          <div class="grid gap-2">
            <span class="text-sm font-medium text-[var(--muted)]">可用引擎</span>
            <label
              v-for="item in ENGINE_OPTIONS"
              :key="item.id"
              class="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm"
            >
              <input
                type="checkbox"
                class="h-4 w-4"
                :checked="runtimeSettings.enabledEngines.includes(item.id)"
                @change="toggleEnabledEngine(item.id)"
              />
              <span>{{ item.label }}</span>
            </label>
          </div>
          <label class="grid gap-2 text-sm">
            <span class="font-medium text-[var(--muted)]">默认引擎</span>
            <select
              v-model="runtimeSettings.defaultEngine"
              class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm"
            >
              <option
                v-for="id in runtimeSettings.enabledEngines"
                :key="id"
                :value="id"
              >{{ ENGINE_OPTIONS.find((item) => item.id === id)?.label || id }}</option>
            </select>
            <span class="text-xs leading-relaxed text-[var(--muted)]">员工未指定引擎时使用此项。</span>
          </label>
        </div>
        <div class="mt-4">
          <DshRuntimeInstallCard @open-environment="emit('openEnvironment')" />
        </div>
        <div class="mt-4 flex justify-end">
          <button class="rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white" type="button" @click="saveRuntimeSettings">
            保存并立即生效
          </button>
        </div>
      </div>
      <div class="mt-5">
        <LocalEmbeddingSettingsCard />
      </div>
      <div class="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="text-[16px] font-bold">AgentScope Sidecar 并发</h3>
            <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--muted)]">
              配置单机下的 sidecar 池规模，以及每个 sidecar 同时允许承载的最大 run 数。
            </p>
          </div>
          <span class="rounded-full bg-[var(--surface)] px-3 py-1 text-xs font-semibold text-[var(--muted)]">默认池大小 1 / 单实例并发 8</span>
        </div>
        <div class="mt-4 grid gap-3 md:grid-cols-[180px_180px_1fr_auto] md:items-end">
          <label class="grid gap-2 text-sm">
            <span class="font-medium text-[var(--muted)]">Sidecar 实例数</span>
            <input
              v-model.number="runtimeSettings.sidecarPoolSize"
              type="number"
              min="1"
              max="16"
              class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm"
            />
          </label>
          <label class="grid gap-2 text-sm">
            <span class="font-medium text-[var(--muted)]">每个 Sidecar 最大并发</span>
            <input
              v-model.number="runtimeSettings.sidecarSharedMaxRuns"
              type="number"
              min="1"
              max="64"
              class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm"
            />
          </label>
          <p class="text-xs leading-relaxed text-[var(--muted)]">
            建议先从 `1-2` 个 sidecar、每个 `4-8` 并发起步。CPU、内存或工具拥堵明显时，优先增加池大小，再考虑继续拉高单实例并发。
          </p>
          <button class="rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white" type="button" @click="saveRuntimeSettings">
            保存并立即生效
          </button>
        </div>
      </div>
      <div class="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="text-[16px] font-bold">运行时并发状态</h3>
            <p class="mt-1 text-[13px] leading-relaxed text-[var(--muted)]">
              这里可以区分当前是卡在 `dispatcher`，还是卡在 shared `sidecar` 容量。
            </p>
            <p class="mt-2 text-xs text-[var(--muted)]">{{ runtimeStatusLive ? '实时流已连接' : '实时流未连接，必要时回退为轮询刷新' }}</p>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <label class="flex items-center gap-2 text-sm text-[var(--muted)]">
              <input v-model="runtimeStatusAutoRefresh" type="checkbox" class="h-4 w-4" />
              实时订阅
            </label>
            <button
              class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold"
              type="button"
              :disabled="runtimeStatusLoading"
              @click="refreshRuntimeStatus"
            >
              {{ runtimeStatusLoading ? '刷新中...' : '刷新状态' }}
            </button>
          </div>
        </div>

        <template v-if="runtimeStatus">
          <div class="mt-4 grid gap-3 md:grid-cols-2">
            <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
              <div class="flex items-center justify-between gap-3">
                <h4 class="text-sm font-bold">Dispatcher</h4>
                <span class="text-xs text-[var(--muted)]">全局 {{ runtimeStatus.dispatcher?.limits.global ?? '-' }} / 用户 {{ runtimeStatus.dispatcher?.limits.perUser ?? '-' }} / 高优先级突发 {{ runtimeStatus.dispatcher?.limits.highPriorityBurstLimit ?? '-' }}</span>
              </div>
              <div v-if="dispatcherAlerts().length" class="mt-3 flex flex-wrap gap-2">
                <span v-for="alert in dispatcherAlerts()" :key="alert.text" :class="['rounded-full border px-3 py-1 text-xs font-semibold', runtimeSeverityClass(alert.level)]">
                  {{ alert.text }}
                </span>
              </div>
              <div class="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div class="rounded-xl bg-[var(--surface)] p-3"><div class="text-xs text-[var(--muted)]">运行中</div><div class="mt-1 text-lg font-bold">{{ runtimeStatus.dispatcher?.counts.running ?? 0 }}</div></div>
                <div class="rounded-xl bg-[var(--surface)] p-3"><div class="text-xs text-[var(--muted)]">排队中</div><div class="mt-1 text-lg font-bold">{{ runtimeStatus.dispatcher?.counts.queued ?? 0 }}</div></div>
                <div class="rounded-xl bg-[var(--surface)] p-3"><div class="text-xs text-[var(--muted)]">活跃会话</div><div class="mt-1 text-lg font-bold">{{ runtimeStatus.dispatcher?.counts.activeSessions ?? 0 }}</div></div>
                <div class="rounded-xl bg-[var(--surface)] p-3"><div class="text-xs text-[var(--muted)]">活跃用户</div><div class="mt-1 text-lg font-bold">{{ runtimeStatus.dispatcher?.counts.activeUsers ?? 0 }}</div></div>
                <div class="rounded-xl bg-[var(--surface)] p-3"><div class="text-xs text-[var(--muted)]">高优先级排队</div><div class="mt-1 text-lg font-bold">{{ runtimeStatus.dispatcher?.counts.highPriorityQueued ?? 0 }}</div></div>
                <div class="rounded-xl bg-[var(--surface)] p-3"><div class="text-xs text-[var(--muted)]">普通优先级排队</div><div class="mt-1 text-lg font-bold">{{ runtimeStatus.dispatcher?.counts.normalPriorityQueued ?? 0 }}</div></div>
              </div>
            </article>

            <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
              <div class="flex items-center justify-between gap-3">
                <h4 class="text-sm font-bold">Sidecar Pool</h4>
                <span class="text-xs text-[var(--muted)]">{{ runtimeStatus.sidecar.status === 'running' ? '已启动' : '未启动' }}</span>
              </div>
              <div v-if="sidecarAlerts().length" class="mt-3 flex flex-wrap gap-2">
                <span v-for="alert in sidecarAlerts()" :key="alert.text" :class="['rounded-full border px-3 py-1 text-xs font-semibold', runtimeSeverityClass(alert.level)]">
                  {{ alert.text }}
                </span>
              </div>
              <div class="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div class="rounded-xl bg-[var(--surface)] p-3"><div class="text-xs text-[var(--muted)]">Active Runs</div><div class="mt-1 text-lg font-bold">{{ runtimeStatus.sidecar.counts.activeRuns }}</div></div>
                <div class="rounded-xl bg-[var(--surface)] p-3"><div class="text-xs text-[var(--muted)]">排队中</div><div class="mt-1 text-lg font-bold">{{ runtimeStatus.sidecar.counts.queued }}</div></div>
                <div class="rounded-xl bg-[var(--surface)] p-3"><div class="text-xs text-[var(--muted)]">池大小 / 已启动</div><div class="mt-1 text-lg font-bold">{{ runtimeStatus.sidecar.limits.poolSize }} / {{ runtimeStatus.sidecar.counts.sidecars }}</div></div>
                <div class="rounded-xl bg-[var(--surface)] p-3"><div class="text-xs text-[var(--muted)]">单实例容量上限</div><div class="mt-1 text-lg font-bold">{{ runtimeStatus.sidecar.limits.maxRuns }}</div></div>
                <div class="rounded-xl bg-[var(--surface)] p-3"><div class="text-xs text-[var(--muted)]">异常实例</div><div class="mt-1 text-lg font-bold">{{ runtimeStatus.sidecar.counts.unhealthySidecars }}</div></div>
                <div class="rounded-xl bg-[var(--surface)] p-3"><div class="text-xs text-[var(--muted)]">冷却中的实例</div><div class="mt-1 text-lg font-bold">{{ runtimeStatus.sidecar.counts.coolingSidecars }}</div></div>
                <div class="rounded-xl bg-[var(--surface)] p-3"><div class="text-xs text-[var(--muted)]">Sidecar 排队超时</div><div class="mt-1 text-lg font-bold">{{ Math.round(runtimeStatus.sidecar.limits.queueWaitMs / 1000) }}s</div></div>
                <div class="rounded-xl bg-[var(--surface)] p-3"><div class="text-xs text-[var(--muted)]">重启冷却时长</div><div class="mt-1 text-lg font-bold">{{ Math.round(runtimeStatus.sidecar.limits.restartCooldownMs / 1000) }}s</div></div>
              </div>
              <div v-if="runtimeStatus.sidecar.endpoints.length" class="mt-3 grid gap-2">
                <div v-for="endpoint in runtimeStatus.sidecar.endpoints" :key="endpoint.id" class="rounded-xl bg-[var(--surface)] px-3 py-2 text-xs text-[var(--muted)]">
                  {{ endpoint.id }} / {{ endpoint.status }} / port {{ endpoint.port }} / active {{ endpoint.activeRuns }}<span v-if="endpoint.cooldownRemainingMs"> / cooldown {{ Math.ceil(endpoint.cooldownRemainingMs / 1000) }}s</span><span v-if="endpoint.lastError"> / {{ endpoint.lastError }}</span>
                </div>
              </div>
            </article>
          </div>

          <div class="mt-4 grid gap-3 md:grid-cols-2">
            <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
              <h4 class="text-sm font-bold">Dispatcher Run 列表</h4>
              <div v-if="runtimeStatus.dispatcher?.runs.length" class="mt-3 space-y-2">
                <div v-for="item in runtimeStatus.dispatcher?.runs" :key="`dispatcher-${item.runId}`" class="rounded-xl bg-[var(--surface)] p-3 text-xs">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <strong class="text-sm">{{ item.state === 'running' ? '运行中' : '排队中' }}</strong>
                    <span class="text-[var(--muted)]">{{ item.kind }} / {{ item.priority === 'high' ? '高优先级' : '普通优先级' }} / {{ waitReasonLabel(item.waitReason) }}</span>
                  </div>
                  <div class="mt-2 break-all text-[var(--muted)]">run: {{ item.runId }}</div>
                  <div class="mt-1 text-[var(--muted)]">session: {{ item.sessionId }}</div>
                  <div class="mt-1 text-[var(--muted)]">user: {{ item.userId || '-' }}</div>
                  <div class="mt-1 text-[var(--muted)]">queuedAt: {{ formatTimestamp(item.queuedAt) }}</div>
                  <div class="mt-1 text-[var(--muted)]">排队/运行时长: {{ formatDurationFrom(item.state === 'running' ? item.startedAt || item.queuedAt : item.queuedAt) }}</div>
                </div>
              </div>
              <p v-else class="mt-3 text-sm text-[var(--muted)]">当前没有 dispatcher 层的活动 run。</p>
            </article>

            <article class="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
              <h4 class="text-sm font-bold">Sidecar Run 列表</h4>
              <div v-if="runtimeStatus.sidecar.runs.length" class="mt-3 space-y-2">
                <div v-for="item in runtimeStatus.sidecar.runs" :key="`sidecar-${item.runId}`" class="rounded-xl bg-[var(--surface)] p-3 text-xs">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <strong class="text-sm">{{ item.state === 'running' ? '运行中' : '排队中' }}</strong>
                    <span class="text-[var(--muted)]">{{ waitReasonLabel(item.waitReason) }}</span>
                  </div>
                  <div class="mt-2 break-all text-[var(--muted)]">run: {{ item.runId }}</div>
                  <div class="mt-1 text-[var(--muted)]">session: {{ item.sessionId || '-' }}</div>
                  <div class="mt-1 text-[var(--muted)]">user: {{ item.userId || '-' }}</div>
                  <div class="mt-1 text-[var(--muted)]">queuedAt: {{ formatTimestamp(item.queuedAt) }}</div>
                  <div class="mt-1 text-[var(--muted)]">排队/运行时长: {{ formatDurationFrom(item.state === 'running' ? item.startedAt || item.queuedAt : item.queuedAt) }}</div>
                </div>
              </div>
              <p v-else class="mt-3 text-sm text-[var(--muted)]">当前没有 sidecar 层的活动 run。</p>
            </article>
          </div>
        </template>

        <p v-else class="mt-4 text-sm text-[var(--muted)]">暂时无法读取运行时状态，请确认 API 已启动并已登录。</p>
      </div>
    </section>
  </section>
</template>
