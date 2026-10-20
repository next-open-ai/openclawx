<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  CollaborationDelivery,
  CollaborationRun,
  Conversation,
  Employee,
  EmployeeId,
  Message,
} from "../../app/workspace";
import ChatReplyPending from "./ChatReplyPending.vue";
import ChatWorkflowPanel from '../workflows/ChatWorkflowPanel.vue';
import WorkflowResultQuestion from '../workflows/WorkflowResultQuestion.vue';
import ChatImagePreview from './ChatImagePreview.vue';
import ChatAssetMediaPreview from './ChatAssetMediaPreview.vue';
import type { ChatFileAttachment, ChatImageAttachment, DurableTask, VoiceWorkResult } from '@openclawx/contracts';
import { deleteChatFile, sessionDurableTasks, updateDurableTaskStatus, uploadChatFile, uploadChatImage } from '../../services/orchestration';
import ChatAutoScheduleRail from "./ChatAutoScheduleRail.vue";
import { useModelConfig, type ProviderConfig } from "../../app/model-config";
import type { ToolActivity, ToolApproval } from "../../services/api";
import type { ExecutionLevel } from "../../app/capabilities";
import { useCapabilities } from "../../app/capabilities";
import { useEmployeeRuntimePrefs } from "../../app/employee-prefs";
import { useMcpConfig, isAssociableMcp } from "../../app/mcp-config";
import type { Asset } from "../../app/assets";
import { downloadAssetBestEffort, previewAssetUrl } from "../../app/platform-actions.js";
import { useI18n } from "../../app/i18n";
import { useNotify } from "../../app/notify";
import { employeeDisplayDescription, employeeDisplayName } from "../../app/employees";
import { getServerRuntimeConfig, createMobileChatSession, getMobileChatSession, importChatAttachmentToAssets, importDataFromAsset } from "../../services/api";
import { chatBusy } from "../../app/workspace";
import { qrDataUrl } from "../../app/qr-data-url.js";
import { markdownToHtml } from "../../app/project-files";
import { shouldPollServerMirror } from '../../app/chat-run-timing.js';
import RealtimeVoiceDialog from './RealtimeVoiceDialog.vue';
import VoiceInputDialog from './VoiceInputDialog.vue';
import { realtimeVoiceCapabilities } from '../../services/realtime-voice';
import { VoiceDraftProjection, mergeVoiceCaption, type VoiceCaption } from './voice-presentation';
import { VoiceCommandCandidate } from './voice-command';
import { VoiceNoticePlayer, VoiceTaskMonitor, VOICE_NOTICE_TEXT } from '../../services/voice-task-notices';
import { readStored, writeStored } from '../../app/storage';

const chatWorkflowPanel = ref<InstanceType<typeof ChatWorkflowPanel>>();
const resultQuestion = ref<InstanceType<typeof WorkflowResultQuestion>>();
const resultEvidence = ref<import('@openclawx/contracts').WorkflowResultEvidence | null>(null);
function resultChanged(value: import('@openclawx/contracts').WorkflowResultEvidence | null) {
  resultEvidence.value = value;
  if (value) { autoSchedule.value = false; collaboratorIds.value = []; collaboratorMenuOpen.value = false; attachmentMenuOpen.value = false; void nextTick(() => document.querySelector<HTMLTextAreaElement>('[aria-label="对话输入框"]')?.focus()); }
}

type EngineId = "pi" | "agentscope" | "dsh";
function isEngineId(value: unknown): value is EngineId {
  return value === "pi" || value === "agentscope" || value === "dsh";
}

const props = defineProps<{
  employee: Employee;
  selectedEmployeeId: EmployeeId;
  employees: Employee[];
  conversation: Conversation | null;
  modelConfigured: boolean;
  model: ProviderConfig;
  availableModels: ProviderConfig[];
  chatEndpointToken: string;
  permissionTier: ExecutionLevel;
  sendMessage: (
    content: string,
    collaboratorIds?: EmployeeId[],
    collaborationDelivery?: CollaborationDelivery,
    onlineSearch?: boolean,
    autoSchedule?: boolean,
    attachments?: ChatImageAttachment[],
    fileAttachments?: ChatFileAttachment[],
    onRunAccepted?: (sessionId: string, runId: string) => void,
    workflowResult?: import('@openclawx/contracts').WorkflowResultReference,
  ) => Promise<void>;
  abortMessage?: () => void;
  approve: (
    conversationId: string,
    approval: ToolApproval,
    scope: "session" | "always",
  ) => Promise<void>;
  ensureServerSession?: () => Promise<string | null>;
  pullFromServer?: () => Promise<void>;
  followMobileSession?: (sessionId: string, title?: string) => Promise<unknown>;
  visible?: boolean;
}>();
const emit = defineEmits<{
  selectEmployee: [id: EmployeeId];
  selectEndpoint: [token: string];
  setPermissionTier: [tier: ExecutionLevel];
  clearConversation: [id: string];
  openAssets: [];
  openData: [];
  openSettings: [];
  openProject: [id: string];
  openWorkflows: [];
  voiceActive: [active: boolean];
}>();

const { t } = useI18n();
const notify = useNotify();
const draft = ref("");
const menuOpen = ref(false);
const collaboratorMenuOpen = ref(false);
const collaboratorIds = ref<EmployeeId[]>([]);
const mentionMenuOpen = ref(false);
const mentionActiveIndex = ref(0);
const collaborationDelivery = ref<CollaborationDelivery>("direct");
const onlineSearch = ref(true);
const autoSchedule = ref(false);
const sending = ref(false);
const uploadingRecording = ref(false);
const realtimeVoiceOpen = ref(false);
const voiceConversationId = ref<string>();
let voiceRefreshTimer: ReturnType<typeof setInterval> | undefined;
let voiceRefreshing = false;
async function refreshVoiceConversation() {
  if (voiceRefreshing || props.conversation?.serverSessionId !== voiceConversationId.value) return;
  voiceRefreshing = true;
  try { await props.pullFromServer?.(); }
  catch (cause) { notify.error(cause); }
  finally { voiceRefreshing = false; }
}
async function closeRealtimeVoice() {
  realtimeVoiceOpen.value = false;
  voiceCaptions.value = [];
  await refreshVoiceConversation();
}
const activeVoiceWork = ref<VoiceWorkResult | null>(null);
const voiceWorkBusy = computed(() => {
  const status = activeVoiceWork.value?.status;
  return status === 'accepted' || status === 'queued' || status === 'running' || status === 'waiting-approval' || status === 'cancellation_requested';
});
async function voiceWorkUpdated(result: VoiceWorkResult) {
  const id = result.conversationId;
  if (!id) return;
  activeVoiceWork.value = result;
  if (props.conversation?.serverSessionId !== id) await props.followMobileSession?.(id, result.title || '语音工作');
  await refreshVoiceConversation();
}
const voiceInputOpen = ref(false);
const voiceInputBusy = ref(false);
const voiceProjection = new VoiceDraftProjection();
const voiceCaptions = ref<VoiceCaption[]>([]);
const voiceMode = ref<'input' | 'realtime'>('realtime');
const voiceOpening = ref(false);
const voiceCommandEnabled = ref(false);
const voiceNoticeEnabled = ref(true);
const voiceCommandPending = ref(false);
const voiceNoticePlayer = new VoiceNoticePlayer(() => notify.info('语音播放不可用，请查看任务通知。'));
const voiceTaskMonitor = new VoiceTaskMonitor(notice => {
  notify.info(VOICE_NOTICE_TEXT[notice]);
  if (notice === 'completed') voiceNoticePlayer.speak(VOICE_NOTICE_TEXT.completed, 'completed');
  else voiceNoticePlayer.enqueue(notice);
});
const voiceCommandCandidate = new VoiceCommandCandidate(active => { voiceCommandPending.value = active; }, () => {
  if (canExecuteVoiceCommand()) void submit();
});
function canExecuteVoiceCommand() {
  return voiceCommandEnabled.value && voiceInputOpen.value && !inputBusy.value && props.modelConfigured
    && props.visible !== false && !autoSchedule.value && !collaboratorIds.value.length;
}
function cancelVoiceCommand() { voiceCommandCandidate.cancel(draft.value); }
function beginVoiceInput() { voiceCommandCandidate.reset(); voiceProjection.begin(draft.value); }
watch([voiceCommandEnabled, voiceNoticeEnabled], () => {
  voiceCommandCandidate.cancel(); voiceNoticePlayer.setEnabled(voiceNoticeEnabled.value);
  void writeStored('voice.command-ui.v1', JSON.stringify({ execute: voiceCommandEnabled.value, notices: voiceNoticeEnabled.value })).catch(() => undefined);
});
watch([voiceInputOpen, realtimeVoiceOpen], () => voiceNoticePlayer.setListening(voiceInputOpen.value || realtimeVoiceOpen.value));
watch(() => props.visible, visible => { if (visible === false) voiceCommandCandidate.cancel(); });
onMounted(() => {
  void readStored('voice.command-ui.v1').then(raw => {
    if (!raw) return;
    try { const value = JSON.parse(raw); voiceCommandEnabled.value = value.execute === true; voiceNoticeEnabled.value = value.notices !== false; } catch { /* Defaults for invalid UI preferences. */ }
  });
});
let voiceOpenGeneration = 0;
watch([voiceOpening, voiceInputOpen, realtimeVoiceOpen], () => {
  emit('voiceActive', voiceOpening.value || voiceInputOpen.value || realtimeVoiceOpen.value);
});
async function toggleVoice() {
  voiceNoticePlayer.unlock();
  if (voiceOpening.value) { voiceOpenGeneration++; voiceOpening.value = false; return; }
  if (voiceInputOpen.value) { closeVoiceInput(); return; }
  if (realtimeVoiceOpen.value) { await closeRealtimeVoice(); return; }
  await openVoice(voiceMode.value);
}
async function openVoice(selectedMode?: 'input' | 'realtime') {
  if (voiceOpening.value || realtimeVoiceOpen.value || voiceInputOpen.value) return;
  const token = ++voiceOpenGeneration;
  voiceOpening.value = true;
  try {
    const capabilities = await realtimeVoiceCapabilities();
    if (token !== voiceOpenGeneration) return;
    voiceMode.value = selectedMode || capabilities.voiceMode || 'realtime';
    if (voiceMode.value === 'input') {
      voiceProjection.begin(draft.value); voiceInputOpen.value = true;
    }
    else {
      const id = await props.ensureServerSession?.();
      if (token !== voiceOpenGeneration) return;
      if (props.conversation?.serverSessionId && props.conversation.serverSessionId !== id) return;
      if (!id) throw new Error('无法关联当前对话，请先创建对话后重试。');
      voiceConversationId.value = id;
      realtimeVoiceOpen.value = true;
      clearInterval(voiceRefreshTimer);
      voiceRefreshTimer = setInterval(() => { void refreshVoiceConversation(); }, 1500);
    }
  } catch (cause) { if (token === voiceOpenGeneration) notify.error(cause instanceof Error ? cause.message : '无法读取语音配置'); }
  finally { if (token === voiceOpenGeneration) voiceOpening.value = false; }
}
function previewVoiceText(text: string) {
  if (voiceInputOpen.value) {
    draft.value = voiceProjection.update(draft.value, text);
    voiceCommandCandidate.update(draft.value, canExecuteVoiceCommand());
  }
}
function closeVoiceInput() { voiceCommandCandidate.cancel(); voiceInputOpen.value = false; voiceInputBusy.value = false; }
function updateVoiceCaption(caption: VoiceCaption) {
  if (realtimeVoiceOpen.value) voiceCaptions.value = mergeVoiceCaption(voiceCaptions.value, caption);
}
watch(() => props.conversation?.id, (_id, previousId) => {
  // ensureServerSession may create the very first foreground conversation.
  if (!previousId && voiceOpening.value && voiceMode.value === 'realtime') return;
  voiceOpenGeneration++; voiceOpening.value = false;
  closeVoiceInput(); voiceCaptions.value = [];
  clearInterval(voiceRefreshTimer); voiceRefreshTimer = undefined;
  if (realtimeVoiceOpen.value) void closeRealtimeVoice();
});
onBeforeUnmount(() => { voiceOpenGeneration++; voiceCommandCandidate.cancel(); voiceTaskMonitor.dispose(); voiceNoticePlayer.stop(); clearInterval(voiceRefreshTimer); emit('voiceActive', false); });
const recordingInput = ref<HTMLInputElement | null>(null);
const recording = ref<{ reference: string; name: string; size: number } | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);
const images = ref<ChatImageAttachment[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const files = ref<ChatFileAttachment[]>([]);
const uploadingFiles = ref(false);
const attachmentMenuOpen = ref(false);
const uploadingImages = ref(false);
const durableTasks = ref<DurableTask[]>([]);
const activeDurableTaskId = ref<string | null>(null);
const activeDurableTask = computed(() => durableTasks.value.find((item) => item.id === activeDurableTaskId.value && !['completed', 'cancelled'].includes(item.status)) ?? null);
const durableTaskStatusLabel = (status: DurableTask['status']) => ({ running: '执行中', waiting_user: '等待确认', waiting_external: '等待外部条件', paused: '已暂停', completed: '已完成', failed: '需处理', cancelled: '已取消' }[status]);
const durableTaskTone = computed(() => {
  const status = activeDurableTask.value?.status;
  if (status === 'running') return 'bg-emerald-500';
  if (status === 'failed') return 'bg-rose-500';
  if (status === 'waiting_user' || status === 'waiting_external') return 'bg-amber-500';
  return 'bg-[var(--accent)]';
});
const activeDurableTaskMessageId = computed(() => {
  const taskId = activeDurableTask.value?.id;
  if (!taskId) return '';
  return [...(props.conversation?.messages ?? [])].reverse()
    .find((message) => message.role === 'assistant' && message.durableTaskId === taskId)?.id ?? '';
});
async function refreshDurableTasks() {
  const sessionId = props.conversation?.serverSessionId;
  if (!sessionId) { durableTasks.value = []; activeDurableTaskId.value = null; return; }
  const result = await sessionDurableTasks(sessionId).catch(() => ({ tasks: [], activeTaskId: null }));
  durableTasks.value = result.tasks;
  activeDurableTaskId.value = result.activeTaskId;
}
async function pauseDurableTask() {
  const sessionId = props.conversation?.serverSessionId; const task = activeDurableTask.value;
  if (!sessionId || !task) return;
  try {
    props.abortMessage?.();
    await updateDurableTaskStatus(sessionId, task.id, 'paused');
    await refreshDurableTasks();
  }
  catch (cause) { notify.error(cause); }
}
async function continueDurableTask() {
  const task = activeDurableTask.value;
  if (!task || inputBusy.value || !props.modelConfigured) return;
  sending.value = true;
  stickToBottom.value = true;
  void nextTick(() => scrollMessagesToBottom(true));
  try {
    await props.sendMessage(
      `继续执行持续任务“${task.title}”。请从最近检查点恢复，先检查已有源文件、中间文件和交付物，只完成尚未完成的部分。`,
      [], 'direct', onlineSearch.value, false, [], [],
    );
    await props.pullFromServer?.();
    await refreshDurableTasks();
  } catch (cause) { notify.error(cause); }
  finally { sending.value = false; }
}
async function completeDurableTask() {
  const sessionId = props.conversation?.serverSessionId; const task = activeDurableTask.value;
  if (!sessionId || !task || inputBusy.value) return;
  try { await updateDurableTaskStatus(sessionId, task.id, 'completed'); await refreshDurableTasks(); }
  catch (cause) { notify.error(cause); }
}
const activityClock = ref(Date.now());
let activityClockTimer: number | undefined;
const imageSessionId = ref('');
let imageUploadVersion = 0;
watch(() => [props.conversation?.id, props.selectedEmployeeId], () => {
  const pendingFiles = [...files.value]; const pendingSessionId = imageSessionId.value;
  images.value = []; files.value = []; imageSessionId.value = ''; imageUploadVersion += 1;
  if (pendingSessionId) pendingFiles.forEach((item) => { void deleteChatFile(pendingSessionId, item.id).catch(() => undefined); });
});
watch(() => [props.conversation?.serverSessionId, props.conversation?.messages.length], () => { void refreshDurableTasks(); }, { immediate: true });
const allowedFileExtensions = ['pdf', 'docx', 'pptx', 'ppsx', 'xlsx', 'xls', 'csv', 'html', 'htm', 'md', 'txt', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm'];
async function attachFiles(selected: File[]) {
  if (inputBusy.value || !selected.length) return;
  if (files.value.length + selected.length + images.value.length + (recording.value ? 1 : 0) > 10) { notify.error(new Error('每次最多添加 10 个附件。')); return; }
  const total = selected.reduce((sum, item) => sum + item.size, 0) + files.value.reduce((sum, item) => sum + item.size, 0) + images.value.reduce((sum, item) => sum + item.size, 0) + (recording.value?.size || 0);
  if (total > 50 * 1024 * 1024) { notify.error(new Error('单次消息附件总大小不能超过 50 MB。')); return; }
  const unsupported = selected.find((item) => !allowedFileExtensions.includes(item.name.split('.').pop()?.toLowerCase() || ''));
  if (unsupported) { notify.error(new Error(`不支持 ${unsupported.name}，请选择 PDF、Word、PowerPoint、Excel、CSV、HTML、Markdown 或文本文件。`)); return; }
  const presentationExtensions = new Set(['pptx', 'ppsx']);
  const presentationCount = [...files.value, ...selected].filter((item) => presentationExtensions.has(item.name.split('.').pop()?.toLowerCase() || '')).length;
  if (presentationCount > 3) { notify.error(new Error('每次消息最多添加 3 个演示文稿。')); return; }
  const audioExtensions = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm']);
  const audioCount = [...files.value, ...selected].filter((item) => audioExtensions.has(item.name.split('.').pop()?.toLowerCase() || '')).length;
  if (audioCount > 1) { notify.error(new Error('每次消息最多添加 1 个音频附件。')); return; }
  if (audioCount && !recordingReady.value) { notify.error(new Error(recordingHelp.value)); return; }
  uploadingFiles.value = true;
  try {
    const sessionId = await props.ensureServerSession?.();
    if (!sessionId) throw new Error('请先创建会话。');
    imageSessionId.value = sessionId;
    for (const file of selected) {
      const result = await uploadChatFile(sessionId, file);
      files.value.push(result.attachment);
      if (result.warning) notify.pushRaw('warning', result.warning);
    }
    if (!draft.value.trim()) draft.value = '请阅读附件并回答我的问题。';
  } catch (cause) { notify.error(cause); }
  finally { uploadingFiles.value = false; attachmentMenuOpen.value = false; }
}
async function selectFiles(event: Event) { const input = event.target as HTMLInputElement; await attachFiles(Array.from(input.files || [])); input.value = ''; }
async function removeFile(index: number) {
  const item = files.value[index]; files.value.splice(index, 1);
  if (item && imageSessionId.value) await deleteChatFile(imageSessionId.value, item.id).catch(() => undefined);
}
function fileKindLabel(item: ChatFileAttachment) {
  const extension = item.name.split('.').pop()?.toLowerCase();
  return extension === 'pptx' || extension === 'ppsx' ? '演示' : item.kind === 'spreadsheet' ? '表格' : item.kind === 'audio' ? '音频' : '文档';
}
function dropAttachments(event: DragEvent) {
  const selected = Array.from(event.dataTransfer?.files || []);
  if (!selected.length) return;
  event.preventDefault();
  const pictures = selected.filter((item) => item.type.startsWith('image/'));
  const documents = selected.filter((item) => !item.type.startsWith('image/'));
  if (pictures.length) void attachImages(pictures);
  if (documents.length) void attachFiles(documents);
}
async function attachImages(files: File[]) {
  if (inputBusy.value) return;
  if (!visionReady.value) { notify.error(new Error(visionHelp.value)); return; }
  if (files.length + images.value.length > 4) { notify.error(new Error('每次最多附加 4 张图片。')); return; }
  uploadingImages.value = true;
  try {
    const sessionId = await props.ensureServerSession?.();
    if (!sessionId) throw new Error('请先创建会话。');
    await nextTick();
    const version = imageUploadVersion;
    imageSessionId.value = sessionId;
    for (const file of files) {
      const attachment = await uploadChatImage(sessionId, file);
      if (version !== imageUploadVersion) return;
      images.value.push(attachment);
    }
    if (!draft.value.trim()) draft.value = '请分析这些图片。';
  } catch (cause) { notify.error(cause); }
  finally { uploadingImages.value = false; }
}
async function selectImages(event: Event) {
  const input = event.target as HTMLInputElement;
  await attachImages(Array.from(input.files || []));
  input.value = '';
}
function pasteImages(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'));
  if (files.length) { event.preventDefault(); void attachImages(files); }
}
const { modelCapabilitiesForAgent, modelForEmployee } = useModelConfig();
const effectiveChatModel = computed(() => modelForEmployee(props.selectedEmployeeId, props.model) ?? props.model);
const recordingReady = computed(() => modelCapabilitiesForAgent(props.selectedEmployeeId).some((model) => model.capability === 'asr'));
const recordingHelp = computed(() => recordingReady.value
  ? '上传录音（≤25 MB）。转写时会发送至员工已授权的语音识别服务；阿里本地文件使用临时存储。'
  : '请先在员工配置中开启“语音识别”应用模型能力。');
watch(() => [props.conversation?.id, props.selectedEmployeeId], () => { recording.value = null; });
async function selectRecording(event: Event) {
  const element = event.target as HTMLInputElement;
  const file = element.files?.[0];
  if (!file) return;
  try {
    await attachFiles([file]);
    if (!draft.value.trim()) draft.value = '请将这份录音转成文字，生成可下载的转写文件，并总结要点。';
  } catch (cause) { notify.error(cause); }
  finally { element.value = ''; }
}
const mobileShareOpen = ref(false);
const mobileShareBusy = ref(false);
const mobileShareUrl = ref("");
const mobileShareHttpsQr = ref("");
const mobileShareHttpUrl = ref("");
const mobileShareHttpQr = ref("");
const mobileShareError = ref("");
const mobileShareExpiresAt = ref(0);
const mobileShareToken = ref("");
const mobileShareManagedTls = ref(false);
const mobileShareCaUrl = ref("");
const mobileShareCaQr = ref("");
const importingAssetId = ref("");
const promotingAttachmentId = ref('');
async function saveAttachmentToAssets(file: ChatFileAttachment, openData = false) {
  const sessionId = props.conversation?.serverSessionId;
  if (!sessionId || promotingAttachmentId.value) return;
  promotingAttachmentId.value = file.id;
  try {
    const asset = await importChatAttachmentToAssets(sessionId, file.id);
    if (openData && asset.id) { await importDataFromAsset(asset.id); emit('openData'); }
    notify.pushRaw('success', openData ? '已保存到资产库并导入数据工作台' : '已保存到资产库', file.name);
  } catch (cause) { notify.error(cause); }
  finally { promotingAttachmentId.value = ''; }
}
let mobilePullTimer: ReturnType<typeof setInterval> | undefined;
let serverSyncTimer: ReturnType<typeof setInterval> | undefined;
let serverSyncBusy = false;
/** Local submit flag or workspace-level run (survives remount during auto-schedule). */
const inputBusy = computed(() => sending.value || chatBusy.value || voiceWorkBusy.value || uploadingRecording.value || uploadingImages.value || uploadingFiles.value);
watch([inputBusy, autoSchedule, collaboratorIds], () => voiceCommandCandidate.cancel(), { deep: true });
const expandedBashActivities = ref<Set<string>>(new Set());
function bashActivityKey(activity: ToolActivity, index: number) {
  return activity.invocationId || `${activity.toolName}-${index}`;
}
function toggleBashDetail(activity: ToolActivity, index: number) {
  const key = bashActivityKey(activity, index);
  const next = new Set(expandedBashActivities.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  expandedBashActivities.value = next;
}
watch(inputBusy, (busy, previous) => { if (previous && !busy) void refreshDurableTasks(); });
const approving = ref("");
const { allowedSkillsFor } = useCapabilities();
const { get: getEmployeePrefs } = useEmployeeRuntimePrefs();
const { connections: mcpConnections } = useMcpConfig();
/** Global default from Settings → 执行引擎 (fallback when employee inherits). */
const runtimeDefaultEngine = ref<EngineId>("pi");
const approvalLabel: Record<ToolApproval["capability"], string> = {
  "workspace-write": "写入运行工作区",
  "script-execution": "执行本地脚本",
  "network-access": "访问网络资源",
};
const tiers: Array<{ value: ExecutionLevel; label: string }> = [
  { value: "read-only", label: "只读" },
  { value: "default", label: "默认工作权限" },
  { value: "full", label: "完全权限（危险操作除外）" },
];

function displayTool(activity: ToolActivity) {
  if (activity.toolName === 'model:vision' || activity.toolName === 'model_understand_images') return '图片理解';
  return activity.toolName.replace(/_/g, " ");
}
function handlePermissionTierChange(event: Event) {
  emit(
    "setPermissionTier",
    (event.target as HTMLSelectElement).value as ExecutionLevel,
  );
}
function handleEndpointChange(event: Event) {
  emit("selectEndpoint", (event.target as HTMLSelectElement).value);
}
function stateLabel(activity: ToolActivity) {
  return activity.status === "running"
    ? "执行中"
    : activity.status === "failed"
      ? "未完成"
      : "已完成";
}
function hasFailedActivities(activities?: ToolActivity[]) {
  return activities?.some((activity) => activity.status === "failed") ?? false;
}
function hasRunningActivities(activities?: ToolActivity[]) {
  return activities?.some((activity) => activity.status === "running") ?? false;
}
function activityOutcome(message: Message) {
  const activities = message.activities ?? [];
  if (hasRunningActivities(activities)) {
    return {
      label: "运行中",
      tone: "accent" as const,
      detail: `${activities.length} 步执行中`,
    };
  }
  if (hasFailedActivities(activities)) {
    const recovered = completedCount(activities) > 0
      && (message.assets?.length ?? 0) > 0;
    return recovered
      ? {
          label: "已完成，含重试",
          tone: "warn" as const,
          detail: "过程中有重试，最终已成功交付",
        }
      : {
          label: "需要处理",
          tone: "danger" as const,
          detail: "存在未完成步骤",
        };
  }
  return {
    label: "已完成 · 查看详情",
    tone: "success" as const,
    detail: "流程已顺利完成",
  };
}
function shouldExpand(activities?: ToolActivity[]) {
  return (
    activities?.some(
      (activity) =>
        activity.status === "running" || activity.status === "failed",
    ) ?? false
  );
}
function completedCount(activities?: ToolActivity[]) {
  return (
    activities?.filter((activity) => activity.status === "completed").length ??
    0
  );
}

function elapsedLabel(elapsedMs?: number) {
  if (typeof elapsedMs !== 'number' || elapsedMs < 0) return '';
  const seconds = Math.round(elapsedMs / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function isApplicationModelActivity(activity: ToolActivity) {
  return activity.toolName.startsWith('model:') || activity.toolName.startsWith('model_');
}
function activityElapsedLabel(activity: ToolActivity) {
  if (!isApplicationModelActivity(activity)) return '';
  const elapsed = activity.durationMs != null
    ? activity.durationMs
    : activity.status === 'running'
      ? Math.max(0, activityClock.value - (activity.startedAt ?? activity.at ?? activityClock.value))
      : undefined;
  if (elapsed == null) return '';
  if (elapsed < 10_000) return `${(elapsed / 1000).toFixed(1)} 秒`;
  return elapsedLabel(elapsed);
}
async function submit() {
  if ((!draft.value.trim() && !files.value.length && !images.value.length && !recording.value) || !props.modelConfigured || inputBusy.value) return;
  const attachedImages = [...images.value];
  const workflowResult = resultEvidence.value?.reference;
  if (resultQuestion.value?.loading) return;
  if (workflowResult && (images.value.length || files.value.length || recording.value || autoSchedule.value || collaboratorIds.value.length)) {
    notify.error(new Error('成果问答仅使用所选成果，请移除附件并关闭协作者或自动调度。')); return;
  }
  if (!workflowResult && (attachedImages.length || props.conversation?.messages.some((message) => message.attachments?.length)) && !visionReady.value) {
    notify.error(new Error(visionHelp.value)); return;
  }
  const attachedRecording = recording.value;
  const attachedFiles = [...files.value];
  const text = (draft.value.trim() || '请分析这些附件。') + (attachedRecording ? `\n\n录音附件：${attachedRecording.name}\n请调用 model_transcribe_audio，path=${attachedRecording.reference}，outputFormat=text。` : '');
  const selected = autoSchedule.value ? [] : [...collaboratorIds.value];
  const delivery = collaborationDelivery.value;
  const useAutoSchedule = autoSchedule.value;
  const voiceSend = voiceInputOpen.value && !useAutoSchedule && !selected.length;
  // Send the visible snapshot; late ASR revisions must not recreate a sent draft.
  if (voiceInputOpen.value) closeVoiceInput();
  draft.value = "";
  recording.value = null;
  images.value = [];
  files.value = [];
  if (!useAutoSchedule) {
    collaboratorIds.value = [];
  }
  collaborationDelivery.value = "direct";
  mentionMenuOpen.value = false;
  collaboratorMenuOpen.value = false;
  sending.value = true;
  stickToBottom.value = true;
  void nextTick(() => scrollMessagesToBottom(true));
  try {
    await props.sendMessage(text, selected, delivery, onlineSearch.value, useAutoSchedule, attachedImages, attachedFiles,
      voiceSend ? (sessionId, runId) => voiceTaskMonitor.track(sessionId, runId) : undefined, workflowResult);
  } catch (cause) {
    if (voiceSend) voiceNoticePlayer.enqueue('failed');
    draft.value = text.split('\n\n录音附件：')[0];
    recording.value = attachedRecording;
    images.value = attachedImages;
    files.value = attachedFiles;
    notify.error(cause);
  } finally {
    sending.value = false;
  }
}
function stopGeneration() {
  if (!inputBusy.value) return;
  props.abortMessage?.();
}
async function approve(item: ToolApproval, scope: "session" | "always") {
  if (!props.conversation) return;
  const key = `${item.skillId}:${item.capability}`;
  approving.value = key;
  try {
    await props.approve(props.conversation.id, item, scope);
  } finally {
    approving.value = "";
  }
}
function clearCurrentConversation() {
  if (
    props.conversation &&
    window.confirm("清空后将删除当前对话内容和临时上下文，但保留 Session、关联资产与持续任务记录。若要彻底删除 Session，请在最近对话中点击删除。是否继续？")
  ) {
    resultQuestion.value?.clear();
    emit("clearConversation", props.conversation.id);
  }
}

function stopMobilePull() {
  if (mobilePullTimer) {
    clearInterval(mobilePullTimer);
    mobilePullTimer = undefined;
  }
}

function stopServerSync() {
  if (serverSyncTimer) {
    clearInterval(serverSyncTimer);
    serverSyncTimer = undefined;
  }
}

async function pullServerOnce() {
  if (serverSyncBusy) return;
  serverSyncBusy = true;
  try { await props.pullFromServer?.(); }
  finally { serverSyncBusy = false; }
}

function ensureServerSync() {
  stopServerSync();
  if (!props.conversation?.serverSessionId) return;
  // One catch-up when entering/switching conversations. Periodic mirroring is
  // reserved for conversations explicitly shared to a phone.
  void pullServerOnce();
  if (!shouldPollServerMirror(props.conversation.serverSessionId, props.conversation.mobileMirrorEnabled)) return;
  serverSyncTimer = setInterval(() => {
    void pullServerOnce();
  }, 1800);
}

function closeMobileShare() {
  mobileShareOpen.value = false;
  stopMobilePull();
  mobileShareToken.value = "";
}

async function openMobileShare() {
  if (!props.conversation) {
    notify.pushRaw('error', '请先开始或选择一段对话');
    return;
  }
  mobileShareOpen.value = true;
  mobileShareBusy.value = true;
  mobileShareError.value = "";
  mobileShareHttpsQr.value = "";
  mobileShareHttpUrl.value = "";
  mobileShareHttpQr.value = "";
  mobileShareUrl.value = "";
  mobileShareCaUrl.value = "";
  mobileShareCaQr.value = "";
  mobileShareToken.value = "";
  try {
    const sessionId = (await props.ensureServerSession?.()) || props.conversation.serverSessionId;
    if (!sessionId) throw new Error("无法创建服务端对话，请确认已登录并完成模型配置。");
    const created = await createMobileChatSession(sessionId);
    mobileShareToken.value = created.token;
    mobileShareUrl.value = created.url;
    mobileShareExpiresAt.value = created.expiresAt;
    mobileShareManagedTls.value = created.managedTls;
    mobileShareCaUrl.value = created.caUrl;
    mobileShareHttpUrl.value = created.lanUrls[0] || (created.url.startsWith('http://') ? created.url : '');
    const [httpsQr, httpQr, caQr] = await Promise.all([
      created.url.startsWith('https://') ? qrDataUrl(created.url, 180) : Promise.resolve(''),
      mobileShareHttpUrl.value ? qrDataUrl(mobileShareHttpUrl.value, 180) : Promise.resolve(''),
      created.caUrl ? qrDataUrl(created.caUrl, 180) : Promise.resolve(''),
    ]);
    mobileShareHttpsQr.value = httpsQr;
    mobileShareHttpQr.value = httpQr;
    mobileShareCaQr.value = caQr;
    if (props.conversation) props.conversation.mobileMirrorEnabled = true;
    ensureServerSync();
    stopMobilePull();
    mobilePullTimer = setInterval(() => {
      void (async () => {
        await props.pullFromServer?.();
        if (!mobileShareToken.value) return;
        try {
          const status = await getMobileChatSession(mobileShareToken.value);
          if (status.sessionId && status.sessionId !== props.conversation?.serverSessionId) {
            await props.followMobileSession?.(status.sessionId, status.title);
          }
        } catch {
          /* ignore transient status errors while the sheet is open */
        }
      })();
    }, 1600);
  } catch (error) {
    mobileShareError.value = error instanceof Error ? error.message : String(error);
  } finally {
    mobileShareBusy.value = false;
  }
}

function mobileShareExpiryLabel() {
  if (!mobileShareExpiresAt.value) return "";
  const hours = Math.max(1, Math.round((mobileShareExpiresAt.value - Date.now()) / 3_600_000));
  return `约 ${hours} 小时内有效`;
}

async function copyMobileShareUrl(url: string, label: string) {
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    notify.pushRaw('success', `已复制${label}`);
  } catch {
    notify.pushRaw('error', '复制失败');
  }
}

function approvalKey(item: ToolApproval) {
  return `${item.skillId}:${item.capability}`;
}
function formatBytes(value: number) {
  return value < 1024 * 1024
    ? `${Math.max(1, Math.round(value / 1024))} KB`
    : `${(value / 1024 / 1024).toFixed(1)} MB`;
}
function assetType(asset: Asset) {
  if (asset.kind === "bundle") return "SITE";
  return asset.name.split(".").pop()?.toUpperCase() || "FILE";
}
function isSpreadsheetAsset(asset: Asset) {
  if (asset.kind === "bundle") return false;
  const ext = (asset.workspaceRelative || asset.name).split(".").pop()?.toLowerCase() || "";
  return ext === "xlsx" || ext === "csv";
}
async function downloadAsset(asset: Asset) {
  await downloadAssetBestEffort(asset.id);
}
async function importAssetToData(asset: Asset) {
  if (!isSpreadsheetAsset(asset) || importingAssetId.value) return;
  importingAssetId.value = asset.id;
  try {
    const source = await importDataFromAsset(asset.id);
    notify.pushRaw("success", "已导入数据中心", `${source.name} · ${source.tableCount || 0} 张表`);
    emit("openData");
  } catch (error) {
    notify.pushRaw("error", error instanceof Error ? error.message : String(error));
  } finally {
    importingAssetId.value = "";
  }
}
async function openBundleFile(asset: Asset, relative: string) {
  const url = await previewAssetUrl(asset.id, relative);
  window.open(url, "_blank", "noopener");
}
function toggleCollaborator(id: EmployeeId) {
  if (autoSchedule.value) return;
  collaboratorIds.value = collaboratorIds.value.includes(id)
    ? collaboratorIds.value.filter((item) => item !== id)
    : [...collaboratorIds.value, id].slice(0, 3);
  if (collaboratorIds.value.length === 1)
    collaborationDelivery.value = "direct";
}
function closeCollaboratorMenu() {
  collaboratorMenuOpen.value = false;
}
function handleDraftInput() {
  if (autoSchedule.value || resultEvidence.value) {
    mentionMenuOpen.value = false;
    return;
  }
  const opened = /@[^\s]*$/.test(draft.value);
  if (opened && !mentionMenuOpen.value) mentionActiveIndex.value = 0;
  mentionMenuOpen.value = opened;
}
function chooseMention(id: EmployeeId) {
  if (!collaboratorIds.value.includes(id)) toggleCollaborator(id);
  draft.value = draft.value.replace(/@[^\s]*$/, `@${collaboratorName(id)} `);
  mentionMenuOpen.value = false;
}
const availableMentionEmployees = computed(() =>
  props.employees.filter(
    (item) =>
      item.id !== props.selectedEmployeeId &&
      !collaboratorIds.value.includes(item.id),
  ),
);
function handleDraftKeydown(event: KeyboardEvent) {
  if (mentionMenuOpen.value && availableMentionEmployees.value.length) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      mentionActiveIndex.value = (mentionActiveIndex.value + 1) % availableMentionEmployees.value.length;
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      mentionActiveIndex.value = (mentionActiveIndex.value - 1 + availableMentionEmployees.value.length) % availableMentionEmployees.value.length;
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = availableMentionEmployees.value[mentionActiveIndex.value] ?? availableMentionEmployees.value[0];
      chooseMention(selected.id);
      return;
    }
  }
  if (event.key === 'Escape' && mentionMenuOpen.value) {
    event.preventDefault();
    mentionMenuOpen.value = false;
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void submit();
  }
}
function collaboratorName(id: EmployeeId) {
  return employeeDisplayName(props.employees.find((item) => item.id === id), t) || id;
}
function summarizeNames(names: string[], emptyLabel: string) {
  if (!names.length) return emptyLabel;
  const head = names.slice(0, 3).join("、");
  return names.length > 3 ? `${head} 等 ${names.length} 项` : head;
}
const activeSkillNames = computed(() =>
  allowedSkillsFor(props.employee.id)
    .map((skill) => skill.name),
);
const activeMcpNames = computed(() => {
  const selected = new Set(getEmployeePrefs(props.employee.id).mcpIds || []);
  return mcpConnections.value
    .filter((item) => selected.has(item.id) && isAssociableMcp(item))
    .map((item) => item.name);
});
const employeeEngineOverride = computed(() => {
  const raw = getEmployeePrefs(props.employee.id).engine;
  return isEngineId(raw) ? raw : null;
});
/** Expected engine for the next turn (employee override → global default). */
const expectedEngine = computed<EngineId>(
  () => employeeEngineOverride.value ?? runtimeDefaultEngine.value,
);
const visionService = computed(() => modelCapabilitiesForAgent(props.selectedEmployeeId).find((model) => model.capability === 'vision'));
const visionHelp = computed(() => !effectiveChatModel.value.supportsVision && !visionService.value
  ? '请选用视觉主模型，或在设置中绑定“图片理解”模型并在员工应用模型能力中开启它。'
  : expectedEngine.value !== 'pi' ? '图片理解暂只支持 Pi，请在员工设置中切换执行引擎。'
  : autoSchedule.value || collaboratorIds.value.length ? '图片理解暂只支持单员工，请关闭自动调度并移除协作者。'
  : effectiveChatModel.value.supportsVision
    ? 'PNG / JPEG / WebP · 每张 ≤10 MB，每次 ≤4 张；图片交给当前主模型直接理解。追问保留最近4张原图。'
    : `图片将与问题及必要上下文一起交给 ${visionService.value?.providerLabel || visionService.value?.provider} · ${visionService.value?.modelId} 识别，再由主模型回答。每张 ≤10 MB，最近4张原图可追问。`);
const visionReady = computed(() => Boolean(props.modelConfigured && (effectiveChatModel.value.supportsVision || visionService.value) && expectedEngine.value === 'pi' && !autoSchedule.value && !collaboratorIds.value.length));
/** Live engine from the latest assistant turn when SSE reported it. */
const liveTurnEngine = computed<EngineId | null>(() => {
  const messages = props.conversation?.messages;
  if (!messages?.length) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "assistant" && isEngineId(msg.engine)) return msg.engine;
  }
  return null;
});
const displayEngine = computed<EngineId>(() => liveTurnEngine.value ?? expectedEngine.value);
const engineInherited = computed(() => !employeeEngineOverride.value && !liveTurnEngine.value);
const runtimePreview = computed(() => ({
  skillCount: activeSkillNames.value.length,
  mcpCount: activeMcpNames.value.length,
  skillSummary: summarizeNames(activeSkillNames.value, "无额外 Skills"),
  mcpSummary: summarizeNames(activeMcpNames.value, "未关联 MCP"),
  engine: displayEngine.value,
  engineLabel: t(`employee.engine.${displayEngine.value}`),
  engineInherited: engineInherited.value,
}));

async function refreshRuntimeDefaultEngine() {
  try {
    const value = (await getServerRuntimeConfig()) as { defaultEngine?: string };
    const def = String(value.defaultEngine || "pi").trim().toLowerCase();
    runtimeDefaultEngine.value = isEngineId(def) ? def : "pi";
  } catch {
    runtimeDefaultEngine.value = "pi";
  }
}
onMounted(() => {
  void realtimeVoiceCapabilities().then(value => { if (!voiceOpening.value && !voiceInputOpen.value && !realtimeVoiceOpen.value) voiceMode.value = value.voiceMode || 'realtime'; }).catch(() => undefined);
  void refreshRuntimeDefaultEngine();
  ensureServerSync();
  activityClockTimer = window.setInterval(() => { activityClock.value = Date.now(); }, 250);
});
watch(
  () => props.employee.id,
  () => {
    void refreshRuntimeDefaultEngine();
  },
);
function collaborationState(item: CollaborationRun) {
  return item.status === "running"
    ? "协作中"
    : item.status === "completed"
      ? "已完成"
      : "未完成";
}
function collaborationStateClass(item: CollaborationRun) {
  return item.status === "running"
    ? "text-[var(--accent)]"
    : item.status === "completed"
      ? "text-emerald-600"
      : "text-rose-600";
}

function hasAssistantVisibleProgress(message: Message) {
  return Boolean(
    message.content.trim()
    || message.reasoning?.trim()
    || message.activities?.length
    || message.collaborations?.length
    || message.schedule?.tasks.length
    || message.schedule?.status === 'planning',
  );
}

const activeScheduleMessage = computed(() => {
  const messages = props.conversation?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.schedule) return message;
  }
  return null;
});

const showScheduleRail = computed(() => Boolean(activeScheduleMessage.value?.schedule));

function selectScheduleTask(taskId: string) {
  const schedule = activeScheduleMessage.value?.schedule;
  if (!schedule) return;
  schedule.selectedTaskId = taskId;
}

function toggleAutoSchedule() {
  if (inputBusy.value) return;
  autoSchedule.value = !autoSchedule.value;
  if (autoSchedule.value) {
    collaboratorIds.value = [];
    collaboratorMenuOpen.value = false;
    mentionMenuOpen.value = false;
  }
}

const pendingAssistantId = computed(() => {
  if (!inputBusy.value || !props.conversation?.messages.length) return null;
  const last =
    props.conversation.messages[props.conversation.messages.length - 1];
  // Keep a visible continuation state after an introductory sentence. Some
  // providers spend a long time preparing a tool call after streaming that
  // sentence, and previously the UI looked idle until every tool result arrived.
  // A running tool has its own activity state, so do not duplicate it here.
  if (last.role !== "assistant" || hasRunningActivities(last.activities)) return null;
  return last.id;
});

const showStandalonePending = computed(() => {
  if (!inputBusy.value) return false;
  if (!props.conversation) return true;
  const hasVisibleProgress = props.conversation.messages.some((message) =>
    message.role === 'assistant' && hasAssistantVisibleProgress(message),
  );
  // This indicator means "still waiting for the first visible response", not
  // "the whole run is active". A server-side mirror can temporarily contain
  // an extra empty assistant placeholder, so inspect the whole conversation
  // rather than only its last item.
  return !hasVisibleProgress;
});

function isAwaitingReply(message: Message) {
  if (message.role !== "assistant" || pendingAssistantId.value !== message.id) return false;
  return !hasRunningActivities(message.activities);
}

const messageScrollRef = ref<HTMLElement | null>(null);
const messageListRef = ref<HTMLElement | null>(null);
const stickToBottom = ref(true);
const SCROLL_NEAR_BOTTOM_PX = 96;
let listResizeObserver: ResizeObserver | null = null;

function isNearBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_NEAR_BOTTOM_PX;
}

function scrollMessagesToBottom(force = false) {
  const el = messageScrollRef.value;
  if (!el) return;
  if (!force && !stickToBottom.value && !inputBusy.value) return;
  el.scrollTo({ top: el.scrollHeight, behavior: force ? "auto" : "smooth" });
}

function onMessageScroll() {
  const el = messageScrollRef.value;
  if (!el) return;
  stickToBottom.value = isNearBottom(el);
}

const chatScrollSignal = computed(() => {
  const conv = props.conversation;
  if (!conv?.messages.length) return `empty:${conv?.id ?? ""}`;
  const last = conv.messages[conv.messages.length - 1];
  const activities = (last.activities ?? [])
    .map((item) => `${item.toolName}:${item.status}:${item.summary.length}`)
    .join("|");
  const collaborations = (last.collaborations ?? [])
    .map((item) => `${item.employeeId}:${item.status}:${item.summary.length}`)
    .join("|");
  return [
    conv.id,
    conv.messages.length,
    last.id,
    last.role,
    last.content.length,
    activities,
    collaborations,
    last.assets?.length ?? 0,
    last.approvals?.length ?? 0,
    sending.value,
    chatBusy.value,
    pendingAssistantId.value ?? "",
  ].join("\0");
});

watch(
  () => props.conversation?.id,
  () => {
    resultQuestion.value?.clear();
    stickToBottom.value = true;
    void nextTick(() => scrollMessagesToBottom(true));
    closeMobileShare();
    ensureServerSync();
  },
);

watch(
  () => props.conversation?.serverSessionId,
  () => {
    ensureServerSync();
  },
);

watch(chatScrollSignal, () => {
  void nextTick(() => scrollMessagesToBottom(inputBusy.value || stickToBottom.value));
});

watch(messageListRef, (el, _, onCleanup) => {
  listResizeObserver?.disconnect();
  listResizeObserver = null;
  if (!el) return;
  listResizeObserver = new ResizeObserver(() => {
    if (stickToBottom.value || inputBusy.value) scrollMessagesToBottom(false);
  });
  listResizeObserver.observe(el);
  onCleanup(() => {
    listResizeObserver?.disconnect();
    listResizeObserver = null;
  });
});

onBeforeUnmount(() => {
  listResizeObserver?.disconnect();
  listResizeObserver = null;
  stopMobilePull();
  stopServerSync();
  if (activityClockTimer) window.clearInterval(activityClockTimer);
  activityClockTimer = undefined;
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col">
    <header
      class="flex min-h-[72px] items-center justify-between border-b border-[var(--border)] px-5 py-3 sm:px-8"
    >
      <div class="relative">
        <button
          class="flex items-center gap-2 rounded-xl p-1 text-left hover:bg-[var(--surface-muted)]"
          @click="menuOpen = !menuOpen"
        >
          <span
            class="grid h-8 w-8 place-items-center rounded-[10px] text-[11px] font-extrabold text-white"
            :style="{ background: employee.color }"
            >{{ employee.initials }}</span
          ><span
            ><strong class="block text-[13px]">{{ employeeDisplayName(employee, t) }}</strong
            ><small class="block text-[11px] text-[var(--muted)]"
              >{{ t("employee.default") }} · {{ t("chat.engine") }} {{ runtimePreview.engineLabel }}</small
            ></span
          ><span>⌄</span>
        </button>
        <div
          v-if="menuOpen"
          class="absolute left-0 top-12 z-10 w-52 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl"
        >
          <button
            v-for="item in employees"
            :key="item.id"
            class="flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm hover:bg-[var(--surface-muted)]"
            @click="
              emit('selectEmployee', item.id);
              menuOpen = false;
            "
          >
            {{ employeeDisplayName(item, t) }}
          </button>
        </div>
      </div>
      <div class="flex items-center gap-2 sm:gap-3">
        <button
          v-if="conversation"
          class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--muted)] transition-colors hover:border-[var(--accent)]/40 hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]"
          type="button"
          title="手机扫码继续对话"
          @click="openMobileShare"
        >
          手机对话
        </button>
        <button
          v-if="conversation"
          class="hidden rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--muted)] transition-colors hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-600 sm:inline-flex"
          type="button"
          title="清空当前对话内容"
          @click="clearCurrentConversation"
        >
          清空对话</button
        ><select
          class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-1.5 text-xs font-semibold"
          :value="permissionTier"
          title="当前数字员工权限档位"
          @change="handlePermissionTierChange"
        >
          <option v-for="tier in tiers" :key="tier.value" :value="tier.value">
            {{ tier.label }}
          </option></select
        ><span
          :class="[
            'hidden text-xs sm:inline',
            modelConfigured ? 'text-emerald-600' : 'text-[var(--muted)]',
          ]"
          >●
          {{ modelConfigured ? t("chat.modelReady") : t("chat.model") }}</span
        >
      </div>
    </header>

    <div
      v-if="mobileShareOpen"
      class="fixed inset-0 z-40 flex items-end justify-center bg-black/35 p-4 sm:items-center"
      @click.self="closeMobileShare"
    >
      <div class="max-h-[calc(100vh-2rem)] w-full max-w-3xl overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h3 class="text-base font-bold">手机扫码对话</h3>
          <p class="mt-1 text-xs leading-5 text-[var(--muted)]">手机与电脑保持在同一网络。普通使用直接扫“快速连接”；需要语音时再选择“安全语音”。</p>
          </div>
          <button class="rounded-lg px-2 py-1 text-xs text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" @click="closeMobileShare">关闭</button>
        </div>
        <div class="mt-4">
          <p v-if="mobileShareBusy" class="py-10 text-sm text-[var(--muted)]">正在生成二维码…</p>
          <p v-else-if="mobileShareError" class="rounded-xl bg-rose-500/10 px-3 py-3 text-sm text-rose-700">{{ mobileShareError }}</p>
          <div v-else class="grid gap-3 sm:grid-cols-2" :class="mobileShareCaQr ? 'lg:grid-cols-3' : ''">
            <section v-if="mobileShareHttpQr" class="flex flex-col items-center rounded-2xl border-2 border-[var(--accent)]/35 bg-[var(--accent)]/5 p-4 text-center">
              <span class="rounded-full bg-[var(--accent)] px-2.5 py-1 text-[10px] font-bold text-white">最简单</span>
              <h4 class="mt-2 text-sm font-bold">快速连接 · HTTP</h4>
              <p class="mt-1 min-h-10 text-[11px] leading-5 text-[var(--muted)]">直接扫码使用文字聊天、任务同步和文件传输，无需安装证书。</p>
              <img class="mt-3 h-36 w-36 rounded-xl border border-[var(--border)] bg-white p-2" :src="mobileShareHttpQr" alt="HTTP 手机对话二维码" />
              <p class="mt-2 text-[10px] font-medium text-amber-700">不支持手机麦克风语音</p>
              <button class="mt-2 text-[11px] font-semibold text-[var(--accent)] hover:underline" type="button" @click="copyMobileShareUrl(mobileShareHttpUrl, '快速连接地址')">复制地址</button>
            </section>
            <section v-if="mobileShareHttpsQr" class="flex flex-col items-center rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)]/45 p-4 text-center">
              <span class="rounded-full bg-emerald-500/15 px-2.5 py-1 text-[10px] font-bold text-emerald-700">支持语音</span>
              <h4 class="mt-2 text-sm font-bold">安全语音 · HTTPS</h4>
              <p class="mt-1 min-h-10 text-[11px] leading-5 text-[var(--muted)]">加密聊天并可使用麦克风。首次使用需先安装右侧证书。</p>
              <img class="mt-3 h-36 w-36 rounded-xl border border-[var(--border)] bg-white p-2" :src="mobileShareHttpsQr" alt="HTTPS 手机语音二维码" />
              <p class="mt-2 text-[10px] text-[var(--muted)]">证书已信任后扫描</p>
              <button class="mt-2 text-[11px] font-semibold text-[var(--accent)] hover:underline" type="button" @click="copyMobileShareUrl(mobileShareUrl, '安全语音地址')">复制地址</button>
            </section>
            <section v-if="mobileShareManagedTls && mobileShareCaQr" class="flex flex-col items-center rounded-2xl border border-dashed border-blue-400/50 bg-blue-500/5 p-4 text-center">
              <span class="rounded-full bg-blue-500/15 px-2.5 py-1 text-[10px] font-bold text-blue-700">仅首次</span>
              <h4 class="mt-2 text-sm font-bold">安装语音证书</h4>
              <p class="mt-1 min-h-10 text-[11px] leading-5 text-[var(--muted)]">只有需要手机语音时才操作。扫码后按页面说明安装并信任。</p>
              <img class="mt-3 h-36 w-36 rounded-xl border border-[var(--border)] bg-white p-2" :src="mobileShareCaQr" alt="手机证书安装二维码" />
              <p class="mt-2 text-[10px] text-[var(--muted)]">安装一次，后续无需重复</p>
              <button class="mt-2 text-[11px] font-semibold text-[var(--accent)] hover:underline" type="button" @click="copyMobileShareUrl(mobileShareCaUrl, '证书安装地址')">复制地址</button>
            </section>
          </div>
          <p v-if="!mobileShareBusy && !mobileShareError" class="mt-3 text-center text-[11px] text-[var(--muted)]">三个入口使用同一段当前对话 · {{ mobileShareExpiryLabel() }}</p>
        </div>
      </div>
    </div>

    <div
      v-if="!conversation && !showStandalonePending"
      class="flex flex-1 flex-col items-center justify-center px-5 text-center"
    >
      <h1 class="text-4xl font-bold">{{ t("chat.greeting") }}</h1>
      <p class="mt-3 text-[var(--muted)]">{{ t("chat.subheading") }}</p>
    </div>
    <div v-else-if="!conversation" class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex w-full max-w-[1240px] flex-col gap-6 px-6 py-9 lg:px-10">
        <ChatReplyPending :accent="employee.color" />
      </div>
    </div>
    <div
      v-else
      class="mx-auto flex min-h-0 w-full max-w-[1560px] flex-1 gap-4 overflow-hidden px-6 lg:px-10"
    >
      <div
        ref="messageScrollRef"
        class="min-h-0 min-w-0 flex-1 overflow-y-auto"
        @scroll="onMessageScroll"
      >
      <div
        ref="messageListRef"
        class="mx-auto flex w-full max-w-[1240px] flex-col gap-6 py-9"
      >
        <section class="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)]/55 px-4 py-3 text-xs text-[var(--muted)]">
          <div class="flex flex-wrap items-center gap-2">
            <span
              class="rounded-full px-2.5 py-1 font-semibold"
              :class="
                runtimePreview.engine === 'dsh'
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'bg-[var(--surface)] text-[var(--text)]'
              "
              :title="t('chat.engineHelp')"
            >{{ t('chat.engine') }}：{{ runtimePreview.engineLabel }}<template v-if="runtimePreview.engineInherited"> · {{ t('chat.engineInheritShort') }}</template></span>
            <span class="rounded-full bg-[var(--surface)] px-2.5 py-1 font-semibold text-[var(--text)]">权限：{{ tiers.find((item) => item.value === permissionTier)?.label ?? permissionTier }}</span>
            <span class="rounded-full bg-[var(--surface)] px-2.5 py-1">Skills：{{ runtimePreview.skillCount }}</span>
            <span class="rounded-full bg-[var(--surface)] px-2.5 py-1">MCP：{{ runtimePreview.mcpCount }}</span>
          </div>
          <p class="mt-2">本次员工执行画像 · Skill：{{ runtimePreview.skillSummary }} · MCP：{{ runtimePreview.mcpSummary }}</p>
        </section>
        <article
          v-for="message in conversation.messages"
          :key="message.id"
          :class="[
            'flex gap-2.5',
            message.role === 'user' ? 'max-w-[88%] self-end' : 'max-w-[96%]',
          ]"
        >
          <span
            v-if="message.role === 'assistant'"
            class="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-[11px] font-extrabold text-white"
            :style="{ background: employee.color }"
            >{{ employee.initials }}</span
          >
          <div class="min-w-0 flex-1">
            <small class="inline-flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--muted)]">
              <span>{{ message.role === "user" ? t("chat.you") : t("chat.assistant") }}</span>
              <span v-if="message.workflowResult" class="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] text-[var(--accent)]" :title="`工作流调用 ${message.workflowResult.invocationId}`">成果问答 · 仅解释</span>
              <span
                v-if="message.role === 'assistant' && message.engine"
                class="rounded-full bg-[var(--surface)] px-1.5 py-0.5 font-medium text-[10px] text-[var(--text)]"
                :title="t('chat.engineTurnHelp')"
              >{{ t('chat.engine') }} · {{ t(`employee.engine.${message.engine}`) }}</span>
            </small>
            <div
              v-if="message.content"
              :class="[
                'mt-1 max-w-none border px-4 py-3.5 leading-7 text-[var(--text)] shadow-[0_10px_30px_rgba(15,23,42,0.04)]',
                message.role === 'user'
                  ? 'whitespace-pre-wrap rounded-[18px_6px_18px_18px] border-[var(--accent)]/15 bg-[var(--accent-soft)]'
                  : 'chat-markdown rounded-[8px_18px_18px_18px] border-[var(--border)] bg-[var(--surface)]',
              ]"
            >
              <div v-if="message.role === 'assistant'" v-html="markdownToHtml(message.content)" />
              <template v-else>{{ message.content }}</template>
            </div>
            <div v-if="message.attachments?.length" class="mt-2 flex flex-wrap gap-2">
              <ChatImagePreview v-for="(image, index) in message.attachments" :key="image.id" :image="image" :index="index" :session-id="conversation?.serverSessionId" />
            </div>
            <div v-if="message.fileAttachments?.length" class="mt-2 grid gap-2 sm:grid-cols-2">
              <div v-for="file in message.fileAttachments" :key="file.id" class="flex min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 shadow-sm">
                <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-[10px] font-extrabold text-[var(--accent)]">{{ fileKindLabel(file) }}</span>
                <span class="min-w-0 flex-1"><strong class="block truncate text-xs">{{ file.name }}</strong><small class="block truncate text-[10px] text-[var(--muted)]">{{ file.summary || formatBytes(file.size) }}</small></span>
                <span v-if="message.role === 'user'" class="flex shrink-0 gap-1"><button class="rounded-lg border border-[var(--border)] px-2 py-1 text-[10px] font-semibold hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40" type="button" :disabled="Boolean(promotingAttachmentId)" @click="saveAttachmentToAssets(file)">保存资产</button><button v-if="file.kind === 'spreadsheet'" class="rounded-lg border border-[var(--border)] px-2 py-1 text-[10px] font-semibold hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40" type="button" :disabled="Boolean(promotingAttachmentId)" @click="saveAttachmentToAssets(file, true)">导入数据</button></span>
              </div>
            </div>
            <details
              v-if="message.role === 'assistant' && message.reasoning"
              class="mt-2 overflow-hidden rounded-lg border border-[var(--border)]/80 bg-[var(--surface)]/92 text-[11px] shadow-[0_4px_14px_rgba(15,23,42,0.035)]"
            >
              <summary class="cursor-pointer px-2.5 py-1.5 text-[var(--muted)]">思维过程（与主回答分离）</summary>
              <pre class="border-t border-[var(--border)] px-3 py-2.5 whitespace-pre-wrap text-[var(--muted)]">{{ message.reasoning }}</pre>
            </details>
            <ChatReplyPending
              v-if="isAwaitingReply(message)"
              :accent="employee.color"
              :started-at="message.startedAt"
              :has-progress="hasAssistantVisibleProgress(message)"
            />
            <details
              v-if="
                message.role === 'assistant' && message.collaborations?.length
              "
              class="group mt-2 overflow-hidden rounded-xl border border-[var(--accent)]/25 bg-[var(--accent-soft)]/30 text-xs"
              :open="
                message.collaborations.some((item) => item.status === 'running')
              "
            >
              <summary
                class="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5"
              >
                <span
                  class="grid h-5 w-5 place-items-center rounded-md bg-[var(--surface)] text-[10px] text-[var(--accent)]"
                  >◎</span
                ><strong>指定员工协作</strong
                ><span class="text-[var(--muted)]"
                  >{{ message.collaborations.length }} 位员工</span
                ><span
                  v-if="
                    message.collaborations.some(
                      (item) => item.status === 'running',
                    )
                  "
                  class="ml-auto text-[var(--accent)]"
                  >协作中</span
                ><span v-else class="ml-auto text-emerald-600">已汇总</span
                ><span class="transition-transform group-open:rotate-180"
                  >⌄</span
                >
              </summary>
              <div class="space-y-2 border-t border-[var(--accent)]/15 p-2">
                <article
                  v-for="item in message.collaborations"
                  :key="item.employeeId"
                  class="rounded-lg bg-[var(--surface)] p-3"
                >
                  <div class="flex items-center justify-between gap-3">
                    <strong>{{ collaboratorName(item.employeeId) }}</strong
                    ><span
                      :class="['font-semibold', collaborationStateClass(item)]"
                      >{{ collaborationState(item) }}</span
                    >
                  </div>
                  <p class="mt-1 text-[11px] leading-4 text-[var(--muted)]">
                    分工：{{ item.task }}
                  </p>
                  <p
                    v-if="item.summary"
                    class="mt-2 whitespace-pre-wrap leading-5 text-[var(--muted)]"
                  >
                    {{ item.summary }}
                  </p>
                  <p v-if="item.error" class="mt-2 text-rose-600">
                    {{ item.error }}
                  </p>
                  <div
                    v-if="item.activities.length"
                    class="mt-2 flex flex-wrap gap-1"
                  >
                    <span
                      v-for="(activity, index) in item.activities"
                      :key="`${activity.toolName}-${index}`"
                      class="rounded-md bg-[var(--surface-muted)] px-2 py-1 text-[10px]"
                      >{{ displayTool(activity) }} ·
                      {{ stateLabel(activity) }}</span
                    >
                  </div>
                </article>
              </div>
            </details>
            <details
              v-if="message.role === 'assistant' && message.activities?.length"
              class="group mt-2 overflow-hidden rounded-lg border border-[var(--border)]/80 bg-[var(--surface)]/92 text-[11px] shadow-[0_4px_14px_rgba(15,23,42,0.035)]"
              :open="shouldExpand(message.activities)"
            >
              <summary
                class="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-muted)]"
              >
                <span
                  class="grid h-5 w-5 place-items-center rounded-md bg-[var(--accent-soft)] text-[9px] font-black text-[var(--accent)]"
                  >⌘</span
                ><span class="min-w-0">
                  <strong class="block text-[11px] font-semibold leading-4 text-[var(--text)]"
                    >执行过程</strong
                  ><span class="block text-[10px] leading-3.5"
                    >{{ message.activities.length }} 步 ·
                    {{ completedCount(message.activities) }} 已完成<span v-if="elapsedLabel(message.elapsedMs)"> · 耗时 {{ elapsedLabel(message.elapsedMs) }}</span></span
                  ></span
                ><span
                  v-if="
                    message.activities.some((item) => item.status === 'running')
                  "
                  :class="[
                    'ml-auto rounded-full px-2 py-0.5 text-[9px] font-semibold',
                    activityOutcome(message).tone === 'accent'
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                      : activityOutcome(message).tone === 'danger'
                        ? 'bg-rose-500/10 text-rose-600'
                        : activityOutcome(message).tone === 'warn'
                          ? 'bg-amber-500/10 text-amber-700'
                          : 'bg-emerald-500/10 text-emerald-600',
                  ]"
                  >{{ activityOutcome(message).label }}</span
                ><span class="transition-transform group-open:rotate-180"
                  >⌄</span
                >
              </summary>
              <ol class="space-y-0.5 border-t border-[var(--border)] p-1">
                <li
                  v-for="(activity, index) in message.activities"
                  :key="activity.invocationId || `${activity.toolName}-${index}`"
                  :class="[
                    'relative overflow-hidden rounded-md border px-1.5 py-1 shadow-sm transition-all',
                    activity.status === 'running'
                      ? 'border-[var(--accent)]/20 bg-[var(--accent-soft)]/55'
                      : activity.status === 'failed'
                        ? 'border-rose-500/20 bg-rose-500/5'
                        : 'border-emerald-500/15 bg-emerald-500/5',
                  ]"
                >
                  <div class="flex items-start gap-1">
                    <span
                      :class="[
                        'grid h-4 w-4 shrink-0 place-items-center rounded text-[8px] font-black',
                        activity.status === 'running'
                          ? 'bg-[var(--accent)] text-white'
                          : activity.status === 'failed'
                            ? 'bg-rose-500 text-white'
                            : 'bg-emerald-500 text-white',
                      ]"
                    >{{ String(index + 1).padStart(2, '0') }}</span>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center justify-between gap-2">
                        <strong class="text-[10px] font-medium leading-4 tracking-[0.01em]">{{
                          displayTool(activity)
                        }}</strong
                        ><span class="ml-auto flex shrink-0 items-center gap-1">
                          <button
                            v-if="activity.toolName === 'bash' && activity.detail"
                            type="button"
                            class="grid h-4 w-4 place-items-center rounded text-[11px] font-bold text-[var(--accent)] transition hover:bg-[var(--accent-soft)]"
                            :class="expandedBashActivities.has(bashActivityKey(activity, index)) ? 'rotate-90' : ''"
                            :aria-expanded="expandedBashActivities.has(bashActivityKey(activity, index))"
                            aria-label="查看 Bash 命令与输出"
                            title="查看 Bash 命令与输出"
                            @click="toggleBashDetail(activity, index)"
                          >›</button>
                          <span
                          :class="[
                            'rounded-full px-1.5 py-0 text-[8px] font-semibold',
                            activity.status === 'failed'
                              ? 'bg-rose-500/10 text-rose-600'
                              : activity.status === 'running'
                                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                                : 'bg-emerald-500/10 text-emerald-600',
                          ]"
                          >{{ stateLabel(activity) }}<template v-if="activityElapsedLabel(activity)"> · {{ activityElapsedLabel(activity) }}</template></span>
                        </span>
                      </div>
                      <p class="mt-0.5 break-words text-[10px] leading-3.5 text-[var(--muted)]">
                        {{ activity.summary }}
                      </p>
                      <pre
                        v-if="activity.toolName === 'bash' && activity.detail && expandedBashActivities.has(bashActivityKey(activity, index))"
                        class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-[var(--border)]/70 bg-[var(--surface)]/70 px-2 py-1.5 font-mono text-[9px] leading-4 text-[var(--text)]"
                      >{{ activity.detail }}</pre>
                      <div
                        v-if="activity.status === 'running' && activity.progress !== undefined"
                        class="mt-1 flex items-center gap-1.5"
                        role="progressbar"
                        :aria-valuenow="Math.round(activity.progress)"
                        aria-valuemin="0"
                        aria-valuemax="100"
                      >
                        <div class="h-1 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                          <div
                            class="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
                            :style="{ width: `${Math.max(2, Math.min(100, activity.progress))}%` }"
                          ></div>
                        </div>
                        <span class="w-7 text-right text-[8px] tabular-nums text-[var(--muted)]">{{ Math.round(activity.progress) }}%</span>
                      </div>
                    </div>
                  </div>
                </li>
              </ol>
            </details>
            <section
              v-if="message.role === 'assistant' && message.approvals?.length"
              class="mt-2 space-y-2"
            >
              <article
                v-for="item in message.approvals"
                :key="approvalKey(item)"
                class="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 text-xs"
              >
                <p class="font-bold text-amber-700">
                  需要你的批准 · {{ approvalLabel[item.capability] }}
                </p>
                <p class="mt-1 text-[var(--muted)]">{{ item.summary }}</p>
                <div class="mt-3 flex gap-2">
                  <button
                    class="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 font-semibold text-white disabled:opacity-50"
                    :disabled="approving === approvalKey(item)"
                    @click="approve(item, 'session')"
                  >
                    仅本会话允许</button
                  ><button
                    class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 font-semibold"
                    :disabled="approving === approvalKey(item)"
                    @click="approve(item, 'always')"
                  >
                    始终允许
                  </button>
                </div>
              </article>
            </section>
            <section
              v-if="message.role === 'assistant' && message.sources?.length"
              class="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <div class="mb-2 flex items-center gap-2 text-xs"><span class="grid h-5 w-5 place-items-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]">↗</span><strong>联网来源</strong><span class="text-[var(--muted)]">{{ message.sources.length }} 个可核查链接</span></div>
              <div class="space-y-1.5">
                <a v-for="source in message.sources" :key="source.url" :href="source.url" target="_blank" rel="noreferrer" class="flex items-center justify-between gap-3 rounded-lg bg-[var(--surface-muted)] px-2.5 py-2 text-xs hover:text-[var(--accent)]"><span class="min-w-0 truncate">{{ source.title }}</span><span class="shrink-0 text-[10px] text-[var(--muted)]">{{ source.source || source.provider }} ↗</span></a>
              </div>
            </section>
            <section
              v-if="message.role === 'assistant' && message.assets?.length"
              class="mt-3 space-y-2"
            >
              <article
                v-for="asset in message.assets"
                :key="asset.id"
                class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[0_10px_30px_rgba(15,23,42,0.07)] transition-shadow hover:shadow-[0_14px_36px_rgba(15,23,42,0.11)]"
              >
                <ChatAssetMediaPreview :asset="asset" />
                <div class="flex flex-wrap items-center gap-3 p-3.5">
                  <span
                    class="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--accent)]/15 bg-[var(--accent-soft)] text-[10px] font-extrabold tracking-wide text-[var(--accent)]"
                    >{{ assetType(asset) }}</span
                  >
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-bold">{{ asset.name }}</p>
                    <p class="mt-0.5 text-xs text-[var(--muted)]">
                      已安全归档 · {{ assetType(asset) }} ·
                      {{ formatBytes(asset.sizeBytes) }}
                    </p>
                    <div v-if="asset.kind === 'bundle'" class="mt-2 max-h-24 overflow-y-auto rounded-lg bg-[var(--surface)]/70 p-1.5 font-mono text-[10px] text-[var(--muted)]">
                      <button v-for="file in asset.manifest?.files || []" :key="file.path" class="block w-full truncate rounded px-1 py-0.5 text-left hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]" type="button" @click="openBundleFile(asset, file.path)">{{ file.path }}</button>
                    </div>
                  </div>
                  <div class="flex shrink-0 flex-wrap justify-end gap-2">
                    <button
                      class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-semibold hover:border-[var(--accent)]"
                      type="button"
                      @click="downloadAsset(asset)"
                    >
                      下载
                    </button>
                    <button
                      v-if="isSpreadsheetAsset(asset)"
                      class="rounded-lg border border-emerald-500/40 bg-[var(--surface)] px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:border-emerald-600 disabled:opacity-50"
                      type="button"
                      :disabled="importingAssetId === asset.id"
                      @click="importAssetToData(asset)"
                    >
                      {{ importingAssetId === asset.id ? "导入中…" : "导入数据中心" }}
                    </button>
                    <button
                      class="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-xs font-semibold text-white"
                      type="button"
                      @click="emit('openAssets')"
                    >
                      资产库
                    </button>
                  </div>
                </div>
              </article>
            </section>
            <div
              v-if="activeDurableTask && message.id === activeDurableTaskMessageId"
              class="mt-3 flex min-h-12 flex-wrap items-center gap-2 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-soft)]/55 px-3 py-2 shadow-[0_5px_16px_rgba(79,70,229,0.08)]"
            >
              <span class="relative grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--surface)] text-xs font-bold text-[var(--accent)] shadow-sm">
                ↻<span :class="['absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-[var(--surface)]', durableTaskTone]" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5"><strong class="truncate text-[11px]">持续任务未结束</strong><span class="shrink-0 rounded-full bg-[var(--surface)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--muted)]">{{ durableTaskStatusLabel(activeDurableTask.status) }}</span></span>
                <small class="block truncate text-[9px] leading-4 text-[var(--muted)]">{{ activeDurableTask.title }} · {{ activeDurableTask.checkpoints.length }} 个检查点</small>
              </span>
              <button class="rounded-lg px-2 py-1.5 text-[10px] font-semibold text-[var(--muted)] hover:bg-[var(--surface)] disabled:opacity-40" type="button" :disabled="inputBusy" @click="completeDurableTask">结束任务</button>
              <button v-if="inputBusy" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[10px] font-semibold" type="button" @click="pauseDurableTask">暂停</button>
              <button v-else class="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-[10px] font-semibold text-white shadow-sm hover:brightness-105" type="button" @click="continueDurableTask">继续</button>
            </div>
          </div>
        </article>
        <ChatReplyPending
          v-if="showStandalonePending && !pendingAssistantId"
          :accent="employee.color"
        />
      </div>
      </div>
      <div
        v-if="showScheduleRail && activeScheduleMessage?.schedule"
        class="hidden min-h-0 w-[272px] shrink-0 py-9 xl:flex"
      >
        <ChatAutoScheduleRail
          class="w-full"
          :schedule="activeScheduleMessage.schedule"
          :employees="employees"
          @select-task="selectScheduleTask"
        />
      </div>
    </div>

    <div class="mx-auto mb-7 w-full max-w-[1560px] shrink-0 px-6 lg:px-10">
      <ChatWorkflowPanel v-if="ensureServerSession" ref="chatWorkflowPanel" hide-trigger :session-id="conversation?.serverSessionId" :visible="visible !== false" :disabled="inputBusy || realtimeVoiceOpen" :employee-ids="employees.filter(item => !item.system).map(item => item.id)" :ensure-session="ensureServerSession" @open-project="emit('openProject', $event)" @open-workflows="emit('openWorkflows')" @select-result="resultQuestion?.select($event)" />
      <form
        class="chat-composer relative grid min-w-0 gap-3 rounded-[19px] border border-[var(--border)] bg-[var(--surface)] p-3 shadow-lg transition focus-within:border-[var(--accent)]/35 focus-within:shadow-xl"
        @submit.prevent="submit"
        @dragover.prevent
        @drop="dropAttachments"
      >
        <WorkflowResultQuestion ref="resultQuestion" :session-id="conversation?.serverSessionId" :disabled="inputBusy || realtimeVoiceOpen" @change="resultChanged" />
        <RealtimeVoiceDialog v-if="realtimeVoiceOpen" class="min-w-0 max-w-full overflow-hidden" inline auto-start :caption-history="voiceCaptions" :conversation-id="voiceConversationId" @close="closeRealtimeVoice" @captions="updateVoiceCaption" @work-updated="voiceWorkUpdated" @open-work="(id, title) => props.followMobileSession?.(id, title)" />
        <VoiceInputDialog v-if="voiceInputOpen" inline auto-start @close="closeVoiceInput" @session-start="beginVoiceInput" @preview="previewVoiceText" @busy="voiceInputBusy = $event" />
        <div v-if="voiceMode === 'input'" class="flex flex-wrap items-center gap-3 px-1 text-[11px] text-[var(--muted)]">
          <label class="inline-flex items-center gap-1.5"><input v-model="voiceCommandEnabled" type="checkbox" :disabled="autoSchedule || collaboratorIds.length > 0" />口令执行</label>
          <label class="inline-flex items-center gap-1.5"><input v-model="voiceNoticeEnabled" type="checkbox" />任务语音提示</label>
          <span v-if="voiceCommandPending" class="text-[var(--accent)]">即将开始执行 <button type="button" class="underline" @click="cancelVoiceCommand">取消</button></span>
          <span v-else-if="voiceCommandEnabled">说出完整任务，以「开始干活」结尾 · 停顿后自动发送</span>
        </div>
        <div v-if="images.length || files.length || recording" class="grid gap-2 border-b border-[var(--border)]/70 pb-3 sm:grid-cols-2 lg:grid-cols-3">
          <div v-for="(image, index) in images" :key="image.id" class="relative">
            <ChatImagePreview :image="image" :index="index" :session-id="imageSessionId" />
            <button type="button" class="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-xs shadow-sm hover:text-[var(--danger)]" :aria-label="`移除图片 ${image.name}`" :disabled="inputBusy" @click="images.splice(index, 1)">×</button>
          </div>
          <div v-for="(file, index) in files" :key="file.id" class="flex min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5">
            <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-[10px] font-bold text-[var(--accent)]">{{ fileKindLabel(file) }}</span>
            <span class="min-w-0 flex-1"><strong class="block truncate text-xs">{{ file.name }}</strong><small class="block truncate text-[10px] text-[var(--muted)]">{{ file.summary || formatBytes(file.size) }}</small></span>
            <button type="button" class="grid h-7 w-7 shrink-0 place-items-center rounded-lg hover:bg-[var(--surface)] hover:text-[var(--danger)]" :aria-label="`移除 ${file.name}`" :disabled="inputBusy" @click="removeFile(index)">×</button>
          </div>
          <span v-if="recording" class="inline-flex max-w-full items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs">
            <svg aria-hidden="true" class="h-4 w-4 shrink-0 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>
            <span class="truncate">{{ recording.name }}</span><span class="shrink-0 text-[var(--muted)]">{{ Math.ceil(recording.size / 1024) }} KB</span>
            <button type="button" class="text-base leading-none hover:text-[var(--danger)]" aria-label="移除录音" :disabled="inputBusy" @click="recording = null">×</button>
          </span>
        </div>
        <textarea
          v-model="draft"
          rows="3"
          class="min-h-[76px] w-full resize-y border-0 bg-transparent px-1 py-0.5 outline-none"
          :placeholder="t('chat.placeholder')"
          :disabled="inputBusy || (!modelConfigured && !voiceInputOpen)"
          :readonly="voiceInputBusy"
          :aria-label="voiceInputBusy ? '语音实时录入中，结束后可编辑' : '对话输入框'"
          @input="handleDraftInput"
          @keydown="handleDraftKeydown"
          @paste="pasteImages"
        ></textarea>
        <input ref="imageInput" type="file" accept="image/png,image/jpeg,image/webp" multiple class="hidden" @change="selectImages" />
        <input ref="fileInput" type="file" accept=".pdf,.docx,.pptx,.ppsx,.xlsx,.xls,.csv,.html,.htm,.md,.txt" multiple class="hidden" @change="selectFiles" />
        <input ref="recordingInput" type="file" accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.webm" class="hidden" @change="selectRecording" />
        <div
          v-if="mentionMenuOpen"
          class="absolute bottom-[104px] left-4 z-30 w-[280px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl"
        >
          <div class="border-b border-[var(--border)] px-3 py-2">
            <p class="text-xs font-bold">@ 添加协作者</p>
            <p class="mt-1 text-[11px] text-[var(--muted)]">
              选择一位未加入本轮的数字员工
            </p>
          </div>
          <div class="max-h-52 overflow-y-auto p-2">
            <button
              v-for="item in availableMentionEmployees"
              :key="item.id"
              :class="[
                'flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm hover:bg-[var(--surface-muted)]',
                availableMentionEmployees[mentionActiveIndex]?.id === item.id
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : '',
              ]"
              type="button"
              @click="chooseMention(item.id)"
            >
              <span
                class="grid h-7 w-7 place-items-center rounded-lg text-[10px] font-bold text-white"
                :style="{ background: item.color }"
                >{{ item.initials }}</span
              ><span class="min-w-0 flex-1"
                ><strong class="block">{{ employeeDisplayName(item, t) }}</strong
                ><small
                  class="block truncate text-[11px] text-[var(--muted)]"
                  >{{ employeeDisplayDescription(item, t) }}</small
                ></span
              >
            </button>
            <p
              v-if="!availableMentionEmployees.length"
              class="px-2 py-3 text-xs text-[var(--muted)]"
            >
              可协作的员工均已加入本轮。
            </p>
          </div>
        </div>
        <div v-if="collaboratorIds.length" class="flex flex-wrap gap-1.5">
          <span
            v-for="id in collaboratorIds"
            :key="id"
            class="inline-flex items-center gap-1 rounded-lg bg-[var(--accent-soft)] px-2 py-1 text-xs font-semibold text-[var(--accent)]"
            >◎ {{ collaboratorName(id)
            }}<button
              class="ml-0.5 text-sm leading-none"
              type="button"
              @click="toggleCollaborator(id)"
            >
              ×
            </button></span
          ><select
            v-if="collaboratorIds.length === 1"
            v-model="collaborationDelivery"
            class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-1 text-xs font-semibold"
          >
            <option value="synthesize">交付：主员工整合</option>
            <option value="direct">交付：专家直接答复</option>
          </select>
        </div>
        <div class="composer-toolbar border-t border-[var(--border)]/70 pt-3" aria-label="对话工具栏">
          <div class="composer-tools">
          <div class="composer-input-tools">
          <div class="inline-flex items-center rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/70 p-1">
            <button type="button" class="grid h-8 w-8 place-items-center rounded-lg text-[var(--accent)] hover:bg-[var(--surface)]" :class="{ 'bg-[var(--accent-soft)]': voiceOpening || voiceInputOpen || realtimeVoiceOpen }" :aria-pressed="voiceOpening || voiceInputOpen || realtimeVoiceOpen" :aria-label="voiceOpening || voiceInputOpen || realtimeVoiceOpen ? '停止并关闭当前语音' : '开始所选语音模式'" :title="voiceOpening || voiceInputOpen || realtimeVoiceOpen ? '停止并关闭当前语音' : '开始所选语音模式'" @click="toggleVoice"><svg aria-hidden="true" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg></button>
            <select v-model="voiceMode" aria-label="聊天语音模式" class="max-w-[165px] rounded-lg border-0 bg-transparent px-1 py-1.5 text-[11px] text-[var(--muted)] disabled:opacity-60" :disabled="voiceOpening || voiceInputOpen || realtimeVoiceOpen"><option value="input">语音输入 · 手动发送</option><option value="realtime">实时对话 · 自动回复</option></select>
          </div>
          <div class="flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/70 p-1">
            <div class="relative">
              <button type="button" class="grid h-8 w-8 place-items-center rounded-lg text-[var(--muted)] transition hover:bg-[var(--surface)] hover:text-[var(--accent)] disabled:opacity-35" :disabled="inputBusy || !modelConfigured || !!resultEvidence" aria-label="添加附件" @click="attachmentMenuOpen = !attachmentMenuOpen">
                <svg aria-hidden="true" class="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9"/></svg>
              </button>
              <div v-if="attachmentMenuOpen" class="absolute bottom-[calc(100%+10px)] left-0 z-40 w-72 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-2xl">
                <p class="px-2 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-[.16em] text-[var(--muted)]">添加到当前对话</p>
                <button type="button" class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-[var(--surface-muted)]" @click="fileInput?.click(); attachmentMenuOpen = false"><span class="grid h-8 w-8 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">▤</span><span><strong class="block text-xs">文档、演示与表格</strong><small class="text-[10px] text-[var(--muted)]">PDF、Word、PowerPoint、Excel、HTML、Markdown</small></span></button>
                <button type="button" class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-[var(--surface-muted)] disabled:opacity-40" :disabled="!visionReady || images.length >= 4" @click="imageInput?.click(); attachmentMenuOpen = false"><span class="grid h-8 w-8 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">▧</span><span><strong class="block text-xs">图片</strong><small class="text-[10px] text-[var(--muted)]">PNG、JPEG、WebP，最多 4 张</small></span></button>
                <button type="button" class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-[var(--surface-muted)] disabled:opacity-40" :disabled="!recordingReady" @click="recordingInput?.click(); attachmentMenuOpen = false"><span class="grid h-8 w-8 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">◉</span><span><strong class="block text-xs">音频</strong><small class="text-[10px] text-[var(--muted)]">常用音频格式，最多 1 个</small></span></button>
                <p class="mx-2 mt-2 border-t border-[var(--border)] pt-2 text-[10px] leading-4 text-[var(--muted)]">附件仅用于当前对话，不会自动进入资产库或知识库。</p>
              </div>
            </div>
          </div>
          </div>
          <span class="composer-divider" aria-hidden="true" />
          <button
            v-if="ensureServerSession"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2 text-xs font-semibold hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="inputBusy || realtimeVoiceOpen || chatWorkflowPanel?.opening || chatWorkflowPanel?.busy"
            @click="chatWorkflowPanel?.open()"
          ><svg aria-hidden="true" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M9 6h6a3 3 0 0 1 3 3v6M6 9v9h9"/></svg>{{ chatWorkflowPanel?.opening ? '正在准备…' : '调用工作流' }}</button>
          <div class="relative">
            <button
              class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2 text-xs font-semibold hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
              type="button"
              :disabled="inputBusy || autoSchedule || !!resultEvidence"
              :title="autoSchedule ? t('chat.autoScheduleBlocksCollaborators') : undefined"
              @click="collaboratorMenuOpen = !collaboratorMenuOpen"
            >
              ◎ 添加协作者<span
                v-if="collaboratorIds.length"
                class="ml-1 text-[var(--accent)]"
                >{{ collaboratorIds.length }}</span
              ></button
            ><button
              v-if="collaboratorMenuOpen && !autoSchedule"
              class="fixed inset-0 z-10 cursor-default"
              aria-label="关闭协作者选择"
              type="button"
              @click="closeCollaboratorMenu"
            />
            <div
              v-if="collaboratorMenuOpen && !autoSchedule"
              class="absolute bottom-11 left-0 z-20 w-[280px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl"
            >
              <div class="border-b border-[var(--border)] px-3 py-2.5">
                <p class="text-xs font-bold">选择本轮协作者</p>
                <p
                  class="mt-1 break-words whitespace-normal text-[11px] leading-4 text-[var(--muted)]"
                >
                  协作者按员工职责分工，以隔离、只读上下文提供分析；主员工会统一整理最终答复。
                </p>
              </div>
              <div class="max-h-60 overflow-y-auto p-2">
                <button
                  v-for="item in employees.filter(
                    (item) => item.id !== selectedEmployeeId,
                  )"
                  :key="item.id"
                  :class="[
                    'flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm hover:bg-[var(--surface-muted)]',
                    collaboratorIds.includes(item.id)
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                      : '',
                  ]"
                  type="button"
                  @click="toggleCollaborator(item.id)"
                >
                  <span
                    class="grid h-7 w-7 place-items-center rounded-lg text-[10px] font-bold text-white"
                    :style="{ background: item.color }"
                    >{{ item.initials }}</span
                  ><span class="min-w-0 flex-1"
                    ><strong class="block">{{ employeeDisplayName(item, t) }}</strong
                    ><small
                      class="block truncate text-[11px] text-[var(--muted)]"
                      >{{ employeeDisplayDescription(item, t) }}</small
                    ></span
                  ><span v-if="collaboratorIds.includes(item.id)">✓</span>
                </button>
              </div>
              <div
                class="flex items-center justify-between border-t border-[var(--border)] bg-[var(--surface-muted)]/60 px-3 py-2"
              >
                <span class="text-[10px] text-[var(--muted)]"
                  >已选 {{ collaboratorIds.length }} / 3</span
                ><button
                  class="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white"
                  type="button"
                  @click="closeCollaboratorMenu"
                >
                  完成选择
                </button>
              </div>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            :aria-checked="autoSchedule"
            :disabled="inputBusy || !!resultEvidence"
            :title="t('chat.autoScheduleHelp')"
            :class="[
              'group inline-flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs font-semibold transition',
              autoSchedule
                ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)] text-[var(--accent)] shadow-[inset_0_0_0_1px_rgba(59,130,246,0.12)]'
                : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--muted)] hover:border-[var(--accent)]/35',
              inputBusy ? 'cursor-not-allowed opacity-50' : '',
            ]"
            @click="toggleAutoSchedule"
          >
            <span
              :class="[
                'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition',
                autoSchedule ? 'bg-[var(--accent)]' : 'bg-[var(--border)]',
              ]"
            >
              <span
                :class="[
                  'absolute h-3 w-3 rounded-full bg-white shadow transition',
                  autoSchedule ? 'translate-x-3.5' : 'translate-x-0.5',
                ]"
              />
            </span>
            <span>{{ t('chat.autoSchedule') }}</span>
          </button>
          <label
            class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2 text-xs font-semibold"
            :title="t('chat.onlineSearchHelp')"
          >
            <input v-model="onlineSearch" type="checkbox" :disabled="inputBusy || !!resultEvidence" />
            <span :class="onlineSearch ? 'text-[var(--accent)]' : 'text-[var(--muted)]'">{{ t('chat.onlineSearch') }}</span>
          </label>
          </div>
          <div class="composer-send-tools">
          <select
            v-if="availableModels.length"
            aria-label="对话模型"
            class="composer-model truncate rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 text-xs"
            :value="chatEndpointToken"
            @change="
              handleEndpointChange($event)
            "
          >
            <option
              v-for="item in availableModels"
              :key="item.id"
              :value="item.id"
            >
              {{ item.providerLabel }} · {{ item.chatModel }}
            </option></select
          >          <button
            v-if="inputBusy && !voiceWorkBusy"
            type="button"
            class="composer-send grid h-9 w-9 place-items-center rounded-[10px] bg-[var(--danger,#c0392b)] text-sm font-semibold text-white"
            :title="t('chat.stop')"
            :aria-label="t('chat.stop')"
            @click="stopGeneration"
          >
            ■
          </button>
          <span
            v-else-if="voiceWorkBusy"
            class="inline-flex h-9 shrink-0 items-center gap-2 rounded-[10px] bg-[var(--surface-muted)] px-3 text-[11px] font-semibold text-[var(--muted)]"
            title="语音关联工作执行期间，输入区暂时锁定"
          ><span class="h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]"></span>工作执行中</span>
          <button
            v-else
            type="submit"
            class="composer-send grid h-9 w-9 place-items-center rounded-[10px] bg-[var(--accent)] text-xl text-white disabled:opacity-35"
            :disabled="!draft.trim() || !modelConfigured || resultQuestion?.loading"
            :title="voiceInputOpen ? '发送当前文字并结束录入' : '发送消息'"
            :aria-label="voiceInputOpen ? '发送当前文字并结束录入' : '发送消息'"
          >
            ↑
          </button>
          </div>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.chat-composer { container-type: inline-size; box-shadow: 0 4px 18px rgb(25 39 78 / .06), 0 1px 3px rgb(25 39 78 / .04); }
.composer-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; }
.composer-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.composer-input-tools { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.composer-tools > button, .composer-tools > label, .composer-tools > .relative > button:first-child { height: 36px; display: inline-flex; align-items: center; white-space: nowrap; flex-shrink: 0; border-radius: 10px; }
.composer-input-tools > div { height: 36px; border-radius: 10px; }
.composer-input-tools > div > button, .composer-input-tools > div > .relative > button { height: 28px; }
.composer-divider { width: 1px; height: 22px; background: var(--border); margin: 0 2px; }
.composer-send-tools { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-left: auto; min-width: 0; }
.composer-model { height: 36px; width: 230px; min-width: 0; max-width: 100%; }
.composer-send { flex-shrink: 0; }
.composer-toolbar button:focus-visible, .composer-toolbar select:focus-visible, .composer-toolbar input:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@container (max-width: 1000px) {
  .composer-send-tools { flex-basis: 100%; padding-top: 10px; border-top: 1px solid var(--border); }
}
@container (max-width: 600px) {
  .composer-tools { gap: 8px 6px; }
  .composer-divider { display: none; }
  .composer-model { flex: 1; width: 0; }
  .composer-input-tools .relative, .composer-tools > .relative { position: static; }
  .composer-input-tools .relative > div, .composer-tools > .relative > div { left: 0; bottom: calc(100% + 10px); max-width: 100cqw; }
}
</style>
