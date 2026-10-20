<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAssets, type Asset } from '../../app/assets';
import { useI18n } from '../../app/i18n';
import { useProjects, type Project } from '../../app/projects';
import { readStored, writeStored } from '../../app/storage.js';
import {
  deliverableEntries,
  fileExt,
  previewKindForName,
  type PreviewKind,
  type ProjectFileEntry,
} from '../../app/project-files';
import type { Conversation } from '../../app/workspace';
import AssetPreviewPane from './AssetPreviewPane.vue';
import { listWorkspaceFiles, readArchivedAssetPreview, readWorkspacePreview, startAssetSiteDeploy, stopAssetSiteDeploy, assetSiteDeployStatus, importDataFromAsset, importDataFromWorkspace } from '../../services/api.js';
import { isDesktopShell } from '../../app/platform.js';
import { copyableAssetUrl, copyableWorkspaceFileUrl, downloadAssetBestEffort, downloadWorkspaceFileBestEffort, openAssetBestEffort, openExternalBestEffort, openWorkspaceFileBestEffort, previewAssetUrl, previewWorkspaceFileUrl, revealAssetBestEffort, revealWorkspaceFileBestEffort } from '../../app/platform-actions.js';
import { useNotify } from '../../app/notify';

const props = defineProps<{ conversations: Conversation[] }>();
const emit = defineEmits<{
  openConversation: [id: string];
  openProject: [id: string];
  openData: [];
}>();

const { t } = useI18n();
const notify = useNotify();
const { assets, loading, loadAssets, linkAssetsToProject, unlinkAssetsFromProject, deleteAssets } = useAssets();
const { projects, load: loadProjects } = useProjects();

type LibraryMode = 'projects' | 'archive';
type ArchiveScope = 'all' | 'unlinked' | string; // projectId or conversation:<server-session-id>
const ASSET_MODE_KEY = 'assets.mode';
const mode = ref<LibraryMode>('projects');
const projectQuery = ref('');
const selectedProjectId = ref<string | null>(null);
const treeEntries = ref<ProjectFileEntry[]>([]);
const treeLoading = ref(false);
const collapsedDirectories = ref(new Set<string>());
const selectedRelative = ref('');
const archiveQuery = ref('');
const archiveType = ref('all');
const archiveScope = ref<ArchiveScope>('all');
const sessionQuery = ref('');
const sessionPickerOpen = ref(false);
const selectedAsset = ref<Asset | null>(null);
const checkedAssetIds = ref<string[]>([]);
const linkPickerOpen = ref(false);
const linkTargetProjectId = ref('');
const linkBusy = ref(false);
const deleteBusy = ref(false);
const linkMessage = ref('');
const showTechnical = ref(false);
const copied = ref('');
let projectRefreshTimer: ReturnType<typeof setInterval> | undefined;

const previewLoading = ref(false);
const previewError = ref('');
const previewKind = ref<PreviewKind>('unsupported');
const previewTitle = ref('');
const previewHtmlUrl = ref('');
const previewText = ref('');
const previewImageUrl = ref('');
const previewMeta = ref<string[]>([]);
const deployBusy = ref(false);
const stopDeployBusy = ref(false);
const deployUrl = ref('');
const deployActive = ref(false);
const deployError = ref('');
const importBusy = ref(false);

const projectIsWebsite = computed(() =>
  treeEntries.value.some((entry) => entry.type === 'file' && entry.relative === 'index.html'),
);

async function refreshSiteDeployStatus(opts?: { assetId?: string | null; projectId?: string | null }) {
  const assetId = String(opts?.assetId ?? (mode.value === 'archive' ? selectedAsset.value?.id : '') ?? '').trim();
  const projectId = String(opts?.projectId ?? (mode.value === 'projects' ? selectedProjectId.value : '') ?? '').trim();
  const canAsset = Boolean(assetId && selectedAsset.value?.kind === 'bundle');
  const canProject = Boolean(projectId && projectIsWebsite.value);
  if (!canAsset && !canProject) {
    deployUrl.value = '';
    deployActive.value = false;
    return;
  }
  try {
    const servers = await assetSiteDeployStatus(canAsset ? { assetId } : { projectId });
    const active = servers.find((item) => item.access === 'lan') || servers[0];
    deployActive.value = Boolean(active);
    deployUrl.value = active?.url || '';
    deployError.value = '';
  } catch {
    deployActive.value = false;
    deployUrl.value = '';
  }
}

async function deploySelectedSite() {
  if (deployBusy.value) return;
  const isProject = mode.value === 'projects';
  const asset = selectedAsset.value;
  if (isProject) {
    if (!selectedProjectId.value || !projectIsWebsite.value) return;
  } else if (!asset || asset.kind !== 'bundle') {
    return;
  }
  deployBusy.value = true;
  deployError.value = '';
  try {
    const started = await startAssetSiteDeploy(
      isProject
        ? { projectId: selectedProjectId.value!, access: 'lan' }
        : { assetId: asset!.id, access: 'lan' },
    );
    deployActive.value = true;
    deployUrl.value = started.url || started.localUrl || '';
    if (deployUrl.value) await openExternalBestEffort(deployUrl.value);
  } catch (error) {
    deployError.value = error instanceof Error ? error.message : String(error);
  } finally {
    deployBusy.value = false;
    await refreshSiteDeployStatus(
      isProject ? { projectId: selectedProjectId.value } : { assetId: asset?.id },
    );
  }
}

async function stopSelectedSiteDeploy() {
  if (stopDeployBusy.value) return;
  const isProject = mode.value === 'projects';
  const asset = selectedAsset.value;
  if (isProject) {
    if (!selectedProjectId.value || !projectIsWebsite.value) return;
  } else if (!asset || asset.kind !== 'bundle') {
    return;
  }
  stopDeployBusy.value = true;
  deployError.value = '';
  try {
    await stopAssetSiteDeploy(isProject ? { projectId: selectedProjectId.value! } : { assetId: asset!.id });
    deployActive.value = false;
    deployUrl.value = '';
  } catch (error) {
    deployError.value = error instanceof Error ? error.message : String(error);
  } finally {
    stopDeployBusy.value = false;
    await refreshSiteDeployStatus(
      isProject ? { projectId: selectedProjectId.value } : { assetId: asset?.id },
    );
  }
}

function openDeployUrl() {
  if (deployUrl.value) void openExternalBestEffort(deployUrl.value);
}

const filteredProjects = computed(() => {
  const q = projectQuery.value.trim().toLowerCase();
  return projects.value
    .filter((project) => project.workspacePath)
    .filter((project) => !q || project.name.toLowerCase().includes(q) || project.goal.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
});
const selectedProject = computed(() => projects.value.find((project) => project.id === selectedProjectId.value) ?? null);
const visibleTree = computed(() =>
  deliverableEntries(treeEntries.value).filter((entry) =>
    entry.relative
      .split('/')
      .slice(0, -1)
      .every((_, index, parts) => !collapsedDirectories.value.has(parts.slice(0, index + 1).join('/'))),
  ),
);
const treeFileCount = computed(() => deliverableEntries(treeEntries.value).filter((entry) => entry.type === 'file').length);

const conversationGroups = computed(() => {
  const map = new Map<string, { id: string; count: number; latest: number; title: string }>();
  for (const asset of assets.value) {
    if (!asset.conversationId) continue;
    const existing = map.get(asset.conversationId);
    if (existing) {
      existing.count += 1;
      existing.latest = Math.max(existing.latest, asset.createdAt);
    } else {
      map.set(asset.conversationId, {
        id: asset.conversationId,
        count: 1,
        latest: asset.createdAt,
        title: conversationTitle(asset.conversationId) || `会话 ${shortId(asset.conversationId)}`,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.latest - a.latest || b.count - a.count || a.title.localeCompare(b.title, 'zh-CN'));
});
const filteredConversationGroups = computed(() => {
  const q = sessionQuery.value.trim().toLowerCase();
  if (!q) return conversationGroups.value;
  return conversationGroups.value.filter((group) => group.title.toLowerCase().includes(q) || group.id.toLowerCase().includes(q));
});
const activeConversationFilter = computed(() => {
  if (!archiveScope.value.startsWith('conversation:')) return null;
  const id = archiveScope.value.slice('conversation:'.length);
  return conversationGroups.value.find((group) => group.id === id) ?? {
    id,
    count: assets.value.filter((asset) => asset.conversationId === id).length,
    latest: 0,
    title: conversationTitle(id) || `会话 ${shortId(id)}`,
  };
});
const filteredAssets = computed(() =>
  assets.value.filter((asset) => {
    if (archiveScope.value.startsWith('conversation:') && asset.conversationId !== archiveScope.value.slice('conversation:'.length)) return false;
    if (archiveScope.value === 'unlinked' && asset.projectId) return false;
    if (!archiveScope.value.startsWith('conversation:') && archiveScope.value !== 'all' && archiveScope.value !== 'unlinked' && asset.projectId !== archiveScope.value) return false;
    if (archiveType.value !== 'all' && !asset.name.toLowerCase().endsWith(`.${archiveType.value}`)) return false;
    if (!asset.name.toLowerCase().includes(archiveQuery.value.trim().toLowerCase())) return false;
    return true;
  }),
);
const archiveTypes = computed(
  () => [...new Set(assets.value.map((asset) => asset.name.split('.').pop()?.toLowerCase()).filter(Boolean))] as string[],
);
const projectsWithWorkspace = computed(() => projects.value.filter((project) => project.workspacePath).sort((a, b) => b.updatedAt - a.updatedAt));
const checkedCount = computed(() => checkedAssetIds.value.length);
const allFilteredChecked = computed(
  () => filteredAssets.value.length > 0 && filteredAssets.value.every((asset) => checkedAssetIds.value.includes(asset.id)),
);

function projectName(projectId: string | null) {
  if (!projectId) return null;
  return projects.value.find((project) => project.id === projectId)?.name ?? projectId.slice(0, 8);
}
function toggleCheck(assetId: string, event?: Event) {
  event?.stopPropagation();
  if (checkedAssetIds.value.includes(assetId)) checkedAssetIds.value = checkedAssetIds.value.filter((id) => id !== assetId);
  else checkedAssetIds.value = [...checkedAssetIds.value, assetId];
}
function toggleCheckAll() {
  if (allFilteredChecked.value) {
    const drop = new Set(filteredAssets.value.map((asset) => asset.id));
    checkedAssetIds.value = checkedAssetIds.value.filter((id) => !drop.has(id));
    return;
  }
  const next = new Set([...checkedAssetIds.value, ...filteredAssets.value.map((asset) => asset.id)]);
  checkedAssetIds.value = [...next];
}
async function confirmLinkToProject() {
  if (!linkTargetProjectId.value || !checkedAssetIds.value.length) return;
  const project = projects.value.find((item) => item.id === linkTargetProjectId.value);
  linkBusy.value = true;
  linkMessage.value = '';
  try {
    const result = await linkAssetsToProject({
      projectId: linkTargetProjectId.value,
      assetIds: [...checkedAssetIds.value],
      workspacePath: project?.workspacePath,
    });
    linkMessage.value = t('assets.linkDone')
      .replace('{updated}', String(result.updated))
      .replace('{copied}', String(result.copied));
    checkedAssetIds.value = [];
    linkPickerOpen.value = false;
    if (archiveScope.value === 'unlinked') archiveScope.value = 'all';
  } catch (error) {
    linkMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    linkBusy.value = false;
  }
}
async function unlinkSelected() {
  if (!checkedAssetIds.value.length) return;
  linkBusy.value = true;
  try {
    await unlinkAssetsFromProject([...checkedAssetIds.value]);
    checkedAssetIds.value = [];
    linkMessage.value = t('assets.unlinkDone');
  } catch (error) {
    linkMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    linkBusy.value = false;
  }
}

function pruneSelectionAfterDelete(removedIds: string[]) {
  const removed = new Set(removedIds);
  checkedAssetIds.value = checkedAssetIds.value.filter((id) => !removed.has(id));
  if (selectedAsset.value && removed.has(selectedAsset.value.id)) {
    selectedAsset.value = filteredAssets.value.find((asset) => !removed.has(asset.id)) ?? null;
  }
}

async function removeAssetsByIds(assetIds: string[], confirmText: string) {
  const ids = [...new Set(assetIds.filter(Boolean))];
  if (!ids.length) return;
  if (!window.confirm(confirmText)) return;
  deleteBusy.value = true;
  linkMessage.value = '';
  try {
    const result = await deleteAssets(ids);
    pruneSelectionAfterDelete(ids);
    if (archiveScope.value.startsWith('conversation:')) {
      const conversationId = archiveScope.value.slice('conversation:'.length);
      if (!assets.value.some((asset) => asset.conversationId === conversationId)) {
        archiveScope.value = 'all';
        sessionPickerOpen.value = false;
      }
    }
    linkMessage.value = t('assets.deleteDone').replace('{n}', String(result.deleted));
  } catch (error) {
    linkMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    deleteBusy.value = false;
  }
}

async function deleteSelected() {
  await removeAssetsByIds(
    [...checkedAssetIds.value],
    t('assets.deleteConfirm').replace('{n}', String(checkedAssetIds.value.length)),
  );
}

async function deleteCurrentAsset() {
  const asset = selectedAsset.value;
  if (!asset) return;
  await removeAssetsByIds(
    [asset.id],
    t('assets.deleteOneConfirm').replace('{name}', asset.workspaceRelative || asset.name),
  );
}

async function deleteListedAsset(asset: Asset) {
  selectedAsset.value = asset;
  await removeAssetsByIds(
    [asset.id],
    t('assets.deleteOneConfirm').replace('{name}', asset.workspaceRelative || asset.name),
  );
}

async function deleteSessionAssets(conversationId: string, title: string, count: number) {
  const ids = assets.value.filter((asset) => asset.conversationId === conversationId).map((asset) => asset.id);
  await removeAssetsByIds(
    ids,
    t('assets.deleteSessionConfirm').replace('{title}', title).replace('{n}', String(count || ids.length)),
  );
}

function selectConversationFilter(conversationId: string) {
  archiveScope.value = `conversation:${conversationId}`;
  sessionPickerOpen.value = false;
}

function clearConversationFilter() {
  archiveScope.value = 'all';
}
function openBundleFile(asset: Asset, relative: string) {
  void previewAssetUrl(asset.id, relative).then((url) => window.open(url, '_blank', 'noopener'));
}

watch(mode, (value) => { void writeStored(ASSET_MODE_KEY, value); });
watch(
  filteredProjects,
  (list) => {
    if (!list.length) {
      selectedProjectId.value = null;
      return;
    }
    if (!selectedProjectId.value || !list.some((item) => item.id === selectedProjectId.value)) {
      selectedProjectId.value = list[0].id;
    }
  },
  { immediate: true },
);
watch(
  filteredAssets,
  (list) => {
    if (mode.value !== 'archive') return;
    if (!list.length) {
      selectedAsset.value = null;
      return;
    }
    if (!selectedAsset.value || !list.some((item) => item.id === selectedAsset.value?.id)) selectedAsset.value = list[0];
  },
  { immediate: true },
);
watch(selectedProjectId, () => {
  selectedRelative.value = '';
  deployError.value = '';
  deployActive.value = false;
  deployUrl.value = '';
  void loadProjectTree();
});
watch(selectedRelative, () => {
  if (mode.value === 'projects') void loadProjectPreview();
});
watch(treeEntries, () => {
  if (mode.value === 'projects') void refreshSiteDeployStatus({ projectId: selectedProjectId.value });
});
watch(selectedAsset, () => {
  deployError.value = '';
  if (mode.value === 'archive') {
    void loadArchivePreview();
    void refreshSiteDeployStatus({ assetId: selectedAsset.value?.id });
  } else {
    deployActive.value = false;
    deployUrl.value = '';
  }
});
watch(mode, (value) => {
  deployError.value = '';
  if (value === 'projects') {
    void loadProjectPreview();
    void refreshSiteDeployStatus({ projectId: selectedProjectId.value });
  } else {
    void loadArchivePreview();
    void refreshSiteDeployStatus({ assetId: selectedAsset.value?.id });
  }
});

function statusText(status: Project['status']) {
  return ({ draft: '草稿', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消' } as const)[status] || status;
}
function formatBytes(value: number) {
  return value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
}
function formatDate(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}
function employeeName(id: string | null) {
  if (!id) return t('assets.employeeUnknown');
  const key = `employee.${id}.name`;
  const label = t(key);
  return label === key ? id : label;
}
function conversationTitle(id: string | null) {
  if (!id) return null;
  return props.conversations.find((item) => item.id === id || item.serverSessionId === id)?.title ?? null;
}
function openConversationFromAsset(id: string | null) {
  if (!id) return;
  emit('openConversation', id);
}
function shortId(value: string) {
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}
function fileDepth(entry: ProjectFileEntry) {
  return Math.max(0, entry.relative.split('/').length - 1);
}
function fileName(entry: ProjectFileEntry) {
  return entry.relative.split('/').pop() ?? entry.relative;
}
function toggleDirectory(entry: ProjectFileEntry) {
  const next = new Set(collapsedDirectories.value);
  if (next.has(entry.relative)) next.delete(entry.relative);
  else next.add(entry.relative);
  collapsedDirectories.value = next;
}
function imageMime(name: string) {
  const ext = fileExt(name);
  return (
    (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        bmp: 'image/bmp',
        ico: 'image/x-icon',
      } as Record<string, string>
    )[ext] || 'application/octet-stream'
  );
}
function clearPreview() {
  previewError.value = '';
  previewKind.value = 'unsupported';
  previewTitle.value = '';
  previewHtmlUrl.value = '';
  previewText.value = '';
  previewImageUrl.value = '';
  previewMeta.value = [];
}

async function loadProjectTree() {
  const project = selectedProject.value;
  treeEntries.value = [];
  if (!project?.workspacePath) return;
  treeLoading.value = true;
  try {
    treeEntries.value = await listWorkspaceFiles(project.workspacePath);
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : String(error);
  } finally {
    treeLoading.value = false;
  }
}

async function refreshProjectLibrary() {
  if (mode.value !== 'projects' || treeLoading.value) return;
  await loadProjects();
  await loadProjectTree();
}

async function selectTreeEntry(entry: ProjectFileEntry) {
  if (entry.type === 'directory') {
    toggleDirectory(entry);
    return;
  }
  selectedRelative.value = entry.relative;
}

async function loadProjectPreview() {
  clearPreview();
  const project = selectedProject.value;
  if (!project?.workspacePath || !selectedRelative.value) return;
  previewLoading.value = true;
  previewTitle.value = selectedRelative.value;
  previewKind.value = previewKindForName(selectedRelative.value);
  previewMeta.value = [`${project.name} · 本地项目`, project.workspacePath];
  try {
    if (previewKind.value === 'html' || previewKind.value === 'pdf') {
      previewHtmlUrl.value = await previewWorkspaceFileUrl(project.workspacePath, selectedRelative.value);
    } else {
      const payload = await readWorkspacePreview(project.workspacePath, selectedRelative.value);
      previewMeta.value = [`${project.name} · 本地项目`, formatBytes(payload.bytes)];
      if (previewKind.value === 'image') {
        if (payload.base64) {
          previewImageUrl.value = `data:${imageMime(payload.name)};base64,${payload.base64}`;
        } else if (payload.content != null && /\.svg$/i.test(payload.name)) {
          previewImageUrl.value = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(payload.content)}`;
        }
      } else if (payload.content != null) {
        previewText.value = payload.content;
        if (previewKind.value === 'markdown') {
          /* text kept for markdown renderer */
        } else if (previewKind.value === 'unsupported') {
          previewKind.value = 'code';
        }
      }
    }
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : String(error);
  } finally {
    previewLoading.value = false;
  }
}

async function loadArchivePreview() {
  clearPreview();
  const asset = selectedAsset.value;
  if (!asset) return;
  previewLoading.value = true;
  previewTitle.value = asset.kind === 'bundle' ? `${asset.name} · ${asset.manifest?.files.length || 0} 个文件` : asset.name;
  previewKind.value = previewKindForName(asset.entryPath || asset.name);
  previewMeta.value = [
    `本地归档 · ${formatBytes(asset.sizeBytes)}`,
    asset.workspaceRelative && asset.workspaceRelative !== asset.name ? asset.workspaceRelative : asset.name,
    `${formatDate(asset.createdAt)} · ${employeeName(asset.employeeId)}${asset.projectId ? ` · ${projectName(asset.projectId)}` : ` · ${t('assets.unlinkedBadge')}`}`,
  ];
  try {
    if (asset.kind === 'bundle') {
      previewHtmlUrl.value = await previewAssetUrl(asset.id, asset.entryPath || 'index.html');
    } else if (previewKind.value === 'html' || previewKind.value === 'pdf') {
      previewHtmlUrl.value = await previewAssetUrl(asset.id, asset.name);
    } else {
      const payload = await readArchivedAssetPreview(asset.id);
      if (previewKind.value === 'image') {
        if (payload.base64) {
          previewImageUrl.value = `data:${payload.mimeType || imageMime(payload.name)};base64,${payload.base64}`;
        } else if (payload.content != null && /\.svg$/i.test(payload.name || asset.name)) {
          previewImageUrl.value = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(payload.content)}`;
        }
      } else if (payload.content != null) {
        previewText.value = payload.content;
        if (previewKind.value === 'unsupported') previewKind.value = 'code';
      }
    }
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : String(error);
  } finally {
    previewLoading.value = false;
  }
}

async function refreshCurrent() {
  if (mode.value === 'projects') {
    await loadProjectTree();
    await loadProjectPreview();
  } else {
    await loadAssets();
    await loadArchivePreview();
  }
}

async function revealCurrent() {
  if (mode.value === 'projects' && selectedProject.value?.workspacePath && selectedRelative.value) {
    if (await revealWorkspaceFileBestEffort(selectedProject.value.workspacePath, selectedRelative.value)) return;
    await copyText('project-link', copyableWorkspaceFileUrl(selectedProject.value.workspacePath, selectedRelative.value));
    return;
  }
  if (selectedAsset.value) {
    if (await revealAssetBestEffort(selectedAsset.value.id)) return;
    await copyText('asset-link', copyableAssetUrl(selectedAsset.value.id));
  }
}

async function downloadCurrent() {
  if (mode.value === 'archive' && selectedAsset.value) {
    await downloadAssetBestEffort(selectedAsset.value.id);
    return;
  }
  if (mode.value === 'projects' && selectedProject.value?.workspacePath && selectedRelative.value) {
    await downloadWorkspaceFileBestEffort(selectedProject.value.workspacePath, selectedRelative.value);
  }
}

async function openInBrowser() {
  try {
    if (mode.value === 'projects' && selectedProject.value?.workspacePath && selectedRelative.value) {
      await openWorkspaceFileBestEffort(selectedProject.value.workspacePath, selectedRelative.value);
      return;
    }
    if (selectedAsset.value) {
      if (selectedAsset.value.kind === 'bundle') openBundleFile(selectedAsset.value, selectedAsset.value.entryPath || 'index.html');
      else await openAssetBestEffort(selectedAsset.value.id);
    }
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : String(error);
  }
}

type FileKind = 'pdf' | 'image' | 'sheet' | 'doc' | 'code' | 'file';
function fileKind(asset: Asset): FileKind {
  const ext = asset.name.split('.').pop()?.toLowerCase() || '';
  if (ext === 'pdf') return 'pdf';
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(ext)) return 'image';
  if (/^(xlsx?|csv|tsv)$/.test(ext)) return 'sheet';
  if (/^(docx?|md|txt|rtf)$/.test(ext)) return 'doc';
  if (/^(ts|js|py|json|ya?ml|html|css)$/.test(ext)) return 'code';
  return 'file';
}
function kindStyle(kind: FileKind) {
  const map: Record<FileKind, { badge: string }> = {
    pdf: { badge: 'bg-rose-500/15 text-rose-700' },
    image: { badge: 'bg-violet-500/15 text-violet-700' },
    sheet: { badge: 'bg-emerald-500/15 text-emerald-700' },
    doc: { badge: 'bg-sky-500/15 text-sky-700' },
    code: { badge: 'bg-amber-500/15 text-amber-800' },
    file: { badge: 'bg-[var(--surface-muted)] text-[var(--muted)]' },
  };
  return map[kind];
}
function typeLabel(asset: Asset) {
  if (asset.kind === 'bundle') return 'SITE';
  return asset.name.split('.').pop()?.toUpperCase() || 'FILE';
}

function isSpreadsheetAsset(asset: Asset | null | undefined) {
  if (!asset || asset.kind === 'bundle') return false;
  const ext = (asset.workspaceRelative || asset.name).split('.').pop()?.toLowerCase() || '';
  return ext === 'xlsx' || ext === 'csv';
}

function isSpreadsheetPath(relative: string) {
  const ext = relative.split('.').pop()?.toLowerCase() || '';
  return ext === 'xlsx' || ext === 'csv';
}

const canImportToData = computed(() => {
  if (mode.value === 'archive') return isSpreadsheetAsset(selectedAsset.value);
  return Boolean(selectedProjectId.value && selectedRelative.value && isSpreadsheetPath(selectedRelative.value));
});

async function importCurrentToDataWorkbench() {
  if (importBusy.value || !canImportToData.value) return;
  importBusy.value = true;
  try {
    let source;
    if (mode.value === 'archive' && selectedAsset.value) {
      source = await importDataFromAsset(selectedAsset.value.id);
    } else if (selectedProjectId.value && selectedRelative.value) {
      source = await importDataFromWorkspace({ projectId: selectedProjectId.value, relative: selectedRelative.value });
    } else {
      throw new Error('未选择可导入的表格文件');
    }
    notify.pushRaw('success', '已导入数据工作台', `${source.name} · ${source.tableCount || 0} 张表`);
    emit('openData');
  } catch (error) {
    notify.pushRaw('error', error instanceof Error ? error.message : String(error));
  } finally {
    importBusy.value = false;
  }
}

async function importListedAssetToDataWorkbench(asset: Asset) {
  if (importBusy.value || !isSpreadsheetAsset(asset)) return;
  selectedAsset.value = asset;
  importBusy.value = true;
  try {
    const source = await importDataFromAsset(asset.id);
    notify.pushRaw('success', '已导入数据工作台', `${source.name} · ${source.tableCount || 0} 张表`);
    emit('openData');
  } catch (error) {
    notify.pushRaw('error', error instanceof Error ? error.message : String(error));
  } finally {
    importBusy.value = false;
  }
}

async function copyText(label: string, value: string) {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = label;
    window.setTimeout(() => {
      if (copied.value === label) copied.value = '';
    }, 1600);
  } catch {
    /* clipboard unavailable */
  }
}

onMounted(async () => {
  const savedMode = await readStored(ASSET_MODE_KEY);
  if (savedMode === 'projects' || savedMode === 'archive') mode.value = savedMode;
  await Promise.all([loadProjects(), loadAssets()]);
  if (mode.value === 'projects') await loadProjectTree();
  projectRefreshTimer = setInterval(() => { void refreshProjectLibrary(); }, 5_000);
  window.addEventListener('focus', refreshProjectLibrary);
});
onBeforeUnmount(() => {
  if (projectRefreshTimer) clearInterval(projectRefreshTimer);
  window.removeEventListener('focus', refreshProjectLibrary);
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="mx-auto flex h-full min-h-0 w-full max-w-[1400px] flex-col px-6 py-8 sm:px-10">
      <header class="shrink-0">
        <p class="text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">OpenClawX / ASSETS</p>
        <div class="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 class="text-4xl font-bold tracking-[-.045em]">我的{{ t('assets.title') }}</h1>
            <p class="mt-2 max-w-2xl text-sm text-[var(--muted)]">仅展示当前登录用户归属的数据。{{ t('assets.subtitleNew') }}</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <span class="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[10px] font-bold text-[var(--muted)]">{{ t('assets.storageLocal') }}</span>
            <button class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-semibold hover:border-[var(--accent)]" type="button" @click="refreshCurrent">
              {{ loading || treeLoading || previewLoading ? t('assets.refreshing') : t('assets.refresh') }}
            </button>
          </div>
        </div>
        <div class="mt-5 inline-flex rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-1">
          <button
            :class="['rounded-lg px-4 py-2 text-sm font-semibold transition', mode === 'projects' ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm' : 'text-[var(--muted)]']"
            type="button"
            @click="mode = 'projects'"
          >{{ t('assets.tabProjects') }}</button>
          <button
            :class="['rounded-lg px-4 py-2 text-sm font-semibold transition', mode === 'archive' ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm' : 'text-[var(--muted)]']"
            type="button"
            @click="mode = 'archive'"
          >{{ t('assets.tabArchive') }} · {{ assets.length }}</button>
        </div>
      </header>

      <!-- 项目资产：项目列表 | 目录树 | 预览 -->
      <div v-if="mode === 'projects'" class="mt-5 grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[240px_minmax(220px,280px)_minmax(0,1fr)]">
        <div class="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
          <div class="border-b border-[var(--border)] p-3">
            <input v-model="projectQuery" class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]" :placeholder="t('assets.searchProjects')" />
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            <p v-if="!filteredProjects.length" class="px-2 py-8 text-center text-xs text-[var(--muted)]">{{ t('assets.noProjects') }}</p>
            <button
              v-for="project in filteredProjects"
              :key="project.id"
              :class="['mb-2 w-full rounded-2xl border px-3.5 py-3.5 text-left transition', selectedProjectId === project.id ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm' : 'border-[var(--border)]/70 bg-[var(--background)]/40 hover:border-[var(--accent)]/35 hover:bg-[var(--surface-muted)]']"
              type="button"
              @click="selectedProjectId = project.id"
            >
              <div class="flex items-center gap-3">
                <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-sky-500/20 to-emerald-500/20 text-[11px] font-extrabold text-sky-700">{{ project.name.slice(0, 2).toUpperCase() }}</span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center justify-between gap-2">
                    <strong class="truncate text-sm">{{ project.name }}</strong>
                    <span class="shrink-0 rounded-full bg-[var(--surface-muted)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--muted)]">{{ t('assets.storageLocal') }}</span>
                  </div>
                  <p class="mt-1 line-clamp-2 text-[11px] leading-4 text-[var(--muted)]">{{ project.goal }}</p>
                  <p class="mt-2 text-[10px] text-[var(--muted)]">{{ statusText(project.status) }} · {{ formatDate(project.updatedAt) }}</p>
                </div>
              </div>
            </button>
          </div>
        </div>

        <div class="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
          <div class="flex items-center justify-between border-b border-[var(--border)] px-3 py-3">
            <strong class="text-xs">{{ t('assets.projectTree') }}</strong>
            <span class="text-[10px] text-[var(--muted)]">{{ treeFileCount }} {{ t('assets.filesUnit') }}</span>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            <p v-if="treeLoading" class="px-2 py-6 text-xs text-[var(--muted)]">{{ t('assets.loadingTree') }}</p>
            <p v-else-if="!selectedProject" class="px-2 py-6 text-xs text-[var(--muted)]">{{ t('assets.pickProject') }}</p>
            <p v-else-if="!visibleTree.length" class="px-2 py-6 text-xs leading-5 text-[var(--muted)]">{{ t('assets.emptyTree') }}</p>
            <button
              v-for="entry in visibleTree"
              :key="entry.relative"
              type="button"
              :style="{ paddingLeft: `${10 + fileDepth(entry) * 14}px` }"
              :class="[
                'mb-0.5 flex w-full items-center gap-2 rounded-xl py-2 pr-2 text-left text-[13px] transition',
                entry.type === 'directory'
                  ? 'text-[var(--muted)] hover:bg-[var(--surface-muted)]'
                  : selectedRelative === entry.relative
                    ? 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)] ring-1 ring-[var(--accent)]/20'
                    : 'hover:bg-[var(--surface-muted)]',
              ]"
              @click="selectTreeEntry(entry)"
            >
              <span
                :class="[
                  'grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[10px] font-bold',
                  entry.type === 'directory'
                    ? 'bg-[var(--surface-muted)] text-[var(--muted)]'
                    : isSpreadsheetPath(entry.relative)
                      ? 'bg-emerald-500/15 text-emerald-700'
                      : 'bg-sky-500/10 text-sky-700',
                ]"
              >{{ entry.type === 'directory' ? (collapsedDirectories.has(entry.relative) ? '›' : '⌄') : (fileExt(entry.relative) || '·').slice(0, 3).toUpperCase() }}</span>
              <span class="min-w-0 flex-1 truncate">{{ fileName(entry) }}</span>
              <span v-if="entry.type === 'file' && isSpreadsheetPath(entry.relative)" class="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">表</span>
            </button>
          </div>
          <div v-if="selectedProject" class="border-t border-[var(--border)] p-3">
            <button class="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="emit('openProject', selectedProject.id)">{{ t('assets.openProjectWorkspace') }}</button>
          </div>
        </div>

        <AssetPreviewPane
          :desktop-shell="isDesktopShell()"
          :title="previewTitle"
          :storage-label="t('assets.storageLocal')"
          :meta-lines="deployError ? [...previewMeta, deployError] : previewMeta"
          :loading="previewLoading"
          :error="previewError"
          :kind="previewKind"
          :html-url="previewHtmlUrl"
          :text="previewText"
          :image-url="previewImageUrl"
          :can-deploy="projectIsWebsite"
          :deploying="deployBusy"
          :stopping-deploy="stopDeployBusy"
          :deployed="deployActive"
          :deploy-url="deployUrl"
          :can-import-data="canImportToData"
          :importing-data="importBusy"
          @refresh="loadProjectPreview"
          @reveal="revealCurrent"
          @download="downloadCurrent"
          @open-browser="openInBrowser"
          @deploy="deploySelectedSite"
          @stop-deploy="stopSelectedSiteDeploy"
          @open-deploy-url="openDeployUrl"
          @import-data="importCurrentToDataWorkbench"
        />
      </div>

      <!-- 会话资产：列表 + 预览 -->
      <div v-else class="mt-5 flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm lg:max-w-lg">
          <div class="shrink-0 border-b border-[var(--border)] p-4">
            <input v-model="archiveQuery" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" :placeholder="t('assets.search')" />
            <div v-if="conversationGroups.length" class="mt-3 border-t border-[var(--border)] pt-3">
              <div class="mb-2 flex items-center justify-between gap-2">
                <p class="text-[10px] font-bold tracking-wide text-[var(--muted)]">{{ t('assets.byConversation') }}</p>
                <span class="text-[10px] text-[var(--muted)]">{{ t('assets.sessionCount').replace('{n}', String(conversationGroups.length)) }}</span>
              </div>
              <div v-if="activeConversationFilter" class="mb-2 flex items-center gap-2 rounded-xl border border-[var(--accent)]/25 bg-[var(--accent-soft)]/50 px-2.5 py-2">
                <div class="min-w-0 flex-1">
                  <p class="truncate text-xs font-semibold" :title="activeConversationFilter.title">{{ activeConversationFilter.title }}</p>
                  <p class="text-[10px] text-[var(--muted)]">{{ t('assets.sessionAssets').replace('{n}', String(activeConversationFilter.count)) }}</p>
                </div>
                <button
                  class="shrink-0 rounded-lg border border-rose-500/35 px-2 py-1 text-[10px] font-semibold text-rose-700 hover:bg-rose-500/10 disabled:opacity-40"
                  type="button"
                  :disabled="deleteBusy || !activeConversationFilter.count"
                  @click="deleteSessionAssets(activeConversationFilter.id, activeConversationFilter.title, activeConversationFilter.count)"
                >{{ t('assets.deleteSession') }}</button>
                <button class="shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 text-[10px] font-semibold" type="button" @click="clearConversationFilter">{{ t('assets.clearSessionFilter') }}</button>
              </div>
              <div class="relative">
                <button
                  class="flex w-full items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-left text-xs font-semibold hover:border-[var(--accent)]"
                  type="button"
                  @click="sessionPickerOpen = !sessionPickerOpen"
                >
                  <span class="truncate text-[var(--muted)]">{{ t('assets.searchSessions') }}</span>
                  <span class="text-[var(--muted)]">{{ sessionPickerOpen ? '▴' : '▾' }}</span>
                </button>
                <div v-if="sessionPickerOpen" class="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl">
                  <div class="border-b border-[var(--border)] p-2">
                    <input
                      v-model="sessionQuery"
                      class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--accent)]"
                      :placeholder="t('assets.searchSessions')"
                      @keydown.escape="sessionPickerOpen = false"
                    />
                  </div>
                  <div class="max-h-52 overflow-y-auto p-1">
                    <p v-if="!filteredConversationGroups.length" class="px-2 py-4 text-center text-[11px] text-[var(--muted)]">{{ t('assets.noMatchingSessions') }}</p>
                    <div
                      v-for="group in filteredConversationGroups"
                      :key="group.id"
                      :class="['mb-0.5 flex items-center gap-1 rounded-lg px-1.5 py-1', archiveScope === `conversation:${group.id}` ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--surface-muted)]']"
                    >
                      <button class="min-w-0 flex-1 truncate px-1 py-1.5 text-left text-xs font-semibold" type="button" :title="group.title" @click="selectConversationFilter(group.id)">
                        <span class="block truncate">{{ group.title }}</span>
                        <span class="mt-0.5 block text-[10px] font-medium text-[var(--muted)]">{{ t('assets.sessionAssets').replace('{n}', String(group.count)) }} · {{ formatDate(group.latest) }}</span>
                      </button>
                      <button
                        class="shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold text-rose-600 hover:bg-rose-500/10 disabled:opacity-40"
                        type="button"
                        :title="t('assets.deleteSession')"
                        :disabled="deleteBusy"
                        @click.stop="deleteSessionAssets(group.id, group.title, group.count)"
                      >{{ t('assets.delete') }}</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="mt-3 flex flex-wrap gap-2">
              <button :class="['rounded-lg px-3 py-1.5 text-xs font-semibold', archiveType === 'all' ? 'bg-[var(--surface)] ring-1 ring-[var(--accent)]/40' : 'bg-[var(--surface-muted)] text-[var(--muted)]']" type="button" @click="archiveType = 'all'">ext</button>
              <button v-for="item in archiveTypes" :key="item" :class="['rounded-lg px-3 py-1.5 text-xs font-semibold uppercase', archiveType === item ? 'bg-[var(--surface)] ring-1 ring-[var(--accent)]/40' : 'bg-[var(--surface-muted)] text-[var(--muted)]']" type="button" @click="archiveType = item">{{ item }}</button>
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <button class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-semibold" type="button" @click="toggleCheckAll">{{ allFilteredChecked ? t('assets.uncheckAll') : t('assets.checkAll') }}</button>
              <span class="text-[11px] text-[var(--muted)]">{{ t('assets.checkedCount').replace('{n}', String(checkedCount)) }}</span>
              <button class="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-40" type="button" :disabled="!checkedCount || linkBusy || deleteBusy" @click="linkPickerOpen = true; linkTargetProjectId = projectsWithWorkspace[0]?.id || ''">{{ t('assets.linkToProject') }}</button>
              <button class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-semibold disabled:opacity-40" type="button" :disabled="!checkedCount || linkBusy || deleteBusy" @click="unlinkSelected">{{ t('assets.unlinkFromProject') }}</button>
              <button class="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-rose-700 disabled:opacity-40" type="button" :disabled="!checkedCount || deleteBusy || linkBusy" @click="deleteSelected">{{ deleteBusy ? t('assets.deleting') : t('assets.deleteSelected') }}</button>
            </div>
            <p v-if="linkMessage" class="mt-2 text-[11px] text-[var(--muted)]">{{ linkMessage }}</p>
            <div v-if="linkPickerOpen" class="mt-3 rounded-xl border border-[var(--border)] bg-[var(--background)] p-3">
              <p class="text-xs font-semibold">{{ t('assets.pickLinkProject') }}</p>
              <select v-model="linkTargetProjectId" class="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm">
                <option v-for="project in projectsWithWorkspace" :key="project.id" :value="project.id">{{ project.name }}</option>
              </select>
              <p class="mt-2 text-[11px] text-[var(--muted)]">{{ t('assets.linkCopyHint') }}</p>
              <div class="mt-3 flex gap-2">
                <button class="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" type="button" :disabled="!linkTargetProjectId || linkBusy" @click="confirmLinkToProject">{{ linkBusy ? t('assets.linking') : t('assets.confirmLink') }}</button>
                <button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold" type="button" @click="linkPickerOpen = false">{{ t('assets.cancel') }}</button>
              </div>
            </div>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            <p v-if="!filteredAssets.length" class="px-4 py-12 text-center text-xs text-[var(--muted)]">{{ t('assets.emptyHint') }}</p>
            <div
              v-for="asset in filteredAssets"
              :key="asset.id"
              :class="['group mb-2 flex w-full items-center gap-2 rounded-2xl border px-2.5 py-3 transition', selectedAsset?.id === asset.id ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)] shadow-sm' : 'border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-muted)]']"
            >
              <input class="mx-1" type="checkbox" :checked="checkedAssetIds.includes(asset.id)" @click="toggleCheck(asset.id, $event)" />
              <button class="flex min-w-0 flex-1 items-center gap-3 text-left" type="button" @click="selectedAsset = asset">
                <span :class="['grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-[10px] font-extrabold shadow-sm ring-1 ring-black/5', kindStyle(fileKind(asset)).badge]">{{ typeLabel(asset) }}</span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-2">
                    <span class="block truncate text-sm font-semibold">{{ asset.workspaceRelative || asset.name }}</span>
                    <em v-if="asset.kind === 'bundle'" class="not-italic shrink-0 rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--accent)]">SITE</em>
                    <em v-else-if="isSpreadsheetAsset(asset)" class="not-italic shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">表格</em>
                  </span>
                  <span class="mt-1 block truncate text-xs text-[var(--muted)]">
                    {{ formatDate(asset.createdAt) }} · {{ formatBytes(asset.sizeBytes) }}
                    · {{ asset.projectId ? projectName(asset.projectId) : t('assets.unlinkedBadge') }}
                  </span>
                </span>
                <span class="rounded-full bg-[var(--surface-muted)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--muted)]">{{ t('assets.storageLocalArchive') }}</span>
              </button>
              <button
                v-if="isSpreadsheetAsset(asset)"
                class="shrink-0 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-700 opacity-0 hover:bg-emerald-500/15 group-hover:opacity-100 focus:opacity-100 disabled:opacity-40"
                type="button"
                :disabled="importBusy"
                title="导入数据工作台"
                @click.stop="importListedAssetToDataWorkbench(asset)"
              >导入</button>
              <button
                class="shrink-0 rounded-lg px-2 py-1 text-[10px] font-semibold text-rose-600 opacity-0 hover:bg-rose-500/10 group-hover:opacity-100 focus:opacity-100 disabled:opacity-40"
                type="button"
                :disabled="deleteBusy"
                :title="t('assets.delete')"
                @click.stop="deleteListedAsset(asset)"
              >{{ t('assets.delete') }}</button>
            </div>
          </div>
        </div>

        <div class="flex min-h-0 min-w-0 flex-[1.4] flex-col gap-3">
          <AssetPreviewPane
            class="min-h-[280px] flex-1"
            :desktop-shell="isDesktopShell()"
            :title="previewTitle"
            :storage-label="t('assets.storageLocalArchive')"
            :meta-lines="deployError ? [...previewMeta, deployError] : previewMeta"
            :loading="previewLoading"
            :error="previewError"
            :kind="previewKind"
            :html-url="previewHtmlUrl"
            :text="previewText"
            :image-url="previewImageUrl"
            :can-delete="Boolean(selectedAsset)"
            :deleting="deleteBusy"
            :can-deploy="selectedAsset?.kind === 'bundle'"
            :deploying="deployBusy"
            :stopping-deploy="stopDeployBusy"
            :deployed="deployActive"
            :deploy-url="deployUrl"
            :can-import-data="canImportToData"
            :importing-data="importBusy"
            @refresh="loadArchivePreview"
            @reveal="revealCurrent"
            @download="downloadCurrent"
            @open-browser="openInBrowser"
            @delete="deleteCurrentAsset"
            @deploy="deploySelectedSite"
            @stop-deploy="stopSelectedSiteDeploy"
            @open-deploy-url="openDeployUrl"
            @import-data="importCurrentToDataWorkbench"
          />
          <div v-if="selectedAsset" class="shrink-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm shadow-sm">
            <p class="text-[10px] font-bold uppercase tracking-[.12em] text-[var(--muted)]">{{ t('assets.sectionInfo') }}</p>
            <dl class="mt-2 grid gap-2 sm:grid-cols-2">
              <div><dt class="text-xs text-[var(--muted)]">{{ t('assets.fromEmployee') }}</dt><dd class="font-medium">{{ employeeName(selectedAsset.employeeId) }}</dd></div>
              <div>
                <dt class="text-xs text-[var(--muted)]">{{ t('assets.linkedProject') }}</dt>
                <dd class="font-medium">{{ selectedAsset.projectId ? projectName(selectedAsset.projectId) : t('assets.unlinkedBadge') }}</dd>
              </div>
              <div>
                <dt class="text-xs text-[var(--muted)]">{{ t('assets.workspacePath') }}</dt>
                <dd class="font-mono text-xs">{{ selectedAsset.workspaceRelative || selectedAsset.name }}</dd>
              </div>
              <div>
                <dt class="text-xs text-[var(--muted)]">{{ t('assets.fromConversation') }}</dt>
                <dd class="font-medium">
                  <button v-if="selectedAsset.conversationId" class="text-[var(--accent)] hover:underline" type="button" @click="openConversationFromAsset(selectedAsset.conversationId)">{{ conversationTitle(selectedAsset.conversationId) || t('assets.unnamedConversation') }}</button>
                  <span v-else>—</span>
                </dd>
              </div>
            </dl>
            <div v-if="selectedAsset.kind === 'bundle'" class="mt-3 rounded-xl bg-[var(--surface-muted)] p-3">
              <p class="text-xs font-semibold">网站包文件 · {{ selectedAsset.manifest?.files.length || 0 }}</p>
              <div class="mt-2 max-h-32 overflow-y-auto font-mono text-[11px]">
                <button v-for="file in selectedAsset.manifest?.files || []" :key="file.path" class="block w-full truncate rounded px-1 py-0.5 text-left hover:bg-[var(--surface)]" type="button" @click="openBundleFile(selectedAsset, file.path)">{{ file.path }}</button>
              </div>
            </div>
            <button class="mt-3 text-xs font-semibold text-[var(--muted)]" type="button" @click="showTechnical = !showTechnical">{{ t('assets.technical') }} {{ showTechnical ? '−' : '+' }}</button>
            <div v-if="showTechnical" class="mt-2 space-y-2 rounded-xl bg-[var(--surface-muted)] p-3 font-mono text-[11px]">
              <p>run: {{ shortId(selectedAsset.runId) }} <button class="ml-2 text-[var(--accent)]" type="button" @click="copyText('run', selectedAsset.runId)">{{ copied === 'run' ? t('assets.copied') : t('assets.copy') }}</button></p>
              <p>sha: {{ shortId(selectedAsset.sha256) }} <button class="ml-2 text-[var(--accent)]" type="button" @click="copyText('sha', selectedAsset.sha256)">{{ copied === 'sha' ? t('assets.copied') : t('assets.copy') }}</button></p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
