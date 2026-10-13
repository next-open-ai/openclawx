<script setup lang="ts">
import { computed, defineAsyncComponent, h, onMounted, onUnmounted, ref, watch } from 'vue';
import { getHealth } from '../services/api';
import AppSidebar from './AppSidebar.vue';
import ApplicationGallery from '../features/applications/ApplicationGallery.vue';
import ChatWorkspace from '../features/chat/ChatWorkspace.vue';
import EmployeesPage from '../features/employees/EmployeesPage.vue';
import SettingsPage from '../features/settings/SettingsPage.vue';
import CapabilitiesPage from '../features/capabilities/CapabilitiesPage.vue';
import KnowledgePage from '../features/knowledge/KnowledgePage.vue';
import AssetsPage from '../features/assets/AssetsPage.vue';
import DataWorkbenchPage from '../features/data/DataWorkbenchPage.vue';
import { useWorkbenchNavigation } from '../features/data/workbench-navigation';
import AutomationsPage from '../features/automations/AutomationsPage.vue';
import ProjectsPage from '../features/projects/ProjectsPage.vue';
import { projectChatReturnTarget, type ProjectChatOrigin } from './project-chat-navigation';
import { projectTemplateReturnTarget, type ProjectTemplateOrigin } from './project-template-navigation';
import { projectDataReturnTarget, type ProjectDataOrigin } from './project-data-navigation';
import WorkflowAlgorithmPage from '../features/workflows/WorkflowAlgorithmPage.vue';
import RemoteOfficePage from '../features/remote/RemoteOfficePage.vue';
import EnvironmentPage from '../features/environment/EnvironmentPage.vue';
import { runEnvironmentCheck } from '../services/environment';
import AppToastHost from '../features/common/AppToastHost.vue';
import EnvironmentCheckDialog from '../features/common/EnvironmentCheckDialog.vue';
import ModelSetupDialog from '../features/common/ModelSetupDialog.vue';
import DshInstallProgressDialog from '../features/dsh/DshInstallProgressDialog.vue';
import {
  demoteDshEmployeesToPi,
  ensurePresetEmployeesPreferDsh,
  isDshCheckMissing,
  restoreDemotedEmployeesToDsh,
} from '../features/dsh';
import { environmentState } from '../services/environment';
import LoginPage from '../features/auth/LoginPage.vue';
import { useI18n } from './i18n';
import { useAuth } from './auth';
import { useWorkspace } from './workspace';
import { useModelConfig, analyzeModelSetup, type ModelSetupGapId } from './model-config';
import { useTheme } from './theme';
import { readStored, writeStored } from './storage';
import { useCapabilities } from './capabilities';
import { useAutomations, type Automation } from './automations';
import { useEmployeeRuntimePrefs } from './employee-prefs';
import { useSearchConfig } from './search-config';
import { useMcpConfig } from './mcp-config';
import { useNotify } from './notify';
import { isDesktopShell, isViewAvailable } from './platform';
import type { View } from './workspace';

const DocsPage = defineAsyncComponent({
  loader: () => import('../features/docs/DocsPage.vue'),
  delay: 0,
  loadingComponent: () => h('section', { class: 'grid h-full place-items-center bg-[var(--background)] text-sm text-[var(--muted)]' }, [
    h('div', { class: 'grid justify-items-center gap-3' }, [
      h('span', { class: 'h-7 w-7 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]' }),
      h('span', '正在加载用户手册…'),
    ]),
  ]),
  errorComponent: () => h('section', { class: 'grid h-full place-items-center bg-[var(--background)] px-6 text-center' }, [
    h('div', [
      h('p', { class: 'font-semibold text-[var(--text)]' }, '用户手册加载失败'),
      h('p', { class: 'mt-2 text-sm text-[var(--muted)]' }, '请重新进入用户手册；如果问题持续，请重启应用。'),
    ]),
  ]),
  timeout: 15_000,
});

const { t, loadLocale } = useI18n();
const {
  user,
  ready: authReady,
  needsSetup,
  bootstrapOrgId,
  users: localUsers,
  isAdmin,
  load: loadAuth,
  login,
  setupFirstAdmin,
  logout,
  createUser,
  updateUser,
  deleteUser,
} = useAuth();
const { employees, view, currentEmployeeId, currentEmployee, conversations, activeConversation, permissionTier, load: loadWorkspace, setView, startChat, startChatWithPrompt, selectConversation, selectEmployee, setDefaultEmployee, setPermissionTier, clearConversation, deleteConversation, addMessage, abortActiveRun, runAutomation, runProjectTask, generateProjectDraft, approveAndRetry, createEmployee, updateEmployee, removeEmployee, resetEmployee, hasEmployeeOverride, ensureActiveServerSession, pullActiveConversationFromServer, followMobileChatSession } = useWorkspace();
const serviceReady = ref(false);
const dataNavigationScope = computed(() => user.value ? `${user.value.orgId}:${user.value.id}` : '');
const { navigation: dataNavigation, remember: rememberDataNavigation } = useWorkbenchNavigation(dataNavigationScope);
// Navigation hides the existing chat instead of destroying active audio sessions.
const chatMounted = ref(false);
const voiceActive = ref(false);
watch([view, user], () => {
  if (!user.value) { chatMounted.value = false; voiceActive.value = false; }
  else if (view.value === 'chat') chatMounted.value = true;
}, { immediate: true });
const sidebarCollapsed = ref(false);
const authBusy = ref(false);
const { loadTheme } = useTheme();
const { activeConfig: modelConfig, settings: modelSettings, availableChatModels, configured, load: loadModelConfig, selectChatEndpoint, chatEndpointToken, modelForProvider, modelById } = useModelConfig();
const { load: loadCapabilities } = useCapabilities();
const { load: loadAutomations, startScheduler } = useAutomations();
const { load: loadEmployeePrefs } = useEmployeeRuntimePrefs();
const { load: loadSearchConfig } = useSearchConfig();
const { load: loadMcpConfig, probeStartupMcps } = useMcpConfig();
const notify = useNotify();
const showEnvCheckDialog = ref(false);
const showDshInstallDialog = ref(false);
const showModelSetupDialog = ref(false);
const modelSetupGaps = ref<ModelSetupGapId[]>([]);
/** 启动引导弹窗「去配置」跳转设置页时指定的初始 tab。 */
const settingsFocusTab = ref<'providers' | 'models' | null>(null);
/** 打开「用户手册」时定位到的章节锚点，DocsPage 消费后清空。 */
const docsAnchor = ref<string | null>(null);
const envReturnView = ref<View>('settings');
const activeChatEmployee = computed(() =>
  (activeConversation.value && employees.value.find((item) => item.id === activeConversation.value?.employeeId))
  || currentEmployee.value,
);
let stopScheduler: (() => void) | undefined;
let initialized = false;

watch(() => user.value?.id ?? null, async (next, prev) => {
  if (!next && prev) {
    stopScheduler?.();
    stopScheduler = undefined;
    initialized = false;
    return;
  }
  if (next && next !== prev) {
    stopScheduler?.();
    stopScheduler = undefined;
    initialized = false;
    await initializeWorkspace();
  }
});

async function initializeWorkspace() {
  if (initialized || !user.value) return;
  initialized = true;
  await Promise.all([
    loadModelConfig(),
    loadWorkspace(),
    loadTheme(),
    loadLocale(),
    loadCapabilities(),
    loadAutomations(),
    loadEmployeePrefs(),
    loadSearchConfig(),
    loadMcpConfig(),
  ]);
  stopScheduler = startScheduler(runScheduledAutomation);
  sidebarCollapsed.value = (await readStored('ui.sidebar-collapsed')) === 'true';
  if (!isViewAvailable(view.value)) setView('chat');
  try {
    await getHealth();
    serviceReady.value = true;
    void probeStartupMcps()
      .then((summary) => {
        if (summary.total > 0) {
          notify.info(
            'capabilities.mcpStartupProbeTitle',
            t('capabilities.mcpStartupProbe', {
              total: summary.total,
              passed: summary.passed,
              failed: summary.failed,
            }),
          );
        }
      })
      .catch(() => undefined);
  } catch {
    serviceReady.value = false;
  }
  void setupEnvironmentCheck();
  void setupModelPrompt();
}
const runScheduledAutomation = async (automation: Automation) => {
  const model = (automation.modelId ? modelById(automation.modelId) : undefined) ?? modelForProvider(automation.provider);
  if (!model) {
    const message = notify.errorMessage('model missing');
    notify.error(new Error(message));
    throw new Error(message);
  }
  return runAutomation(automation, model);
};
const projectChatOrigin = ref<ProjectChatOrigin | null>(null);
const projectDataOrigin = ref<ProjectDataOrigin | null>(null);
watch(dataNavigationScope, () => { projectDataOrigin.value = null; }, { flush: 'sync' });
watch(view, (next, previous) => { if (previous === 'projects' && next !== 'projects') projectDataOrigin.value = null; });
async function openProjectFromData(projectId: string, startError?: string) {
  const scope = dataNavigationScope.value, navigation = dataNavigation.value;
  await writeStored('projects.focus-id', projectId);
  if (!scope || scope !== dataNavigationScope.value) return;
  projectChatOrigin.value = null; projectTemplateOrigin.value = null;
  projectDataOrigin.value = navigation?.sourceId ? { projectId, scope, navigation: { ...navigation, tab: 'apps' } } : null;
  if (startError) notify.error(new Error(`应用已准备，启动未完成：${startError}。请在原项目继续。`));
  setView('projects');
}
function returnToProjectData(projectId: string) {
  const target = projectDataReturnTarget(projectDataOrigin.value, projectId, dataNavigationScope.value);
  if (!target) return;
  rememberDataNavigation(target, dataNavigationScope.value);
  projectDataOrigin.value = null;
  setView('data');
}
const projectTemplateOrigin = ref<ProjectTemplateOrigin | null>(null);
const returnDefinitionId = ref<string>();
const returnTemplateProjectId=ref<string>();
watch(view, (next, previous) => {
  if (previous === 'projects' && next !== 'projects') projectTemplateOrigin.value = null;
  if (previous === 'automations' && next !== 'automations') {returnDefinitionId.value = undefined;returnTemplateProjectId.value=undefined;}
});
watch(() => user.value?.id, () => { projectTemplateOrigin.value = null; returnDefinitionId.value = undefined;returnTemplateProjectId.value=undefined; });
watch(view, (next, previous) => { if (previous === 'projects' && next !== 'projects') projectChatOrigin.value = null; });
watch(() => user.value?.id, () => { projectChatOrigin.value = null; });
async function openProjectFromChat(projectId: string) {
  projectDataOrigin.value = null;
  projectTemplateOrigin.value = null;
  const conversationId = activeConversation.value?.id;
  const userId = user.value?.id;
  await writeStored('projects.focus-id', projectId);
  if (!userId || user.value?.id !== userId) return;
  projectChatOrigin.value = conversationId ? { projectId, conversationId, userId } : null;
  setView('projects');
}
function returnToProjectChat() {
  const origin = projectChatOrigin.value;
  const target = projectChatReturnTarget(origin, origin?.projectId ?? '', user.value?.id, conversations.value);
  if (target) selectConversation(target);
  projectChatOrigin.value = null;
  setView('chat');
}
async function openProjectFromAssets(projectId: string) {
  projectDataOrigin.value = null;
  projectChatOrigin.value = null;
  projectTemplateOrigin.value = null;
  await writeStored('projects.focus-id', projectId);
  setView('projects');
}
async function openProjectFromTemplate(projectId: string, definitionId: string) {
  projectDataOrigin.value = null;
  const userId = user.value?.id;
  await writeStored('projects.focus-id', projectId);
  if (!userId || user.value?.id !== userId) return;
  projectChatOrigin.value = null;
  projectTemplateOrigin.value = { projectId, definitionId, userId };
  setView('projects');
}
function returnToProjectTemplate(projectId: string) {
  const target = projectTemplateReturnTarget(projectTemplateOrigin.value, projectId, user.value?.id);
  if (!target) return;
  returnDefinitionId.value = target;
  returnTemplateProjectId.value=projectId;
  projectTemplateOrigin.value = null;
  setView('automations');
}
onMounted(async () => {
  await Promise.all([loadTheme(), loadLocale()]);
  try {
    await getHealth();
    serviceReady.value = true;
  } catch {
    serviceReady.value = false;
  }
  await loadAuth();
  await initializeWorkspace();
});
/** 打开带实时进度的环境检查弹窗并执行。keepOpenOnClean=true 时即使全部通过也保留结果。 */
async function runCheckInDialog(keepOpenOnClean: boolean) {
  showEnvCheckDialog.value = true;
  const report = await runEnvironmentCheck();
  if (!keepOpenOnClean && report && report.summary.error === 0 && report.summary.warn === 0) {
    setTimeout(() => { showEnvCheckDialog.value = false; }, 900);
  }
  return report;
}

async function setupEnvironmentCheck() {
  try {
    const firstRun = !(await readStored('env.first-run-done'));
    if (firstRun) await writeStored('env.first-run-done', '1');
    const stored = await readStored('env.check-on-startup');
    const startupEnabled = stored === '1';

    // Probe once; if dsh is missing, ask the user before downloading ~200MB.
    const report = await runEnvironmentCheck();
    if (isDshCheckMissing(report)) {
      await demoteDshEmployeesToPi().catch(() => undefined);
      const declinedAt = Number((await readStored('dsh.install-prompt.declined-at')) || '0');
      const recentlyDeclined = Number.isFinite(declinedAt) && declinedAt > 0
        && (Date.now() - declinedAt) < 7 * 24 * 60 * 60 * 1000;
      if (!recentlyDeclined) {
        showDshInstallDialog.value = true;
      }
    } else {
      await ensurePresetEmployeesPreferDsh().catch(() => undefined);
      await restoreDemotedEmployeesToDsh().catch(() => undefined);
    }

    if (!firstRun && !startupEnabled) return;
    const latest = environmentState.report.value || report;
    if (latest && (latest.summary.error > 0 || latest.summary.warn > 0) && !showDshInstallDialog.value) {
      showEnvCheckDialog.value = true;
    }
  } catch { /* 环境检查失败不应阻塞启动 */ }
}
function openEnvironmentPage() {
  if (view.value !== 'env') envReturnView.value = view.value;
  setView('env');
}

/**
 * 启动引导：检测到没有可用的对话模型时，弹出专业配置指引。
 * 「以后再说」会静默 7 天，避免每次启动都打扰。
 */
async function setupModelPrompt() {
  try {
    const declinedAt = Number((await readStored('model.setup-prompt.declined-at')) || '0');
    const recentlyDeclined = Number.isFinite(declinedAt) && declinedAt > 0
      && (Date.now() - declinedAt) < 7 * 24 * 60 * 60 * 1000;
    if (recentlyDeclined) return;
    const gaps = analyzeModelSetup(modelSettings.value);
    if (!gaps.length) return;
    modelSetupGaps.value = gaps;
    showModelSetupDialog.value = true;
  } catch { /* 引导提示失败不应阻塞启动 */ }
}

function dismissModelSetup() {
  showModelSetupDialog.value = false;
  void writeStored('model.setup-prompt.declined-at', String(Date.now()));
}

function goModelSetup(tab: 'providers' | 'models') {
  showModelSetupDialog.value = false;
  settingsFocusTab.value = tab;
  setView('settings');
}

/** 启动引导弹窗「查看手册」：打开用户手册并定位到模型配置章节。 */
function openManualFromModelSetup() {
  showModelSetupDialog.value = false;
  docsAnchor.value = 'model-config';
  setView('docs');
}

function closeEnvironmentPage() {
  const target = envReturnView.value !== 'env' && isViewAvailable(envReturnView.value)
    ? envReturnView.value
    : 'settings';
  setView(isViewAvailable(target) ? target : 'chat');
}

async function openVoiceWork(conversationId: string, title: string) {
  await followMobileChatSession(conversationId, title);
  setView('chat');
}

function openEnvDetails() {
  showEnvCheckDialog.value = false;
  openEnvironmentPage();
}
onUnmounted(() => stopScheduler?.());
function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value; void writeStored('ui.sidebar-collapsed', String(sidebarCollapsed.value)); }
async function handleLogin(payload: { username: string; password: string }) {
  authBusy.value = true;
  try {
    await login(payload);
    await initializeWorkspace();
    notify.success('notify.saved', '登录成功');
  } catch (cause) {
    notify.error(cause, '登录失败');
  } finally {
    authBusy.value = false;
  }
}
async function handleBootstrap(payload: { orgId: string; username: string; displayName: string; password: string }) {
  authBusy.value = true;
  try {
    await setupFirstAdmin(payload);
    await initializeWorkspace();
    notify.success('notify.saved', '初始化完成');
  } catch (cause) {
    notify.error(cause, '初始化失败');
  } finally {
    authBusy.value = false;
  }
}
async function handleCreateLocalUser(payload: { username: string; displayName: string; password: string; role: 'admin' | 'member' }) {
  authBusy.value = true;
  try {
    await createUser(payload);
    notify.success('notify.saved', '已新增本地用户');
  } catch (cause) {
    notify.error(cause, '新增用户失败');
  } finally {
    authBusy.value = false;
  }
}
async function handleUpdateLocalUser(payload: { userId: string; displayName?: string; password?: string; role?: 'admin' | 'member'; disabled?: boolean }) {
  authBusy.value = true;
  try {
    await updateUser(payload.userId, payload);
    notify.success('notify.saved', '用户已更新');
  } catch (cause) {
    notify.error(cause, '更新用户失败');
  } finally {
    authBusy.value = false;
  }
}
async function handleDeleteLocalUser(userId: string) {
  authBusy.value = true;
  try {
    await deleteUser(userId);
    notify.success('notify.saved', '用户已删除');
  } catch (cause) {
    notify.error(cause, '删除用户失败');
  } finally {
    authBusy.value = false;
  }
}
async function handleLogout() {
  authBusy.value = true;
  try {
    stopScheduler?.();
    stopScheduler = undefined;
    initialized = false;
    await logout();
    notify.success('notify.saved', '已退出登录');
  } catch (cause) {
    notify.error(cause, '退出登录失败');
  } finally {
    authBusy.value = false;
  }
}
const galleryOpen = ref(false);
watch(user, () => { galleryOpen.value=false; });
</script>

<template>
  <LoginPage
    v-if="authReady && !user"
    :needs-setup="needsSetup"
    :org-id="bootstrapOrgId"
    :busy="authBusy"
    @login="handleLogin"
    @bootstrap="handleBootstrap"
  />
  <div v-else-if="!authReady" class="grid h-screen place-items-center bg-[var(--background)] text-sm text-[var(--muted)]">正在恢复登录状态…</div>
  <div v-else class="flex h-screen min-h-[600px] overflow-hidden bg-[var(--background)] text-[var(--text)]">
    <AppSidebar :collapsed="sidebarCollapsed" :view="view" :conversations="conversations" :active-conversation-id="activeConversation?.id ?? null" :service-ready="serviceReady" :current-user="user" @open-applications="galleryOpen = true" @toggle="toggleSidebar" @navigate="setView" @new-chat="startChat()" @select-conversation="selectConversation" @delete-conversation="deleteConversation" @logout="handleLogout" />
    <main :class="['relative min-w-0 flex-1 bg-[var(--background)]', view === 'chat' || view === 'capabilities' || view === 'knowledge' || view === 'assets' || view === 'data' || view === 'automations' || view === 'projects' ? 'overflow-hidden' : 'overflow-auto']">
      <ChatWorkspace v-if="chatMounted" v-show="view === 'chat'" :visible="view === 'chat'" :employee="activeChatEmployee" :selected-employee-id="activeConversation?.employeeId || currentEmployeeId" :employees="employees" :conversation="activeConversation" :model-configured="configured" :model="modelConfig" :available-models="availableChatModels" :chat-endpoint-token="chatEndpointToken" :permission-tier="permissionTier" :send-message="async (content, collaboratorIds, collaborationDelivery, onlineSearch, autoSchedule, attachments, fileAttachments, onRunAccepted, workflowResult) => { await addMessage(content, modelConfig, { collaboratorIds, collaborationDelivery, onlineSearch, autoSchedule, attachments, fileAttachments, onRunAccepted, workflowResult }); }" :abort-message="() => { abortActiveRun(); }" :approve="(conversationId, approval, scope) => approveAndRetry(conversationId, approval, scope, modelConfig)" :ensure-server-session="ensureActiveServerSession" :pull-from-server="pullActiveConversationFromServer" :follow-mobile-session="followMobileChatSession" @voice-active="voiceActive = $event" @select-endpoint="selectChatEndpoint" @select-employee="startChat" @set-permission-tier="setPermissionTier" @clear-conversation="clearConversation" @open-assets="setView('assets')" @open-data="setView('data')" @open-settings="setView('settings')" @open-project="openProjectFromChat" @open-workflows="setView('workflows')" />
      <EmployeesPage
        v-if="view === 'employees'"
        :employees="employees"
        :selected-employee-id="currentEmployeeId"
        :create-employee="createEmployee"
        :update-employee="updateEmployee"
        :remove-employee="removeEmployee"
        :reset-employee="resetEmployee"
        :has-employee-override="hasEmployeeOverride"
        @start-chat="startChat"
      />
      <CapabilitiesPage v-else-if="view === 'capabilities'" />
      <KnowledgePage v-else-if="view === 'knowledge'" :is-admin="isAdmin" @open-settings="setView('settings')" />
      <AssetsPage v-else-if="view === 'assets'" :conversations="conversations" @open-conversation="(id) => { selectConversation(id); setView('chat'); }" @open-project="openProjectFromAssets" @open-data="setView('data')" />
      <DataWorkbenchPage
        v-else-if="view === 'data'"
        :key="dataNavigationScope"
        :navigation="dataNavigation"
        :navigation-scope="dataNavigationScope"
        :employee-id="currentEmployeeId"
        :permission-tier="permissionTier"
        @remember-navigation="rememberDataNavigation"
        @start-chat="startChat"
        @open-project="openProjectFromData"
      />
      <AutomationsPage
        v-else-if="view === 'automations'"
        :employees="employees"
        :models="availableChatModels"
        :conversations="conversations"
        :run-automation="runScheduledAutomation"
        :return-definition-id="returnDefinitionId"
        :return-project-id="returnTemplateProjectId"
        @open-project="openProjectFromTemplate"
        :open-conversation="async (id) => { await followMobileChatSession(id); setView('chat'); }"
      />
      <ProjectsPage v-else-if="view === 'projects'" :employees="employees" :models="availableChatModels" :generate-draft="generateProjectDraft" :run-task="runProjectTask" :return-to-data-project-id="projectDataOrigin?.projectId" :return-to-chat-project-id="projectChatOrigin?.projectId" :return-to-template-project-id="projectTemplateOrigin?.projectId" @return-to-data="returnToProjectData" @return-to-template="returnToProjectTemplate" @return-to-chat="returnToProjectChat" @open-workflows="setView('workflows')" />
      <WorkflowAlgorithmPage v-else-if="view === 'workflows' || view === 'algorithms'" :key="`${dataNavigationScope}:${view}`" :mode="view" :employees="employees" :models="availableChatModels" :generate-draft="generateProjectDraft" @open-project="openProjectFromAssets" @open-skills="setView('capabilities')" />
      <RemoteOfficePage v-else-if="view === 'remote'" />
      <EnvironmentPage v-else-if="view === 'env'" @close="closeEnvironmentPage" @back="closeEnvironmentPage" />
      <DocsPage v-else-if="view === 'docs'" :anchor="docsAnchor" @anchor-consumed="docsAnchor = null" />
      <SettingsPage
        v-else-if="view === 'settings'"
        :employees="employees"
        :default-employee-id="currentEmployeeId"
        :current-user="user"
        :local-users="localUsers"
        :is-admin="isAdmin"
        :auth-busy="authBusy"
        :focus-tab="settingsFocusTab"
        :ensure-voice-conversation="ensureActiveServerSession"
        @set-default-employee="setDefaultEmployee"
        @open-environment="openEnvironmentPage"
        @open-check="runCheckInDialog(true)"
        @create-local-user="handleCreateLocalUser"
        @update-local-user="handleUpdateLocalUser"
        @delete-local-user="handleDeleteLocalUser"
        @focus-consumed="settingsFocusTab = null"
        @open-work="openVoiceWork"
      />
      <button v-if="voiceActive && view !== 'chat'" type="button" class="fixed bottom-5 right-6 z-40 rounded-full border border-[var(--accent)]/30 bg-[var(--surface)] px-4 py-2 text-xs text-[var(--accent)] shadow-lg" @click="setView('chat')">● 语音进行中 · 返回对话</button>
    </main>
    <AppToastHost />
    <ApplicationGallery v-if="galleryOpen" @close="galleryOpen = false" />
    <EnvironmentCheckDialog v-if="showEnvCheckDialog" @close="showEnvCheckDialog = false" @go="openEnvDetails" />
    <ModelSetupDialog v-if="showModelSetupDialog" :gaps="modelSetupGaps" @close="dismissModelSetup" @go="goModelSetup" @manual="openManualFromModelSetup" />
    <DshInstallProgressDialog
      v-if="showDshInstallDialog"
      @close="showDshInstallDialog = false"
      @installed="void writeStored('dsh.install-prompt.declined-at', '')"
    />
    <p class="sr-only" role="status">{{ serviceReady ? t('common.statusReady') : t('common.statusOffline') }}</p>
  </div>
</template>
