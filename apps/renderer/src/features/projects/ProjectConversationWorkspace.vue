<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import * as orch from "../../services/orchestration.js";
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import type { Employee, EmployeeId } from "../../app/workspace.js";
import {
  deliverableEntries,
  type ProjectFileEntry,
} from "../../app/project-files.js";
import type { Project } from "../../app/projects.js";
import { useProjects } from "../../app/projects.js";
import type { AuthUser } from "../../services/auth.js";
import { employeeDisplayName } from "../../app/employees";
import { isDesktopShell } from "../../app/platform.js";
import { downloadAssetBestEffort } from "../../app/platform-actions.js";
import { readStored, writeStored } from "../../app/storage.js";
import { useTheme } from "../../app/theme.js";
import { exportWorkspaceZip, importWorkspaceZip, listWorkspaceFiles, materializeWorkspaceAssets, normalizeWorkspaceLayout, readWorkspaceFile, readWorkspaceInfo, syncWorkspaceRun, writeWorkspaceFile } from "../../services/api.js";
import ProjectDagPreview from "./ProjectDagPreview.vue";
import ProjectBrief from "./ProjectBrief.vue";
import ProjectPreviewEntry from './ProjectPreviewEntry.vue';
import ProjectComposer from "./ProjectComposer.vue";
import ProjectTurnStatus from './ProjectTurnStatus.vue';
import { conversationProgress, projectMessageAuthor, visibleProjectMessages } from './project-conversation-presentation.js';
import ChatWorkflowPanel from '../workflows/ChatWorkflowPanel.vue';
import type { ProjectInstruction } from '@openclawx/contracts';

const { resolvedTheme } = useTheme();
const { runs: localRuns } = useProjects();
function monacoTheme() {
  return resolvedTheme.value === "light" ? "vs" : "vs-dark";
}

const props = defineProps<{
  project: Project;
  employees: Employee[];
  users: AuthUser[];
  currentUserId?: string;
  currentUserRole?: 'admin' | 'member';
  templateName: string;
  running: boolean;
  submitInstruction: (input: ProjectInstruction) => Promise<void>;
  /** Incremented when a deliverable is published into the project workspace. */
  fileTreeEpoch?: number;
  backLabel?: string;
}>();
const emit = defineEmits<{
  back: [];
  openWorkflowProject: [id: string];
  openWorkflows: [];
  start: [];
  cancel: [];
  remove: [];
  "add-member": [employeeId: EmployeeId];
  "remove-member": [employeeId: EmployeeId];
  approve: [input: { taskId: string; approvalId: string; allow: boolean; scope: "session" | "always" }];
}>();

const desktopShell = isDesktopShell();
const workflowPanel = ref<InstanceType<typeof ChatWorkflowPanel>>();
const canInvokeWorkflow = computed(() => !!props.currentUserId && (
  (props.project.ownerUserId || props.project.userId) === props.currentUserId || props.currentUserRole === 'admin' ||
  (props.project.accessScope === 'delegated' && props.project.accessGrants?.some(grant => grant.subjectType === 'user' && grant.subjectId === props.currentUserId && grant.permissions.includes('write') && (!grant.expiresAt || grant.expiresAt > Date.now())))
));
const detailEmployeeId = ref<EmployeeId | null>(null);
const membersDockOpen = ref(false);
const addMemberOpen = ref(false);
const refreshing = ref(false);
const filesError = ref("");
const historyRuns = ref<orch.ServerProjectRun[]>([]);
const historyOpen = ref(false);
const historyLoading = ref(false);
type FileEntry = ProjectFileEntry;
const files = ref<FileEntry[]>([]);
const draftFiles = ref<FileEntry[]>([]);
const draftFilesError = ref('');
const draftFilesTruncated = ref(false);
const selectedDraftRunId = ref('');
const draftRunId = computed(() => {
  if (props.project.kind !== 'conversation') return '';
  const task = props.project.tasks.at(-1);
  return task?.runId && task.status !== 'completed' ? task.runId : '';
});
const selectedFile = ref('');
let fileSelection = 0;
const fileContent = ref('');
const workspaceZipInput = ref<HTMLInputElement>();
const importingZip = ref(false);
const exportingZip = ref(false);
const normalizingLayout = ref(false);
const layoutNotice = ref('');
const persistedEntrypoint = ref('');
const editorHost = ref<HTMLElement>();
const collapsedDirectories = ref(new Set<string>());
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
(self as unknown as { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

const members = computed(() => {
  if (props.project.kind === 'conversation') return props.employees;
  const ids = [...new Set(props.project.tasks.filter(task => task.status !== 'superseded').map((task) => task.employeeId))];
  return ids
    .map((id) => props.employees.find((employee) => employee.id === id))
    .filter(Boolean) as Employee[];
});
const candidateMembers = computed(() =>
  props.employees.filter((employee) => !members.value.some((item) => item.id === employee.id)),
);
const preferredEmployeeId = computed(() => props.project.defaultEmployeeId ?? [...props.project.messages].reverse().find(message => message.role === 'assistant' && members.value.some(member => member.id === message.employeeId))?.employeeId ?? [...props.project.tasks].reverse().find(task => task.status !== 'superseded')?.employeeId);
const conversation = computed(() => props.project.kind === 'conversation');
const visibleMessages = computed(() => visibleProjectMessages(props.project.messages, conversation.value));
const latestTurn = computed(() => props.project.tasks.at(-1));
const unrepresentedTurn = computed(() => conversation.value && latestTurn.value &&
  !props.project.messages.some(message => message.role === 'assistant' && message.taskId === latestTurn.value?.id)
  ? latestTurn.value : undefined);
function messageTurn(message: Project['messages'][number]) {
  return conversation.value && message.role === 'assistant'
    ? props.project.tasks.find(task => task.id === message.taskId && task.runId === message.id) : undefined;
}
const detailEmployee = computed(
  () =>
    members.value.find((employee) => employee.id === detailEmployeeId.value) ??
    null,
);
const hasPendingApproval = computed(
  () =>
    props.project.messages.some((message) => message.approvals?.length) ||
    props.project.tasks.some(
      (task) => task.status === "running" && /审批|approval/i.test(task.error ?? ""),
    ),
);
const detailTasks = computed(() =>
  props.project.tasks
    .filter((task) => task.employeeId === detailEmployeeId.value)
    .sort(
      (a, b) =>
        (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0),
    ),
);
const statusFor = (employeeId: EmployeeId) => {
  const tasks = props.project.tasks.filter(
    (task) => task.employeeId === employeeId && task.status !== "superseded",
  );
  if (tasks.some((task) => task.status === "running")) return "running";
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "stale" || task.status === "queued" || task.status === "draft"))
    return tasks.some((task) => task.status === "stale") ? "stale" : "queued";
  if (tasks.length && tasks.every((task) => task.status === "completed"))
    return "completed";
  return "queued";
};
const statusText = (status: string) =>
  ({
    queued: "等待调度",
    running: "执行中",
    completed: "已完成",
    failed: "需要处理",
    cancelled: "已取消",
    stale: "待重跑",
    superseded: "已替代",
    draft: "草案",
  })[status] ?? status;
const statusClass = (status: string) =>
  ({
    queued: "bg-slate-500/10 text-slate-600",
    running: "openclawx-running-pill",
    completed: "bg-emerald-500/10 text-emerald-600",
    failed: "bg-rose-500/10 text-rose-600",
    cancelled: "bg-amber-500/10 text-amber-700",
    stale: "bg-amber-500/10 text-amber-700",
    superseded: "bg-slate-500/10 text-slate-500",
    draft: "bg-slate-500/10 text-slate-600",
  })[status] ?? "bg-slate-500/10 text-slate-600";
const statusDotClass = (status: string) =>
  ({
    queued: "bg-slate-400",
    running: "animate-pulse bg-blue-500 ring-4 ring-blue-500/20",
    completed: "bg-emerald-500",
    failed: "bg-rose-500 ring-4 ring-rose-500/15",
    cancelled: "bg-amber-500",
    stale: "bg-amber-500",
    superseded: "bg-slate-300",
    draft: "bg-slate-400",
  })[status] ?? "bg-slate-400";
const employeeName = (id?: EmployeeId) => {
  const employee = props.employees.find((item) => item.id === id);
  return employeeDisplayName(employee, (key) => ({
    'employee.general.name': '通用助理',
    'employee.research.name': '研究助理',
    'employee.code.name': '编程助理',
    'employee.administrator.name': '系统管理员',
  } as Record<string, string>)[key] || key) || id || '';
};
const approvalLabel: Record<string, string> = {
  "workspace-write": "写入运行工作区",
  "script-execution": "执行本地脚本",
  "network-access": "访问网络资源",
};
function approve(input: { approvalId?: string; allow: boolean; scope: "session" | "always" }, taskId?: string) {
  if (!taskId || !input.approvalId) return;
  emit("approve", { taskId, approvalId: input.approvalId, allow: input.allow, scope: input.scope });
}
const date = (value: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
const formatNumber = (value?: number) => new Intl.NumberFormat("zh-CN").format(Math.max(0, Number(value || 0)));
const totalAssets = computed(() =>
  props.project.messages.flatMap((message) => message.assets ?? []),
);
const archivedHistoryRuns = computed(() => {
  if (props.project.managedServer) {
    return historyRuns.value.filter((run) => run.status !== "running" && (run.messages?.length || run.summary));
  }
  return localRuns.value
    .filter((run) => run.projectId === props.project.id && run.status !== "running" && (run.messages?.length || run.summary))
    .map((run) => ({
      id: run.id,
      projectId: run.projectId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      status: run.status,
      taskIds: run.taskIds,
      summary: run.summary,
      error: run.error,
      messages: (run.messages ?? []).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        employeeId: message.employeeId,
        taskId: message.taskId,
        createdAt: message.createdAt,
        runId: message.runId,
      })),
    }));
});

const dagPreviewTasks = computed(() => {
  const taskIds = props.project.tasks.map((task) => task.id);
  return props.project.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    subtitle: employeeName(task.employeeId),
    status: task.status,
    dependsOn: (task.dependsOn ?? []).filter((dep) => taskIds.includes(dep)),
  }));
});

async function loadHistoryRuns() {
  if (!props.project.managedServer) {
    historyRuns.value = [];
    return;
  }
  historyLoading.value = true;
  try {
    historyRuns.value = await orch.projectRuns(props.project.id);
  } catch {
    historyRuns.value = [];
  } finally {
    historyLoading.value = false;
  }
}

function historyStatusText(status: string) {
  return (
    {
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
      running: "执行中",
    } as Record<string, string>
  )[status] ?? status;
}
const TREE_WIDTH_KEY = "openclawx.project.tree-width";
const TREE_COLLAPSED_KEY = "openclawx.project.tree-collapsed";
const DAG_COLLAPSED_KEY = "openclawx.project.dag-collapsed";
const desktopBridge = () => (window as Window & { openclawxDesktop?: any }).openclawxDesktop;
const treeWidth = ref(260);
const treeCollapsed = ref(false);
const dagCollapsed = ref(false);
const resizingTree = ref(false);
const MIN_TREE_WIDTH = 180;
const MAX_TREE_WIDTH = 560;
const COLLAPSED_TREE_WIDTH = 44;

const deliverableFiles = computed(() => deliverableEntries(files.value));
const fileCount = computed(() => deliverableFiles.value.filter((entry) => entry.type === "file").length);
const hasLegacyOutput = computed(() => files.value.some((entry) => entry.relative === 'output' || entry.relative.startsWith('output/')));
const siteEntrypoint = computed(() => {
  const names = new Set(files.value.filter((entry) => entry.type === 'file').map((entry) => entry.relative));
  if (persistedEntrypoint.value && names.has(persistedEntrypoint.value)) return persistedEntrypoint.value;
  if (names.has('index.html')) return 'index.html';
  if (names.has('output/index.html')) return 'output/index.html';
  return '';
});
const visibleFiles = computed(() =>
  deliverableFiles.value.filter((entry) =>
    entry.relative
      .split("/")
      .slice(0, -1)
      .every((_, index, parts) => !collapsedDirectories.value.has(parts.slice(0, index + 1).join("/"))),
  ),
);
const editing = computed(() => Boolean(selectedFile.value));
const effectiveTreeWidth = computed(() => (treeCollapsed.value ? COLLAPSED_TREE_WIDTH : treeWidth.value));
let queuedFileReload = false;
let queuedRecover = false;

function setTreeCollapsed(value: boolean) {
  treeCollapsed.value = value;
  void writeStored(TREE_COLLAPSED_KEY, value ? "1" : "0");
}

function toggleDagCollapsed() {
  dagCollapsed.value = !dagCollapsed.value;
  void writeStored(DAG_COLLAPSED_KEY, dagCollapsed.value ? "1" : "0");
}

function startTreeResize(event: PointerEvent) {
  if (treeCollapsed.value) return;
  event.preventDefault();
  resizingTree.value = true;
  const originX = event.clientX;
  const originWidth = treeWidth.value;
  const onMove = (moveEvent: PointerEvent) => {
    treeWidth.value = Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, originWidth + (moveEvent.clientX - originX)));
  };
  const onUp = () => {
    resizingTree.value = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    void writeStored(TREE_WIDTH_KEY, String(treeWidth.value));
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function language(file: string) { if (/\.json$/i.test(file)) return 'json'; if (/\.(ts|tsx|js|jsx)$/i.test(file)) return 'typescript'; if (/\.py$/i.test(file)) return 'python'; if (/\.css$/i.test(file)) return 'css'; if (/\.html$/i.test(file)) return 'html'; if (/\.(ya?ml)$/i.test(file)) return 'yaml'; return 'markdown'; }
function fileDepth(entry: FileEntry) { return Math.max(0, entry.relative.split('/').length - 1); }
function fileName(entry: FileEntry) { return entry.relative.split('/').pop() ?? entry.relative; }
function toggleDirectory(entry: FileEntry) { const next = new Set(collapsedDirectories.value); if (next.has(entry.relative)) next.delete(entry.relative); else next.add(entry.relative); collapsedDirectories.value = next; }

/** Last segment of the project workspace path — shown instead of the raw absolute path. */
const workspaceFolderName = computed(() => {
  const raw = props.project.workspacePath?.trim() || '';
  if (!raw) return '';
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || raw;
});

/** Short parent hint, e.g. ~/.openclawx/projects */
const workspaceLocationHint = computed(() => {
  const raw = props.project.workspacePath?.trim() || '';
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  const projectsMarker = '/.openclawx/projects/';
  if (normalized.includes(projectsMarker)) return '~/.openclawx/projects';
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  const parent = parts.slice(0, -1).join('/');
  return parent.length > 36 ? `…/${parts.slice(-3, -1).join('/')}` : `/${parent}`;
});

const pathCopied = ref(false);
let pathCopiedTimer: ReturnType<typeof setTimeout> | undefined;

async function copyWorkspacePath() {
  const path = props.project.workspacePath?.trim();
  if (!path) return;
  try {
    await navigator.clipboard.writeText(path);
    pathCopied.value = true;
    clearTimeout(pathCopiedTimer);
    pathCopiedTimer = setTimeout(() => { pathCopied.value = false; }, 1600);
  } catch { /* clipboard may be unavailable */ }
}

async function openWorkspaceFolder() {
  if (!props.project.workspacePath) return;
  try {
    const desktop = desktopBridge();
    if (!desktop) throw new Error('desktop unavailable');
    await desktop.revealProjectFile(props.project.workspacePath, '');
  } catch {
    await copyWorkspacePath();
  }
}

async function handleWorkspaceZipPicked(event: Event) {
  const input = event.target as HTMLInputElement | null;
  const file = input?.files?.[0];
  if (!file || !props.project.workspacePath) return;
  importingZip.value = true;
  filesError.value = '';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    await importWorkspaceZip({ root: props.project.workspacePath, filename: file.name, base64: btoa(binary) });
    await loadFiles({ recover: false });
  } catch (error) {
    filesError.value = error instanceof Error ? error.message : '导入项目 zip 失败。';
  } finally {
    importingZip.value = false;
    if (input) input.value = '';
  }
}

async function downloadWorkspaceZip() {
  if (!props.project.workspacePath) return;
  exportingZip.value = true;
  filesError.value = '';
  try {
    const result = await exportWorkspaceZip(props.project.workspacePath);
    const bytes = Uint8Array.from(atob(result.base64), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = result.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    filesError.value = error instanceof Error ? error.message : '导出项目 zip 失败。';
  } finally {
    exportingZip.value = false;
  }
}

async function normalizeProjectLayout() {
  if (!props.project.workspacePath || normalizingLayout.value) return;
  if (!window.confirm('将 output/ 中的项目文件移动到项目根目录。已有同名文件不会被覆盖，是否继续？')) return;
  normalizingLayout.value = true;
  filesError.value = '';
  layoutNotice.value = '';
  try {
    const result = await normalizeWorkspaceLayout(props.project.workspacePath);
    files.value = result.files;
    persistedEntrypoint.value = result.entrypoint || '';
    if (result.conflicts.length) {
      layoutNotice.value = `已移动 ${result.moved.length} 个文件；${result.conflicts.length} 个同名冲突保留在 output/，请人工比较。`;
    } else {
      layoutNotice.value = `项目结构已整理：${result.moved.length} 个文件已移动到根目录。`;
    }
  } catch (error) {
    filesError.value = error instanceof Error ? error.message : '整理项目结构失败。';
  } finally {
    normalizingLayout.value = false;
  }
}

function selectSiteEntrypoint() {
  const entry = files.value.find((item) => item.type === 'file' && item.relative === siteEntrypoint.value);
  if (entry) void selectFile(entry);
}

function fileGlyph(entry: FileEntry): { label: string; className: string } {
  if (entry.type === 'directory') {
    return {
      label: collapsedDirectories.value.has(entry.relative) ? '▸' : '▾',
      className: 'text-[var(--muted)]',
    };
  }
  const name = fileName(entry);
  if (/\.html?$/i.test(name)) return { label: 'H', className: 'bg-orange-500/15 text-orange-700' };
  if (/\.css$/i.test(name)) return { label: 'C', className: 'bg-sky-500/15 text-sky-700' };
  if (/\.(js|mjs|cjs)$/i.test(name)) return { label: 'J', className: 'bg-amber-500/15 text-amber-700' };
  if (/\.(ts|tsx)$/i.test(name)) return { label: 'T', className: 'bg-blue-500/15 text-blue-700' };
  if (/\.(md|markdown)$/i.test(name)) return { label: 'M', className: 'bg-slate-500/15 text-slate-600' };
  if (/\.json$/i.test(name)) return { label: '{ }', className: 'bg-emerald-500/15 text-emerald-700' };
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(name)) return { label: '◇', className: 'bg-violet-500/15 text-violet-700' };
  if (/\.pdf$/i.test(name)) return { label: 'P', className: 'bg-rose-500/15 text-rose-700' };
  return { label: '·', className: 'bg-[var(--surface-muted)] text-[var(--muted)]' };
}

async function recoverProjectFiles() {
  if (props.project.kind === 'conversation') return;
  if (!props.project.workspacePath) return;
  const assetIds = [...new Set(totalAssets.value.map((asset) => asset.id))];
  const runIds = new Set<string>();
  for (const task of props.project.tasks) {
    if (task.status === 'running' || task.status === 'queued') continue;
    if (task.runId) runIds.add(task.runId);
  }
  for (const asset of totalAssets.value) {
    if ('runId' in asset && typeof (asset as { runId?: string }).runId === 'string') {
      const runId = (asset as { runId: string }).runId;
      if (!props.project.tasks.some(task => task.runId === runId && (task.status === 'running' || task.status === 'queued'))) runIds.add(runId);
    }
  }
  for (const runId of runIds) {
    try { await syncWorkspaceRun(props.project.workspacePath, runId); } catch { /* Continue other run workspaces. */ }
  }
  if (assetIds.length) {
    try {
      await materializeWorkspaceAssets(props.project.workspacePath, totalAssets.value
        .filter((asset) => assetIds.includes(asset.id))
        .map((asset) => ({
          assetId: asset.id,
          relativePath: asset.name,
          name: asset.name,
        })));
    } catch { /* Keep listing whatever already synced. */ }
  }
}

async function loadFiles(options: { recover?: boolean } = {}) {
  if (refreshing.value) {
    queuedFileReload = true;
    queuedRecover = queuedRecover || options.recover !== false;
    return;
  }
  filesError.value = '';
  if (!props.project.workspacePath) {
    files.value = [];
    filesError.value = '旧项目尚未配置项目空间。';
    return;
  }
  refreshing.value = true;
  const projectId = props.project.id, root = props.project.workspacePath, runId = draftRunId.value;
  try {
    // 先把本项目各任务的运行工作区(生成的文件)同步到项目目录，再读取文件树。
    if (options.recover !== false) await syncRunWorkspacesIntoProject();
    const listed = await listWorkspaceFiles(root);
    if (props.project.id !== projectId) return;
    files.value = listed;
    const info = await readWorkspaceInfo(root);
    if (props.project.id !== projectId) return;
    persistedEntrypoint.value = info.entrypoint || '';
    const hasTaskRuns = props.project.tasks.some((task) => Boolean(task.runId) && task.status !== 'running' && task.status !== 'queued');
    const needsRecover = options.recover !== false && !files.value.some((entry) => entry.type === 'file') && (totalAssets.value.length > 0 || hasTaskRuns);
    if (needsRecover) {
      await recoverProjectFiles();
      const recovered = await listWorkspaceFiles(root), metadata = await readWorkspaceInfo(root);
      if (props.project.id !== projectId) return;
      files.value = recovered; persistedEntrypoint.value = metadata.entrypoint || '';
    }
    draftFilesError.value = ''; draftFiles.value = []; draftFilesTruncated.value = false;
    if (runId) {
      try {
        const draft = await orch.listProjectDraftFiles(projectId, runId);
        if (props.project.id === projectId && draftRunId.value === runId) { draftFiles.value = draft.files; draftFilesTruncated.value = draft.truncated; }
      } catch (error) {
        if (props.project.id === projectId) draftFilesError.value = error instanceof Error ? error.message : '无法读取本轮草稿。';
      }
    }
  } catch (error) {
    if (props.project.id === projectId) filesError.value = error instanceof Error ? error.message : '无法读取项目空间。';
  } finally {
    refreshing.value = false;
    if (queuedFileReload) {
      const nextRecover = queuedRecover;
      queuedFileReload = false;
      queuedRecover = false;
      void loadFiles({ recover: nextRecover });
    }
  }
}

/** 复制所有已运行任务的生成文件到项目目录，使左侧文件树能看到运行工作区的产物。 */
async function syncRunWorkspacesIntoProject() {
  if (props.project.kind === 'conversation') return;
  if (!props.project.workspacePath) return;
  const runIds = [...new Set(props.project.tasks.filter((task) => task.status !== 'running' && task.status !== 'queued').map((task) => task.runId).filter((runId): runId is string => Boolean(runId)))];
  for (const runId of runIds) {
    try { await syncWorkspaceRun(props.project.workspacePath, runId); } catch { /* 单个运行失败不影响其它 */ }
  }
}

async function selectFile(entry: FileEntry) {
  if (entry.type === 'directory') { toggleDirectory(entry); return; }
  if (!props.project.workspacePath) return;
  const projectId = props.project.id, selection = ++fileSelection;
  const file = await readWorkspaceFile(props.project.workspacePath, entry.relative);
  if (!file || props.project.id !== projectId || selection !== fileSelection) return;
  selectedDraftRunId.value = '';
  selectedFile.value = entry.relative; fileContent.value = file.content;
  membersDockOpen.value = false;
  await nextTick();
  if (selection !== fileSelection || props.project.id !== projectId) return;
  if (!editorHost.value) return;
  if (!editor) editor = monaco.editor.create(editorHost.value, { value: file.content, language: language(entry.relative), theme: monacoTheme(), automaticLayout: true, minimap: { enabled: false }, fontSize: 13, lineHeight: 21, wordWrap: 'on', scrollBeyondLastLine: false, padding: { top: 16 } });
  else { monaco.editor.setModelLanguage(editor.getModel()!, language(entry.relative)); editor.setValue(file.content); monaco.editor.setTheme(monacoTheme()); }
  editor.updateOptions({ readOnly: false });
}
async function selectDraftFile(entry: FileEntry) {
  const projectId = props.project.id, runId = draftRunId.value;
  const selection = ++fileSelection;
  try {
    const file = await orch.readProjectDraftFile(projectId, runId, entry.relative);
    if (props.project.id !== projectId || draftRunId.value !== runId || selection !== fileSelection) return;
    closeEditor(); selectedDraftRunId.value = runId; selectedFile.value = entry.relative; fileContent.value = file.content;
    const editorSelection = fileSelection;
    await nextTick();
    if (fileSelection !== editorSelection || props.project.id !== projectId) return;
    if (editorHost.value) editor = monaco.editor.create(editorHost.value, { value: file.content, language: language(entry.relative), readOnly: true, theme: monacoTheme(), automaticLayout: true, minimap: { enabled: false }, wordWrap: 'on', fontSize: 13 });
  } catch (error) { if (props.project.id === projectId) draftFilesError.value = error instanceof Error ? error.message : '草稿读取失败，请刷新重试。'; }
}
function closeEditor() {
  fileSelection++;
  selectedDraftRunId.value = '';
  selectedFile.value = '';
  editor?.dispose();
  editor = undefined;
  membersDockOpen.value = false;
}
async function saveFile() { if (selectedDraftRunId.value || !props.project.workspacePath || !selectedFile.value || !editor) return; const result = await writeWorkspaceFile(props.project.workspacePath, selectedFile.value, editor.getValue()); if (result) fileContent.value = result.content; }

async function download(assetId: string) {
  await downloadAssetBestEffort(assetId);
}
function openMember(employeeId: EmployeeId) {
  detailEmployeeId.value = employeeId;
  membersDockOpen.value = false;
}
function requestAddMember(employeeId: EmployeeId) {
  if (props.running) return;
  addMemberOpen.value = false;
  emit("add-member", employeeId);
}
function requestRemoveMember(employeeId: EmployeeId, event?: Event) {
  event?.stopPropagation();
  if (props.running) return;
  if (members.value.length <= 1) return;
  if (detailEmployeeId.value === employeeId) detailEmployeeId.value = null;
  emit("remove-member", employeeId);
}

onMounted(() => {
  void (async () => {
    const savedWidth = Number(await readStored(TREE_WIDTH_KEY));
    if (Number.isFinite(savedWidth) && savedWidth >= MIN_TREE_WIDTH && savedWidth <= MAX_TREE_WIDTH) treeWidth.value = savedWidth;
    treeCollapsed.value = (await readStored(TREE_COLLAPSED_KEY)) === "1";
    dagCollapsed.value = (await readStored(DAG_COLLAPSED_KEY)) === "1";
    await Promise.all([loadFiles({ recover: true }), loadHistoryRuns()]);
  })();
});
// 运行期间自动刷新文件树：编程员工写入的工作区文件会随同步落到项目目录，
// 无需手工点「刷新」即可看到产物。
let fileRefreshTimer: ReturnType<typeof setInterval> | undefined;
function ensureFileRefresh() {
  if (props.project.status === "running" && !fileRefreshTimer) {
    fileRefreshTimer = setInterval(() => { void loadFiles({ recover: false }); }, 5000);
  } else if (props.project.status !== "running" && fileRefreshTimer) {
    clearInterval(fileRefreshTimer);
    fileRefreshTimer = undefined;
  }
}
ensureFileRefresh();
watch(
  [() => props.project.id, () => props.project.status, () => props.project.workspacePath, () => props.fileTreeEpoch ?? 0, draftRunId],
  () => {
    ensureFileRefresh();
    void loadFiles({ recover: true });
  },
);
watch(() => props.project.id, () => { closeEditor(); files.value = []; draftFiles.value = []; draftFilesError.value = ''; persistedEntrypoint.value = ''; });
watch(
  () => [props.project.id, props.project.activeRunId, props.project.status] as const,
  () => {
    void loadHistoryRuns();
  },
);
watch(resolvedTheme, () => {
  if (editor) monaco.editor.setTheme(monacoTheme());
});
onBeforeUnmount(() => {
  fileSelection++;
  if (fileRefreshTimer) clearInterval(fileRefreshTimer);
  clearTimeout(pathCopiedTimer);
  editor?.dispose();
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col">
    <header
      class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-6 py-4"
    >
      <div class="flex min-w-0 items-center gap-3">
        <button
          class="rounded-lg px-2 py-1 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
          @click="emit('back')"
        >
          ← {{ backLabel || '项目列表' }}
        </button>
        <span class="hidden h-5 w-px bg-[var(--border)] sm:block" />
        <div class="min-w-0">
          <p class="text-[10px] font-bold tracking-[.14em] text-[var(--accent)]">
            PROJECT WORKSPACE · {{ project.kind === 'conversation' ? '持续对话' : templateName }}
          </p>
          <h1 class="truncate text-lg font-bold">{{ project.name }}</h1>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <ProjectPreviewEntry v-if="project.kind === 'conversation' && project.managedServer" :key="`application-${project.id}-${currentUserId}`" :project-id="project.id" :project-name="project.name" :running="running" :can-write="!!canInvokeWorkflow" />
        <span
          v-if="project.kind !== 'conversation' && project.plan?.version"
          class="rounded-full bg-[var(--surface-muted)] px-2.5 py-1 text-[11px] font-semibold text-[var(--muted)]"
          :title="project.plan.note || '当前执行计划版本'"
        >Plan v{{ project.plan.version }}</span>
        <span :class="['rounded-full px-2.5 py-1 text-xs font-bold', statusClass(project.status)]">{{ project.kind === 'conversation' && ['draft', 'completed'].includes(project.status) ? '就绪' : statusText(project.status) }}</span>
        <button
          v-if="project.status === 'running'"
          class="rounded-lg border border-amber-500/40 px-3 py-2 text-xs font-semibold text-amber-700"
          @click="emit('cancel')"
        >取消</button>
        <button
          v-else-if="project.kind !== 'conversation'"
          class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white"
          @click="emit('start')"
        >{{ project.status === "draft" ? "启动首轮" : project.status === "failed" || project.status === "cancelled" ? "恢复执行" : "再次调度" }}</button>
        <button
          class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-rose-600"
          @click="emit('remove')"
        >删除</button>
      </div>
    </header>

    <div v-if="project.kind !== 'conversation'" class="shrink-0 border-b border-[var(--border)] bg-[var(--background)]/35 px-6 py-4">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div>
          <p class="text-[10px] font-bold tracking-[0.14em] text-[var(--accent)]">DAG VIEW</p>
          <p class="text-xs text-[var(--muted)]">任务依赖与数据流概览</p>
        </div>
        <button
          class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold hover:border-[var(--accent)]"
          type="button"
          @click="toggleDagCollapsed"
        >{{ dagCollapsed ? '展开依赖图' : '收起依赖图' }}</button>
      </div>
      <ProjectDagPreview v-if="!dagCollapsed" :tasks="dagPreviewTasks" compact />
    </div>

    <div
      class="grid min-h-0 flex-1 grid-cols-1 [grid-template-rows:minmax(0,1fr)]"
      :class="[
        resizingTree ? 'select-none' : '',
        editing
          ? 'xl:[grid-template-columns:var(--tree-width)_minmax(0,1.2fr)_minmax(340px,0.9fr)]'
          : project.kind === 'conversation' ? 'xl:[grid-template-columns:var(--tree-width)_minmax(0,1fr)]' : 'xl:[grid-template-columns:var(--tree-width)_minmax(0,1fr)_300px]',
      ]"
      :style="{ '--tree-width': `${effectiveTreeWidth}px` }"
    >
      <!-- 项目文件：默认展开；可向左收起，拖右边线调宽 -->
      <aside
        :class="[
          'relative min-h-0 border-r border-[var(--border)] bg-[var(--surface)]',
          treeCollapsed ? 'overflow-hidden' : 'overflow-y-auto p-3',
        ]"
      >
        <template v-if="treeCollapsed">
          <div class="flex h-full flex-col items-center gap-3 py-3">
            <button
              class="grid h-8 w-8 place-items-center rounded-lg border border-[var(--border)] text-sm font-bold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
              type="button"
              title="展开项目文件"
              @click="setTreeCollapsed(false)"
            >›</button>
            <span
              class="mt-2 text-[10px] font-bold tracking-[.18em] text-[var(--muted)]"
              style="writing-mode: vertical-rl"
            >项目文件</span>
            <span v-if="fileCount" class="text-[10px] text-[var(--muted)]">{{ fileCount }}</span>
          </div>
        </template>
        <template v-else>
          <div class="mb-3 flex items-center justify-between gap-2 px-1">
            <div class="min-w-0">
              <p class="text-[10px] font-bold tracking-[0.14em] text-[var(--muted)]">FILES</p>
              <strong class="block text-sm tracking-tight">项目文件</strong>
            </div>
            <div class="flex shrink-0 items-center gap-0.5">
              <button
                class="rounded-lg px-2 py-1 text-[11px] font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:cursor-wait disabled:opacity-50"
                type="button"
                :disabled="refreshing || !project.workspacePath"
                @click="loadFiles({ recover: true })"
              >{{ refreshing ? '同步中' : '刷新' }}</button>
              <button
                class="rounded-lg px-2 py-1 text-[11px] font-semibold text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--accent)]"
                type="button"
                title="向左收起，扩大右侧空间"
                @click="setTreeCollapsed(true)"
              >‹</button>
            </div>
          </div>

          <div
            v-if="project.workspacePath"
            class="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/70 px-2.5 py-2"
          >
            <input ref="workspaceZipInput" class="hidden" type="file" accept=".zip,application/zip" @change="handleWorkspaceZipPicked" />
            <div class="flex items-start gap-2">
              <span
                class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-xs font-bold text-[var(--accent)]"
                aria-hidden="true"
              >⌂</span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs font-semibold leading-5 text-[var(--text)]" :title="project.workspacePath">
                  {{ workspaceFolderName }}
                </p>
                <p v-if="workspaceLocationHint" class="truncate text-[10px] leading-4 text-[var(--muted)]" :title="project.workspacePath">
                  {{ workspaceLocationHint }}
                </p>
              </div>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                class="rounded-md px-2 py-1 text-[10px] font-semibold text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--accent)]"
                type="button"
                :title="desktopShell ? '在访达中打开项目目录' : 'Web / Docker 下复制服务端项目空间路径'"
                @click="openWorkspaceFolder"
              >{{ desktopShell ? '打开位置' : (pathCopied ? '已复制路径' : '复制路径') }}</button>
              <button
                class="rounded-md px-2 py-1 text-[10px] font-semibold text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--accent)] disabled:opacity-50"
                type="button"
                :disabled="importingZip"
                @click="workspaceZipInput?.click()"
              >{{ importingZip ? '导入中…' : '导入 zip' }}</button>
              <button
                class="rounded-md px-2 py-1 text-[10px] font-semibold text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--accent)] disabled:opacity-50"
                type="button"
                :disabled="exportingZip"
                @click="downloadWorkspaceZip"
              >{{ exportingZip ? '导出中…' : '导出 zip' }}</button>
              <button
                v-if="hasLegacyOutput"
                class="rounded-md bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-700 hover:bg-amber-500/20 disabled:opacity-50"
                type="button"
                :disabled="normalizingLayout"
                title="安全地将 output/ 内容移动到项目根目录；同名文件不会被覆盖"
                @click="normalizeProjectLayout"
              >{{ normalizingLayout ? '整理中…' : '整理项目结构' }}</button>
              <button
                v-if="siteEntrypoint"
                class="rounded-md bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-500/20"
                type="button"
                :title="`网站入口：${siteEntrypoint}`"
                @click="selectSiteEntrypoint"
              >网站入口</button>
              <button
                class="rounded-md px-2 py-1 text-[10px] font-semibold text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--accent)]"
                type="button"
                :title="project.workspacePath"
                @click="copyWorkspacePath"
              >{{ pathCopied ? '已复制' : '复制路径' }}</button>
              <span v-if="fileCount" class="ml-auto text-[10px] tabular-nums text-[var(--muted)]">{{ fileCount }} 项</span>
            </div>
            <p v-if="!desktopShell" class="mt-2 text-[10px] leading-4 text-[var(--muted)]">
              浏览器环境下建议通过“导入 zip / 导出 zip”在本地与服务端项目空间之间同步文件；“打开位置”会退化为复制服务端路径。
            </p>
            <p v-if="layoutNotice" class="mt-2 text-[10px] leading-4 text-amber-700">{{ layoutNotice }}</p>
          </div>
          <p v-else class="mb-3 px-1 text-[11px] leading-4 text-[var(--muted)]">旧项目尚未配置项目空间。</p>

          <div class="space-y-0.5">
            <button
              v-for="entry in visibleFiles"
              :key="entry.relative"
              type="button"
              :style="{ paddingLeft: `${6 + fileDepth(entry) * 12}px` }"
              :class="[
                'group flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-[13px] transition',
                entry.type === 'directory'
                  ? 'font-medium text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]'
                  : !selectedDraftRunId && selectedFile === entry.relative
                    ? 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]'
                    : 'text-[var(--text)]/90 hover:bg-[var(--surface-muted)]',
              ]"
              :title="entry.relative"
              @click="selectFile(entry)"
            >
              <span
                v-if="entry.type === 'directory'"
                :class="['w-4 shrink-0 text-center text-[10px]', fileGlyph(entry).className]"
              >{{ fileGlyph(entry).label }}</span>
              <span
                v-else
                :class="[
                  'grid h-5 w-5 shrink-0 place-items-center rounded-md text-[9px] font-bold leading-none',
                  fileGlyph(entry).className,
                ]"
              >{{ fileGlyph(entry).label }}</span>
              <span class="min-w-0 flex-1 truncate">{{ fileName(entry) }}</span>
            </button>
          </div>
          <p v-if="filesError" class="mt-4 px-1 text-xs leading-5 text-rose-600">{{ filesError }}</p>
          <p v-else-if="!deliverableFiles.length" class="mt-5 px-1 text-xs leading-5 text-[var(--muted)]">
            {{ conversation ? '暂无正式成果。本轮成功后会更新到这里；未完成文件可在下方草稿区查看。' : '暂无交付文件。过程脚本留在员工运行空间；最终产物会自动或经 publish_to_project 进入此处。' }}
          </p>
          <section v-if="draftRunId" class="mt-5 border-t border-[var(--border)] pt-4" aria-label="本轮草稿">
            <h3 class="text-xs font-semibold">本轮草稿 <span class="font-normal text-amber-700">只读 · 尚未交付</span></h3>
            <p class="mt-2 text-[11px] leading-5 text-[var(--muted)]">不会覆盖上方正式成果或已发布应用。可继续对话修正后重新交付。</p>
            <button v-for="entry in draftFiles" :key="entry.relative" type="button" class="mt-1 block w-full truncate rounded-lg px-2 py-2 text-left text-xs hover:bg-[var(--surface-muted)]" :title="entry.relative" @click="selectDraftFile(entry)">{{ entry.relative }}</button>
            <p v-if="draftFilesError" role="alert" class="mt-2 text-xs text-rose-600">{{ draftFilesError }}</p>
            <p v-else-if="!draftFiles.length" class="mt-2 text-[11px] leading-5 text-[var(--muted)]">{{ refreshing ? '正在读取…' : '尚无已落盘草稿；分片写入需要完成后才会出现文件。' }}</p>
            <p v-if="draftFilesTruncated" class="mt-2 text-xs text-amber-700">草稿列表过大，仅显示部分文件。</p>
          </section>
          <div
            class="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-[var(--accent)]/25 active:bg-[var(--accent)]/40"
            title="拖动调整目录树宽度"
            @pointerdown="startTreeResize"
          />
        </template>
      </aside>

      <!-- 未选文件：对话居中；选中文件：编辑器居中 -->
      <main v-if="editing" class="flex min-h-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
        <header class="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div class="min-w-0">
            <p class="text-[10px] font-bold tracking-[.12em] text-[var(--accent)]">{{ selectedDraftRunId ? '运行草稿 · 只读查看' : 'PROJECT FILE EDITOR' }}</p>
            <strong class="block truncate text-sm">{{ selectedFile }}</strong>
          </div>
          <div class="flex gap-2">
            <button class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs" type="button" @click="closeEditor">关闭编辑器</button>
            <button v-if="!selectedDraftRunId" class="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-xs font-semibold text-white" type="button" @click="saveFile">保存</button>
          </div>
        </header>
        <div ref="editorHost" class="min-h-0 flex-1" />
      </main>

      <div
        :class="[
          'relative flex min-h-0 flex-col bg-[var(--background)]',
          editing ? 'border-l border-[var(--border)]' : '',
        ]"
      >
        <div class="border-b border-[var(--border)] px-6 py-4">
          <div class="mx-auto flex max-w-3xl items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <ProjectBrief :key="project.id" :goal="project.goal" />
              <p class="mt-1 text-xs text-[var(--muted)]">
                {{ project.kind === 'conversation' ? '在这里持续提问和修改，成功成果集中保存在左侧目录。' : editing ? '正在编辑项目文件；对话移至右侧，成员可从右下角小窗展开。' : '项目对话居中；成员与资产在右侧。点击左侧文件可打开编辑器。' }}
              </p>
            </div>
            <button
              v-if="editing && project.kind !== 'conversation'"
              class="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left shadow-sm hover:border-[var(--accent)]"
              type="button"
              @click="membersDockOpen = !membersDockOpen"
            >
              <span class="block text-[10px] font-bold tracking-wide text-[var(--muted)]">成员</span>
              <span class="mt-1 flex items-center gap-1">
                <i
                  v-for="employee in members.slice(0, 4)"
                  :key="employee.id"
                  class="relative grid h-6 w-6 place-items-center rounded-md text-[9px] font-bold text-white"
                  :style="{ background: employee.color }"
                  :title="`${employeeName(employee.id)} · ${statusText(statusFor(employee.id))}`"
                >
                  {{ employee.initials }}
                  <span :class="['absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-white', statusDotClass(statusFor(employee.id))]" />
                </i>
              </span>
            </button>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div :class="['mx-auto flex flex-col gap-5', editing ? 'max-w-none' : 'max-w-3xl']">
            <details
              v-if="archivedHistoryRuns.length"
              class="rounded-2xl border border-[var(--border)] bg-[var(--surface)]"
              :open="historyOpen"
              @toggle="historyOpen = ($event.target as HTMLDetailsElement).open"
            >
              <summary class="cursor-pointer list-none px-4 py-3">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <p class="text-[10px] font-bold tracking-[0.14em] text-[var(--accent)]">HISTORY</p>
                    <strong class="text-sm">{{ conversation ? '历史运行' : '历史调度' }} · {{ archivedHistoryRuns.length }}</strong>
                    <p class="mt-1 text-xs text-[var(--muted)]">{{ conversation ? '查看以往运行记录；可以在当前项目中继续对话。' : '上一轮对话已归档到这里；当前会话从新一轮开始。' }}</p>
                  </div>
                  <span class="rounded-full bg-[var(--surface-muted)] px-2.5 py-1 text-[10px] font-semibold text-[var(--muted)]">
                    {{ historyOpen ? "收起" : "展开" }}
                  </span>
                </div>
              </summary>
              <div class="space-y-3 border-t border-[var(--border)] p-3">
                <p v-if="historyLoading" class="px-1 text-xs text-[var(--muted)]">正在加载历史运行…</p>
                <article
                  v-for="run in archivedHistoryRuns"
                  :key="run.id"
                  class="rounded-xl border border-[var(--border)] bg-[var(--background)]/50 p-3"
                >
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <strong class="text-xs">{{ new Date(run.startedAt).toLocaleString("zh-CN") }}</strong>
                      <p class="mt-1 text-[11px] text-[var(--muted)]">{{ historyStatusText(run.status) }} · {{ run.messages?.length || 0 }} 条消息</p>
                    </div>
                    <span class="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] font-bold text-[var(--muted)]">{{ run.id.slice(0, 8) }}</span>
                  </div>
                  <p v-if="run.summary && !conversation" class="mt-2 whitespace-pre-wrap text-xs leading-5 text-[var(--muted)]">{{ run.summary }}</p>
                  <div v-if="run.messages?.length" class="mt-3 max-h-56 space-y-2 overflow-y-auto">
                    <div
                      v-for="message in visibleProjectMessages(run.messages ?? [], conversation)"
                      :key="message.id"
                      class="rounded-lg bg-[var(--surface)] px-2.5 py-2 text-xs"
                    >
                      <p class="text-[10px] font-semibold text-[var(--muted)]">
                        {{ projectMessageAuthor(message.role, conversation) ?? employeeName(message.employeeId) }}
                      </p>
                      <p class="mt-1 whitespace-pre-wrap leading-5 text-[var(--text)]">{{ message.content }}</p>
                    </div>
                  </div>
                </article>
              </div>
            </details>
            <article
              v-for="message in visibleMessages"
              :key="message.id"
              :class="['flex gap-2.5', message.role === 'user' ? 'self-end' : '']"
            >
              <span
                v-if="message.role === 'assistant'"
                class="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[var(--accent)] text-[10px] font-bold text-white"
              >{{ props.employees.find((item) => item.id === message.employeeId)?.initials ?? "AI" }}</span>
              <div :class="message.role === 'user' ? 'max-w-[88%]' : 'min-w-0 max-w-[94%] flex-1'">
                <div class="mb-1 flex gap-2 text-[11px] text-[var(--muted)]">
                  <span>{{ projectMessageAuthor(message.role, conversation) ?? employeeName(message.employeeId) }}</span>
                  <span>{{ date(message.createdAt) }}</span>
                </div>
                <p
                  :class="[
                    'whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 text-[var(--text)]',
                    message.role === 'user'
                      ? 'rounded-tr-md bg-[var(--accent-soft)]'
                      : message.role === 'system'
                        ? 'border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--muted)]'
                        : 'rounded-tl-md border border-[var(--border)] bg-[var(--surface)] shadow-sm',
                  ]"
                >{{ message.content || "正在生成项目任务结果…" }}</p>
                <ProjectTurnStatus v-if="conversation" :task="messageTurn(message)" :content="message.content" />
                <details
                  v-if="message.role === 'assistant' && message.reasoning"
                  class="mt-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-xs"
                >
                  <summary class="cursor-pointer px-3 py-2 text-[var(--muted)]">思维过程（与主回答分离）</summary>
                  <pre class="border-t border-[var(--border)] p-3 whitespace-pre-wrap text-[var(--muted)]">{{ message.reasoning }}</pre>
                </details>
                <details
                  v-if="message.activities?.length"
                  class="mt-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-xs"
                >
                  <summary class="cursor-pointer px-3 py-2 text-[var(--muted)]">执行过程 · {{ message.activities.length }} 步</summary>
                  <div class="space-y-1 border-t border-[var(--border)] p-2">
                    <p
                      v-for="(activity, index) in message.activities"
                      :key="`${activity.toolName}-${index}`"
                      class="rounded-lg bg-[var(--surface-muted)] px-2 py-1.5"
                    ><strong>{{ activity.toolName }}</strong> · {{ activity.summary }}</p>
                  </div>
                </details>
                <section
                  v-if="message.role === 'assistant' && message.approvals?.length"
                  class="mt-2 space-y-2"
                >
                  <article
                    v-for="item in message.approvals"
                    :key="item.id"
                    class="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 text-xs"
                  >
                    <p class="font-bold text-amber-700">
                      需要你的批准 · {{ approvalLabel[item.capability] ?? item.capability }}
                    </p>
                    <p class="mt-1 text-[var(--muted)]">{{ item.summary }}</p>
                    <div class="mt-2 flex flex-wrap gap-2">
                      <button
                        class="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 font-semibold text-white"
                        type="button"
                        @click="approve({ approvalId: item.id, allow: true, scope: 'session' }, message.taskId)"
                      >允许本次</button>
                      <button
                        class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 font-semibold"
                        type="button"
                        @click="approve({ approvalId: item.id, allow: true, scope: 'always' }, message.taskId)"
                      >始终允许</button>
                      <button
                        class="rounded-lg border border-rose-500/40 px-2.5 py-1.5 font-semibold text-rose-600"
                        type="button"
                        @click="approve({ approvalId: item.id, allow: false, scope: 'session' }, message.taskId)"
                      >拒绝</button>
                    </div>
                  </article>
                </section>
                <div v-if="message.assets?.length" class="mt-2 flex flex-wrap gap-2">
                  <button
                    v-for="asset in message.assets"
                    :key="asset.id"
                    class="rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-3 py-2 text-left text-xs"
                    type="button"
                    @click="download(asset.id)"
                  >📦 <strong>{{ asset.name }}</strong><span class="ml-2 text-[var(--muted)]">下载</span></button>
                </div>
              </div>
            </article>
            <ProjectTurnStatus v-if="unrepresentedTurn" :task="unrepresentedTurn" />
            <p v-if="conversation && running" role="status" class="flex items-center gap-2 px-1 text-xs text-[var(--muted)]">
              <span class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--accent)]" />
              {{ employeeName(latestTurn?.employeeId) }} · {{ conversationProgress(latestTurn, hasPendingApproval) }}
            </p>
            <article v-if="project.summary && !conversation" class="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4">
              <p class="text-xs font-bold text-emerald-700">协调员汇总</p>
              <p class="mt-2 whitespace-pre-wrap text-sm leading-6">{{ project.summary }}</p>
            </article>
            <ChatWorkflowPanel v-if="project.managedServer" :key="project.id" ref="workflowPanel" hide-trigger :project-id="project.id" :visible="true" :disabled="running" :read-only="!canInvokeWorkflow" :employee-ids="employees.filter(item => !item.system).map(item => item.id)" :ensure-session="async () => project.id" @open-project="emit('openWorkflowProject', $event)" @open-workflows="emit('openWorkflows')" />
          </div>
        </div>

        <div v-if="hasPendingApproval" class="shrink-0 border-t border-amber-500/20 bg-amber-500/10 px-6 py-2">
          <div class="mx-auto flex max-w-3xl items-center gap-2 text-xs text-amber-700">
            <span class="shrink-0">⏳</span>
            <span>有任务正在等待你的批准；点击上方消息里的「允许本次 / 始终允许 / 拒绝」后继续执行。</span>
          </div>
        </div>

        <div class="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-6 py-4">
          <ProjectComposer :key="project.id" :project-id="project.id" :running="running" :conversation="project.kind === 'conversation'" :managed="!!project.managedServer && (project.kind === 'conversation' || project.executionWorkspaceMode !== 'isolated')" :members="members.map(employee => ({ id: employee.id, name: employeeName(employee.id) }))" :preferred-employee-id="preferredEmployeeId" :submit="submitInstruction" :class="editing ? 'max-w-none' : 'mx-auto max-w-3xl'" @cancel="emit('cancel')">
            <template #tools="{ disabled }"><button v-if="project.managedServer && canInvokeWorkflow" type="button" class="rounded-lg border border-[var(--border)] px-2.5 py-2 text-xs font-semibold hover:border-[var(--accent)] disabled:opacity-40" :disabled="disabled || workflowPanel?.opening || workflowPanel?.busy" @click="workflowPanel?.open()">{{ workflowPanel?.opening ? '正在准备…' : '调用工作流' }}</button></template>
          </ProjectComposer>
        </div>

        <!-- 编辑模式下的成员小窗 -->
        <div
          v-if="editing && membersDockOpen && project.kind !== 'conversation'"
          class="absolute bottom-28 right-6 z-30 w-72 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        >
          <div class="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
            <strong class="text-xs">项目成员 · {{ members.length }}</strong>
            <button class="text-xs text-[var(--muted)]" type="button" @click="membersDockOpen = false">收起</button>
          </div>
          <div class="max-h-72 overflow-y-auto p-2">
            <div
              v-for="employee in members"
              :key="employee.id"
              class="mb-1.5 flex w-full cursor-pointer items-center gap-2 rounded-xl border border-[var(--border)] p-2.5 text-left hover:border-[var(--accent)]"
              role="button"
              tabindex="0"
              @click="openMember(employee.id)"
              @keydown.enter.prevent="openMember(employee.id)"
              @keydown.space.prevent="openMember(employee.id)"
            >
              <span class="relative grid h-8 w-8 place-items-center rounded-lg text-[10px] font-bold text-white" :style="{ background: employee.color }">
                {{ employee.initials }}
                <span :class="['absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white', statusDotClass(statusFor(employee.id))]" />
              </span>
              <span class="min-w-0 flex-1">
                <strong class="block text-xs">{{ employeeName(employee.id) }}</strong>
                <span :class="['mt-0.5 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-bold', statusClass(statusFor(employee.id))]">{{ statusText(statusFor(employee.id)) }}</span>
              </span>
              <button
                class="rounded-md px-1.5 py-1 text-[10px] font-semibold text-rose-600 hover:bg-rose-500/10 disabled:opacity-40"
                type="button"
                :disabled="running || members.length <= 1"
                title="移除成员并重新规划"
                @click="requestRemoveMember(employee.id, $event)"
              >移除</button>
            </div>
            <div class="relative mt-2">
              <button
                class="w-full rounded-xl border border-dashed border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-40"
                type="button"
                :disabled="running || !candidateMembers.length"
                @click="addMemberOpen = !addMemberOpen"
              >＋ 新增成员</button>
              <div
                v-if="addMemberOpen"
                class="absolute bottom-10 left-0 z-20 w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl"
              >
                <button
                  v-for="employee in candidateMembers"
                  :key="employee.id"
                  class="flex w-full items-center gap-2 p-2.5 text-left text-xs hover:bg-[var(--surface-muted)]"
                  type="button"
                  @click="requestAddMember(employee.id)"
                >
                  <span class="grid h-7 w-7 place-items-center rounded-lg text-[10px] font-bold text-white" :style="{ background: employee.color }">{{ employee.initials }}</span>
                  <strong>{{ employeeName(employee.id) }}</strong>
                </button>
              </div>
            </div>
            <div v-if="totalAssets.length" class="mt-2 border-t border-[var(--border)] pt-2">
              <p class="px-1 text-[10px] font-bold text-[var(--muted)]">资产 · {{ totalAssets.length }}</p>
              <button
                v-for="asset in totalAssets.slice(0, 5)"
                :key="asset.id"
                class="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] hover:bg-[var(--surface-muted)]"
                type="button"
                @click="download(asset.id)"
              >📦 <span class="truncate">{{ asset.name }}</span></button>
            </div>
          </div>
        </div>
      </div>

      <!-- 未选文件：成员与资产固定最右侧 -->
      <aside
        v-if="!editing && project.kind !== 'conversation'"
        class="flex min-h-0 flex-col border-l border-[var(--border)] bg-[var(--surface)]"
      >
        <div class="border-b border-[var(--border)] px-4 py-4">
          <div class="flex items-center justify-between gap-2">
            <h2 class="text-sm font-bold">项目成员</h2>
            <div class="flex items-center gap-2">
              <span class="text-xs text-[var(--muted)]">{{ members.length }} 人</span>
              <div class="relative">
                <button
                  class="rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-semibold text-[var(--accent)] disabled:opacity-40"
                  type="button"
                  :disabled="running || !candidateMembers.length"
                  @click="addMemberOpen = !addMemberOpen"
                >＋ 新增</button>
                <div
                  v-if="addMemberOpen"
                  class="absolute right-0 top-8 z-20 w-56 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl"
                >
                  <p class="border-b border-[var(--border)] px-3 py-2 text-[11px] text-[var(--muted)]">加入后将重新规划并校验依赖</p>
                  <button
                    v-for="employee in candidateMembers"
                    :key="employee.id"
                    class="flex w-full items-center gap-2 p-2.5 text-left text-xs hover:bg-[var(--surface-muted)]"
                    type="button"
                    @click="requestAddMember(employee.id)"
                  >
                    <span class="grid h-7 w-7 place-items-center rounded-lg text-[10px] font-bold text-white" :style="{ background: employee.color }">{{ employee.initials }}</span>
                    <strong>{{ employeeName(employee.id) }}</strong>
                  </button>
                  <p v-if="!candidateMembers.length" class="px-3 py-3 text-xs text-[var(--muted)]">没有可新增的员工</p>
                </div>
              </div>
            </div>
          </div>
          <p class="mt-1 text-xs text-[var(--muted)]">点击成员查看执行细节；新增/移除会触发协调员重规划。</p>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-3">
          <div
            v-for="employee in members"
            :key="employee.id"
            class="mb-2 flex w-full items-center gap-2 rounded-xl border border-[var(--border)] p-3 transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]/30"
          >
            <button
              class="flex min-w-0 flex-1 items-center gap-3 text-left"
              type="button"
              @click="openMember(employee.id)"
            >
              <span class="relative grid h-10 w-10 place-items-center rounded-xl text-[10px] font-bold text-white" :style="{ background: employee.color }">
                <i v-if="statusFor(employee.id) === 'running'" class="openclawx-run-spin" />
                <i v-if="statusFor(employee.id) === 'running'" class="openclawx-run-pulse" />
                {{ employee.initials }}
                <span :class="['absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-white', statusDotClass(statusFor(employee.id))]" />
              </span>
              <span class="min-w-0 flex-1">
                <strong class="block text-sm">{{ employeeName(employee.id) }}</strong>
                <small class="mt-1 block text-[11px] text-[var(--muted)]">
                  {{ project.tasks.filter((task) => task.employeeId === employee.id).length }} 个任务
                </small>
                <span :class="['mt-1.5 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold', statusClass(statusFor(employee.id))]">
                  <i :class="['h-1.5 w-1.5 rounded-full', statusDotClass(statusFor(employee.id))]" />
                  {{ statusText(statusFor(employee.id)) }}
                </span>
              </span>
            </button>
            <button
              class="shrink-0 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-rose-600 hover:bg-rose-500/10 disabled:opacity-40"
              type="button"
              :disabled="running || members.length <= 1"
              title="移除成员并重新规划"
              @click="requestRemoveMember(employee.id)"
            >移除</button>
          </div>
          <div v-if="totalAssets.length" class="mt-5 border-t border-[var(--border)] pt-4">
            <p class="text-xs font-bold">项目资产 · {{ totalAssets.length }}</p>
            <button
              v-for="asset in totalAssets.slice(0, 8)"
              :key="asset.id"
              class="mt-2 flex w-full items-center gap-2 rounded-lg bg-[var(--surface-muted)] px-2.5 py-2 text-left text-xs"
              type="button"
              @click="download(asset.id)"
            >📦 <span class="truncate">{{ asset.name }}</span></button>
          </div>
        </div>
      </aside>
    </div>

    <div
      v-if="detailEmployee"
      class="fixed inset-0 z-40 flex justify-end bg-slate-950/25"
      @click.self="detailEmployeeId = null"
    >
      <aside class="h-full w-full max-w-xl overflow-y-auto border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header class="sticky top-0 flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-5 py-4">
          <div>
            <p class="text-xs font-bold text-[var(--accent)]">MEMBER EXECUTION DETAIL</p>
            <h2 class="mt-1 text-lg font-bold">{{ employeeName(detailEmployee.id) }}</h2>
            <span :class="['mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold', statusClass(statusFor(detailEmployee.id))]">
              <i :class="['h-2 w-2 rounded-full', statusDotClass(statusFor(detailEmployee.id))]" />
              {{ statusText(statusFor(detailEmployee.id)) }}
            </span>
          </div>
          <button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm" type="button" @click="detailEmployeeId = null">关闭</button>
        </header>
        <div class="space-y-4 p-5">
          <article v-for="task in detailTasks" :key="task.id" class="rounded-2xl border border-[var(--border)] p-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h3 class="font-bold">{{ task.title }}</h3>
                <p class="mt-1 text-sm text-[var(--muted)]">{{ task.objective }}</p>
              </div>
              <span :class="['shrink-0 rounded-full px-2 py-1 text-xs font-bold', statusClass(task.status)]">{{ statusText(task.status) }}</span>
            </div>
            <pre
              v-if="task.transcript?.assistantContent"
              class="mt-3 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-xl bg-[var(--surface-muted)] p-3 font-sans text-xs leading-5"
            >{{ task.transcript.assistantContent }}</pre>
            <div v-if="task.error || task.transcript?.error" role="alert" class="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-700">
              {{ task.error || task.transcript?.error }}
              <details v-if="task.transcript?.failure" class="mt-1">
                <summary class="cursor-pointer">运行诊断</summary>
                <p>{{ task.transcript.failure.code }} · {{ task.transcript.failure.phase }} · {{ Math.round(task.transcript.failure.elapsedMs / 1000) }} 秒</p>
                <p>{{ task.transcript.failure.signature }}</p>
              </details>
            </div>
            <details
              v-if="task.transcript?.reasoningContent"
              class="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-xs"
            >
              <summary class="cursor-pointer px-3 py-2 text-[var(--muted)]">思维过程（与主回答分离）</summary>
              <pre class="border-t border-[var(--border)] p-3 whitespace-pre-wrap text-[var(--muted)]">{{ task.transcript.reasoningContent }}</pre>
            </details>
            <div v-if="task.transcript?.activities?.length" class="mt-3 space-y-1">
              <p
                v-for="(activity, index) in task.transcript.activities"
                :key="`${activity.toolName}-${index}`"
                class="rounded-lg bg-[var(--surface-muted)] px-2 py-1.5 text-xs"
              ><strong>{{ activity.toolName }}</strong> · {{ activity.summary }}</p>
            </div>
            <div v-if="task.transcript?.model || task.transcript?.usage" class="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/40 p-3 text-xs">
              <p class="font-bold">Run Trace</p>
              <p v-if="task.transcript?.model" class="mt-1 text-[var(--muted)]">
                模型：{{ task.transcript.model.providerLabel || task.transcript.model.provider }} / {{ task.transcript.model.chatModel }}
              </p>
              <p v-if="task.transcript?.usage" class="mt-1 text-[var(--muted)]">
                Tokens：输入 {{ formatNumber(task.transcript.usage.inputTokens) }}，输出 {{ formatNumber(task.transcript.usage.outputTokens) }}，总计 {{ formatNumber(task.transcript.usage.totalTokens) }}
              </p>
              <p
                v-if="task.transcript?.usage?.reasoningTokens || task.transcript?.usage?.cacheReadTokens || task.transcript?.usage?.cacheWriteTokens"
                class="mt-1 text-[var(--muted)]"
              >
                推理 {{ formatNumber(task.transcript.usage.reasoningTokens) }} / Cache Read {{ formatNumber(task.transcript.usage.cacheReadTokens) }} / Cache Write {{ formatNumber(task.transcript.usage.cacheWriteTokens) }}
              </p>
            </div>
            <div v-if="task.transcript?.sources?.length" class="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/35 p-3 text-xs">
              <p class="font-bold">联网来源</p>
              <ul class="mt-2 space-y-1">
                <li v-for="source in task.transcript.sources" :key="source.url" class="truncate text-[var(--muted)]">
                  <a :href="source.url" target="_blank" rel="noreferrer" class="hover:text-[var(--accent)]">{{ source.title || source.url }}</a>
                </li>
              </ul>
            </div>
            <div v-if="task.transcript?.trace?.length" class="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/35 p-3 text-xs">
              <p class="font-bold">事件轨迹</p>
              <div class="mt-2 space-y-1.5">
                <p v-for="(event, index) in task.transcript.trace.slice(-12)" :key="`${event.type}-${index}`" class="rounded-lg bg-[var(--surface)] px-2 py-1.5 text-[var(--muted)]">
                  <strong class="text-[var(--text)]">{{ event.type }}</strong>
                  <template v-if="event.toolName"> · {{ event.toolName }}</template>
                  <template v-if="event.summary"> · {{ event.summary }}</template>
                  <template v-else-if="event.message"> · {{ event.message }}</template>
                  <template v-else-if="event.reason"> · {{ event.reason }}</template>
                </p>
              </div>
            </div>
            <p
              v-else-if="task.status === 'running' && !task.transcript?.activities?.length"
              class="mt-3 text-xs leading-5 text-[var(--muted)]"
            >正在执行中。若长时间无过程输出，可能是进程刚重启，系统会自动回收卡住的任务。</p>
          </article>
          <p v-if="!detailTasks.length" class="text-sm text-[var(--muted)]">该成员尚无任务记录。</p>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
/* Running-status polish: shimmering pill + orbiting/pulsing ring on the avatar. */
.openclawx-running-pill {
  background: linear-gradient(90deg, #3b82f6 0%, #818cf8 45%, #22d3ee 100%);
  background-size: 200% 100%;
  color: #fff;
  animation: openclawx-shimmer 1.7s linear infinite;
}
.openclawx-run-spin,
.openclawx-run-pulse {
  position: absolute;
  inset: -3px;
  border-radius: 16px;
  pointer-events: none;
}
.openclawx-run-spin {
  border: 2px solid transparent;
  border-top-color: #818cf8;
  border-right-color: rgba(129, 140, 248, 0.55);
  filter: drop-shadow(0 0 4px rgba(99, 102, 241, 0.7));
  animation: openclawx-spin 1.05s linear infinite;
}
.openclawx-run-pulse {
  box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.7);
  animation: openclawx-pulse 1.7s ease-out infinite;
}
@keyframes openclawx-shimmer {
  to {
    background-position: -200% 0;
  }
}
@keyframes openclawx-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes openclawx-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.7);
  }
  100% {
    box-shadow: 0 0 0 12px rgba(99, 102, 241, 0);
  }
}
</style>
