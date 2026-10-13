<script setup lang="ts">
import DataTaskDemo from './DataTaskDemo.vue';
import DataObjectAnnotationsEditor from './DataObjectAnnotationsEditor.vue';
import DatabaseConnectionDialog from './DatabaseConnectionDialog.vue';
import LiveDatabaseDialog from './LiveDatabaseDialog.vue';
import LiveDataTester from './LiveDataTester.vue';
import StructuredDataQuery from './StructuredDataQuery.vue';
import DataAppCreateDialog, { type DataAppCreateDraft } from './DataAppCreateDialog.vue';
import { dataObjectAnnotationsSchema, type DataObjectAnnotations } from '@workmate/contracts';
const demoOpen = ref(false);
const databaseDialogOpen = ref(false);
const liveDatabaseOpen = ref(false);
const createCredentialRequired = ref(false);
const repairConnectionId = ref('');
function repairCreateConnection() { repairConnectionId.value = selected.value?.liveConnection?.connectionId || ''; liveDatabaseOpen.value = true; }
function connectionCredentialSaved(id: string) {
  if (id !== repairConnectionId.value || id !== selected.value?.liveConnection?.connectionId) return;
  liveDatabaseOpen.value = false; repairConnectionId.value = '';
  createError.value = ''; createCredentialRequired.value = false;
  createNotice.value = '连接测试与密码保存成功。应用名称和需求已保留，请点击“创建并开始”继续。';
}
async function liveDatabaseSaved(source: DataSource) {
  liveDatabaseOpen.value = false;
  sources.value = await listDataSources();
  await chooseSource(source.id);
  notice.value = '实时数据对象已创建，默认只读。可以补充字段说明并进入数据测试。';
}
function liveAccessUpdated(source: DataSource) { selected.value = source; notice.value = ''; modelSchema.value = ''; }
const databaseRefreshSource = ref<DataSource | null>(null);
function openDatabase(source: DataSource | null = null) { databaseRefreshSource.value = source; databaseDialogOpen.value = true; }
async function databaseSaved(source: DataSource) {
  databaseDialogOpen.value = false; databaseRefreshSource.value = null;
  sources.value = await listDataSources();
  await chooseSource(source.id);
  modelSchema.value = '';
  notice.value = source.databaseConnection?.truncatedTables.length ? '已接入数据库快照；部分表仅导入前 20,000 行，请查看对象说明。' : '数据库快照已保存，可以完善标注并创建应用。';
}
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  archivedAssetContentUrl,
  createSqliteDataSource,
  createApiDataSource,
  createMobileDataUploadSession,
  createDataAppProject,
  executeDataAppProject,
  deleteDataApp,
  deleteDataSource,
  getDataSource,
  getDataApp,
  getDataTableRows,
  importDataFile,
  listDataApps,
  listDataSources,
  renameDataSource,
  syncDataSource,
  updateApiDataSource,
  updateDataTableSchema,
  updateDataObjectAnnotations,
  getDataObjectSchema,
  type DataApp,
  type DataAppDetail,
  type DataSource,
  type DataTable,
} from '../../services/api';
import { qrDataUrl } from '../../app/qr-data-url.js';
import { openExternalBestEffort } from '../../app/platform-actions';
import DataAppOperator from './DataAppOperator.vue';
import { appPresentation, matchesSource, sourceNextStep, sortDataApps, formatAppTime, type AppSort } from './workbench-presentation';
import type { WorkbenchNavigation } from './workbench-navigation';

type SourceCategory = 'all' | 'files' | 'sqlite' | 'mysql' | 'other';

const props = defineProps<{ navigation?: WorkbenchNavigation; navigationScope?: string; employeeId?: string; permissionTier?: 'read-only' | 'default' | 'full' }>();
const emit = defineEmits<{ startChat: []; openProject: [projectId: string, startError?: string]; rememberNavigation: [navigation: WorkbenchNavigation, scope: string] }>();
let pendingNavigation = props.navigation;
const sources = ref<DataSource[]>([]);
const selected = ref<DataSource | null>(null);
const selectedTable = ref<DataTable | null>(null);
const objectTab = ref<WorkbenchNavigation['tab']>(props.navigation?.tab || 'overview');
const annotationsOpen = ref(false);
const annotationsSaving = ref(false);
const modelSchema = ref('');
const schemaReading = ref(false);
let selectionRequest = 0;
let disposed = false;
const preview = ref<{ columns: string[]; rows: string[][] }>({ columns: [], rows: [] });
const loading = ref(false);
const importing = ref(false);
const uploadStage = ref<'idle' | 'selecting' | 'reading' | 'sending' | 'processing' | 'done'>('idle');
const uploadProgress = ref(0);
const error = ref('');
const notice = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const activeApp = ref<DataAppDetail | null>(null);
const sourceApps = ref<DataApp[]>([]);
const appSort = ref<AppSort>('updated');
const sortedApps = computed(() => sortDataApps(sourceApps.value, appSort.value));
const latestAppId = computed(() => sortDataApps(sourceApps.value)[0]?.id);
const deletingId = ref('');
const deletingSourceId = ref('');
const renameOpen = ref(false);
const renameBusy = ref(false);
const renameDraft = ref('');
const renameTarget = ref<DataSource | null>(null);
const optimizeApp = ref<DataApp | null>(null);
const optimizeIdea = ref('');
const optimizeBusy = ref(false);
const activeCategory = ref<SourceCategory>(props.navigation?.category || 'all');
const sourceQuery = ref(props.navigation?.query || '');
const importKind = ref<'files' | 'sqlite' | 'json'>('files');
const createSqliteOpen = ref(false);
const sqliteName = ref('业务数据库');
const apiEditorOpen = ref(false);
const apiEditorBusy = ref(false);
const apiSyncBusy = ref(false);
const apiEditingId = ref('');
const apiForm = ref({
  name: 'API 数据源',
  baseUrl: 'https://',
  path: '/',
  method: 'GET' as 'GET' | 'POST',
  authType: 'none' as 'none' | 'bearer' | 'header',
  authHeaderName: 'Authorization',
  authToken: '',
  itemsPath: '',
  description: '',
  requestBody: '{\n  \n}',
  responseBody: '{\n  \n}',
  syncNow: true,
});
const schemaEditing = ref(false);
const schemaSaving = ref(false);
const schemaDraft = ref<DataTable | null>(null);
const mobileUploadOpen = ref(false);
const mobileUploadBusy = ref(false);
const mobileUploadUrl = ref('');
const mobileUploadQr = ref('');
const mobileUploadExpiresAt = ref(0);

const createOpen = ref(false);
const createBusy = ref(false);
let createIntent = { fingerprint: '', requestId: '' };
let optimizeIntent = { fingerprint: '', requestId: '' };
function intentId(kind: 'create' | 'optimize', fingerprint: string) {
  let intent = kind === 'create' ? createIntent : optimizeIntent;
  if (intent.fingerprint !== fingerprint || !intent.requestId) intent = { fingerprint, requestId: crypto.randomUUID() };
  if (kind === 'create') createIntent = intent; else optimizeIntent = intent;
  return intent.requestId;
}
const createError = ref('');
const createNotice = ref('');

const qrByApp = ref<Record<string, string>>({});
const navigator = window.navigator;

const hasSources = computed(() => sources.value.length > 0);
const summary = computed(() => selected.value ? `${selected.value.tableCount} 张表 · ${selected.value.accessMode === 'live' ? '实时连接' : selected.value.rowCount.toLocaleString() + ' 条'}` : '');
function categoryOf(source: DataSource): Exclude<SourceCategory, 'all'> {
  if (source.fileType === 'Excel' || source.fileType === 'CSV') return 'files';
  if (source.fileType === 'SQLite') return 'sqlite';
  if (source.fileType === 'MySQL' || source.fileType === 'PostgreSQL') return 'mysql';
  if (source.fileType === 'API' || source.fileType === 'JSON') return 'other';
  return 'other';
}
function isSpreadsheetSource(source: DataSource | null | undefined) {
  return Boolean(source && (source.fileType === 'Excel' || source.fileType === 'CSV'));
}
function isApiSource(source: DataSource | null | undefined) {
  return Boolean(source && source.fileType === 'API');
}
function canDeleteSource(source: DataSource | null | undefined) {
  if (!source || source.isDefault) return false;
  return ['Excel', 'CSV', 'SQLite', 'API', 'JSON', 'MySQL', 'PostgreSQL'].includes(source.fileType);
}
function canEditSource(source: DataSource | null | undefined) {
  return isSpreadsheetSource(source) || isApiSource(source);
}
const filteredSources = computed(() => sources.value.filter(source => (activeCategory.value === 'all' || categoryOf(source) === activeCategory.value) && matchesSource(source, sourceQuery.value)));
const categoryCount = (category: SourceCategory) => category === 'all' ? sources.value.length : sources.value.filter((source) => categoryOf(source) === category).length;
const acceptedFiles = computed(() => importKind.value === 'sqlite' ? '.sqlite,.sqlite3,.db' : importKind.value === 'json' ? '.json' : '.xlsx,.csv');
const currentAnnotations = computed(() => selected.value?.annotations || dataObjectAnnotationsSchema.parse({}));
const annotationCount = computed(() => selected.value?.tables?.reduce((sum, table) => sum + table.columns.filter(column => column.description?.trim()).length, 0) || 0);
const fieldCount = computed(() => selected.value?.tables?.reduce((sum, table) => sum + table.columns.length, 0) || 0);
const nextStep = computed(() => selected.value?.accessMode === 'live' ? { action: 'test', label: '测试实时数据', note: '通过 Gateway 验证查询；补充业务说明后供后续智能体与应用使用。' } : sourceNextStep(Boolean(currentAnnotations.value.description.trim()), annotationCount.value, fieldCount.value));
function followNextStep() {
  if (nextStep.value.action === 'test') { objectTab.value = 'preview'; return; }
  if (nextStep.value.action === 'description') annotationsOpen.value = true;
  else if (nextStep.value.action === 'fields') objectTab.value = 'schema';
  else openCreateWebsite();
}
function openAppIteration(app: DataApp) {
  optimizeIntent = { fingerprint: '', requestId: '' };
  optimizeApp.value = app;
  optimizeIdea.value = appPresentation(app).pending ? '继续完成尚未交付的部分，检查已有页面，并将最终页面绑定到这个应用。' : '';
}

function friendlyError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : '数据加载失败。';
  if (message.includes('Route GET:/api/data/sources not found')) {
    return '数据工作台服务尚未加载。请重启本地开发服务后再试。';
  }
  return message;
}
const uploadStatus = computed(() => ({
  idle: '',
  selecting: '正在等待你选择文件…',
  reading: '正在读取文件内容…',
  sending: '正在安全上传到本机…',
  processing: '正在识别工作表、字段和样例数据…',
  done: '数据已准备好。',
}[uploadStage.value] || ''));

async function refreshQrMap(apps: DataApp[]) {
  const next: Record<string, string> = {};
  await Promise.all(apps.map(async (app) => {
    const target = app.lanUrl || app.lanUrls?.[0] || app.publishUrl;
    if (!target || !appPresentation(app).canShare) return;
    try { next[app.id] = await qrDataUrl(target, 112); } catch { /* ignore */ }
  }));
  if (!disposed) qrByApp.value = next;
}

async function load() {
  if (loading.value) return;
  loading.value = true; error.value = '';
  try {
    const latestSources = await listDataSources();
    if (disposed) return;
    sources.value = latestSources;
    const sourceId = selected.value?.id || pendingNavigation?.sourceId;
    if (sourceId) {
      if (sources.value.some(source => source.id === sourceId)) {
        await chooseSource(sourceId, pendingNavigation);
      } else {
        showCatalog(activeCategory.value);
        notice.value = '原数据对象已不存在，已返回数据目录。';
      }
    }
  } catch (cause) { if (!disposed) error.value = friendlyError(cause); }
  finally { if (!disposed) loading.value = false; }
}
async function chooseSource(id: string, restore?: WorkbenchNavigation) {
  const requestId = ++selectionRequest;
  const tableId = restore?.tableId || (selected.value?.id === id ? selectedTable.value?.id : null);
  const tab = restore?.tab || (selected.value?.id === id ? objectTab.value : 'overview');
  error.value = ''; preview.value = { columns: [], rows: [] };
  try {
    const [source, apps] = await Promise.all([getDataSource(id), listDataApps(id)]);
    if (requestId !== selectionRequest) return;
    selected.value = source; sourceApps.value = apps; modelSchema.value = '';
    pendingNavigation = undefined;
    objectTab.value = tab;
    selectedTable.value = source.tables?.find(table => table.id === tableId) || source.tables?.[0] || null;
    if (selectedTable.value) await chooseTable(selectedTable.value);
    await refreshQrMap(sourceApps.value);
  } catch (cause) { if (requestId === selectionRequest) error.value = friendlyError(cause); }
}
async function openExistingApp(app: DataApp) {
  error.value = '';
  try { activeApp.value = await getDataApp(app.id); }
  catch (cause) { error.value = friendlyError(cause); }
}
async function openPublishedApp(app: DataApp) {
  // Desktop opens the loopback URL; LAN URLs are for QR/share targets.
  const url = app.publishUrl || app.lanUrl;
  if (url) await openExternalBestEffort(url);
}
async function chooseTable(table: DataTable) {
  if (!selected.value) return;
  selectedTable.value = table;
  if (selected.value.accessMode === 'live') { preview.value = { columns: [], rows: [] }; return; }
  const sourceId = selected.value.id;
  try {
    const rows = await getDataTableRows(sourceId, table.id);
    if (!disposed && selected.value?.id === sourceId && selectedTable.value?.id === table.id) preview.value = rows;
  }
  catch (cause) { if (!disposed && selected.value?.id === sourceId && selectedTable.value?.id === table.id) error.value = cause instanceof Error ? cause.message : '无法读取样例数据。'; }
}
function editSchema() {
  if (!selectedTable.value) return;
  schemaDraft.value = JSON.parse(JSON.stringify(selectedTable.value)) as DataTable;
  schemaEditing.value = true;
}
async function saveSchema() {
  if (!selected.value || !schemaDraft.value) return;
  schemaSaving.value = true; error.value = '';
  try {
    selected.value = await updateDataTableSchema(selected.value.id, schemaDraft.value);
    selectedTable.value = selected.value.tables?.find((table) => table.id === schemaDraft.value?.id) || null;
    if (selectedTable.value) await chooseTable(selectedTable.value);
    modelSchema.value = '';
    schemaEditing.value = false; notice.value = 'Schema 已更新，字段标识和底层数据保持不变。';
  } catch (cause) { error.value = friendlyError(cause); }
  finally { schemaSaving.value = false; }
}
async function saveAnnotations(value: DataObjectAnnotations) {
  if (!selected.value) return;
  annotationsSaving.value = true; error.value = '';
  try {
    selected.value = await updateDataObjectAnnotations(selected.value.id, value);
    sources.value = sources.value.map(source => source.id === selected.value?.id ? { ...source, annotations: value } : source);
    modelSchema.value = ''; annotationsOpen.value = false;
    notice.value = '数据对象说明已保存，AI 将读取最新内容。';
  } catch (cause) { error.value = friendlyError(cause); }
  finally { annotationsSaving.value = false; }
}
async function showModelSchema() {
  if (!selected.value) return;
  schemaReading.value = true; error.value = '';
  const id = selected.value.id;
  try {
    const schema = await getDataObjectSchema(id);
    if (selected.value?.id === id) modelSchema.value = JSON.stringify(schema, null, 2);
  } catch (cause) { error.value = friendlyError(cause); }
  finally { schemaReading.value = false; }
}
async function createSqlite() {
  if (!sqliteName.value.trim()) return;
  importing.value = true; error.value = '';
  try {
    const source = await createSqliteDataSource(sqliteName.value.trim());
    createSqliteOpen.value = false; await load(); await chooseSource(source.id);
    notice.value = `已创建「${source.name}」，可以编辑 Schema 后开始录入数据。`;
  } catch (cause) { error.value = friendlyError(cause); }
  finally { importing.value = false; }
}
async function openMobileUpload() {
  mobileUploadBusy.value = true; error.value = '';
  try {
    const session = await createMobileDataUploadSession();
    mobileUploadUrl.value = session.lanUrls[0] || session.url;
    mobileUploadExpiresAt.value = session.expiresAt;
    mobileUploadQr.value = await qrDataUrl(mobileUploadUrl.value, 220);
    mobileUploadOpen.value = true;
  } catch (cause) { error.value = friendlyError(cause); }
  finally { mobileUploadBusy.value = false; }
}
function openPicker(kind: 'files' | 'sqlite' | 'json' = 'files') {
  importKind.value = kind;
  uploadStage.value = 'selecting'; uploadProgress.value = 4;
  fileInput.value?.click();
  window.addEventListener('focus', () => window.setTimeout(() => {
    if (uploadStage.value === 'selecting') { uploadStage.value = 'idle'; uploadProgress.value = 0; }
  }, 260), { once: true });
}
function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件读取失败。'));
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}
async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  error.value = ''; notice.value = '';
  const valid = importKind.value === 'sqlite' ? /\.(sqlite|sqlite3|db)$/i.test(file.name) : importKind.value === 'json' ? /\.json$/i.test(file.name) : /\.(xlsx|csv)$/i.test(file.name);
  if (!valid) { error.value = importKind.value === 'sqlite' ? '请选择 SQLite (.sqlite/.sqlite3/.db) 数据库。' : importKind.value === 'json' ? '请选择 JSON 文件。' : '请选择 Excel (.xlsx) 或 CSV 文件。'; uploadStage.value = 'idle'; return; }
  if (file.size > 8 * 1024 * 1024) { error.value = '首期仅支持 8 MB 以内的数据文件。'; uploadStage.value = 'idle'; return; }
  importing.value = true;
  try {
    uploadStage.value = 'reading'; uploadProgress.value = 22;
    const contentBase64 = await fileToBase64(file);
    uploadStage.value = 'sending'; uploadProgress.value = 52;
    uploadStage.value = 'processing'; uploadProgress.value = 78;
    const source = await importDataFile({ name: file.name, contentBase64 });
    uploadStage.value = 'done'; uploadProgress.value = 100;
    await load(); await chooseSource(source.id);
    notice.value = `已读懂「${source.name}」，发现 ${source.tableCount} 张数据表。`;
    window.setTimeout(() => { if (uploadStage.value === 'done') { uploadStage.value = 'idle'; uploadProgress.value = 0; } }, 1400);
  } catch (cause) { error.value = friendlyError(cause); uploadStage.value = 'idle'; uploadProgress.value = 0; }
  finally { importing.value = false; (event.target as HTMLInputElement).value = ''; }
}
function openAsset() { if (selected.value?.assetId) window.open(archivedAssetContentUrl(selected.value.assetId), '_blank', 'noopener'); }
function openCreateApi() {
  apiEditingId.value = '';
  apiForm.value = {
    name: 'API 数据源',
    baseUrl: 'https://',
    path: '/',
    method: 'GET',
    authType: 'none',
    authHeaderName: 'Authorization',
    authToken: '',
    itemsPath: '',
    description: '',
    requestBody: '{\n  \n}',
    responseBody: '{\n  \n}',
    syncNow: true,
  };
  apiEditorOpen.value = true;
  error.value = '';
}
function openEditApi(source: DataSource, event?: Event) {
  event?.stopPropagation();
  if (!isApiSource(source)) return;
  apiEditingId.value = source.id;
  apiForm.value = {
    name: source.name,
    baseUrl: source.api?.baseUrl || 'https://',
    path: source.api?.path || '/',
    method: source.api?.method === 'POST' ? 'POST' : 'GET',
    authType: source.api?.authType || 'none',
    authHeaderName: source.api?.authHeaderName || 'Authorization',
    authToken: '',
    itemsPath: source.api?.itemsPath || '',
    description: source.api?.description || '',
    requestBody: source.api?.requestBody || '{\n  \n}',
    responseBody: source.api?.responseBody || '{\n  \n}',
    syncNow: false,
  };
  apiEditorOpen.value = true;
  error.value = '';
}
async function saveApiSource() {
  if (!apiForm.value.name.trim() || !apiForm.value.baseUrl.trim()) return;
  apiEditorBusy.value = true; error.value = '';
  try {
    const payload = {
      name: apiForm.value.name.trim(),
      baseUrl: apiForm.value.baseUrl.trim(),
      path: apiForm.value.path.trim() || '/',
      method: apiForm.value.method,
      authType: apiForm.value.authType,
      authHeaderName: apiForm.value.authHeaderName.trim() || undefined,
      ...(apiForm.value.authToken.trim() || !apiEditingId.value ? { authToken: apiForm.value.authToken.trim() } : {}),
      itemsPath: apiForm.value.itemsPath.trim(),
      description: apiForm.value.description.trim(),
      requestBody: apiForm.value.requestBody.trim() === '{\n  \n}' ? '' : apiForm.value.requestBody.trim(),
      responseBody: apiForm.value.responseBody.trim() === '{\n  \n}' ? '' : apiForm.value.responseBody.trim(),
      syncNow: apiForm.value.syncNow,
    };
    const source = apiEditingId.value
      ? await updateApiDataSource(apiEditingId.value, payload)
      : await createApiDataSource(payload);
    apiEditorOpen.value = false;
    await load();
    await chooseSource(source.id);
    notice.value = source.syncError
      ? `已保存「${source.name}」，但同步失败：${source.syncError}`
      : `已${apiEditingId.value ? '更新' : '创建'}「${source.name}」。`;
  } catch (cause) { error.value = friendlyError(cause); }
  finally { apiEditorBusy.value = false; }
}
async function syncSelectedApi() {
  if (!selected.value || !isApiSource(selected.value)) return;
  apiSyncBusy.value = true; error.value = '';
  try {
    selected.value = await syncDataSource(selected.value.id);
    modelSchema.value = '';
    sources.value = sources.value.map((item) => item.id === selected.value?.id ? { ...item, ...selected.value, tables: undefined } : item);
    selectedTable.value = selected.value.tables?.[0] || null;
    if (selectedTable.value) await chooseTable(selectedTable.value);
    notice.value = `已同步「${selected.value.name}」· ${selected.value.rowCount.toLocaleString()} 条。`;
  } catch (cause) { error.value = friendlyError(cause); }
  finally { apiSyncBusy.value = false; }
}
function openEditSource(source: DataSource, event?: Event) {
  if (isApiSource(source)) openEditApi(source, event);
  else openRenameSource(source, event);
}
function showCatalog(category: SourceCategory = 'all') { selectionRequest++; pendingNavigation = undefined; activeCategory.value = category; selected.value = null; selectedTable.value = null; sourceApps.value = []; modelSchema.value = ''; }

function openCreateWebsite() {
  if (!selectedTable.value) return;
  createCredentialRequired.value = false;
  createError.value = '';
  createNotice.value = '';
  createIntent = { fingerprint: '', requestId: '' };
  createOpen.value = true;
}

async function submitCreate(draft: DataAppCreateDraft) {
  if (!selected.value || createBusy.value || !selected.value.tables?.some(table => table.id === draft.tableId)) return;
  const sourceId = selected.value.id;
  createBusy.value = true; createError.value = ''; createNotice.value = ''; error.value = ''; createCredentialRequired.value = false;
  try {
      const idea = draft.idea.trim();
      if (!idea) { createError.value = '请先描述你希望应用做什么。'; return; }
      if (!props.employeeId) { createError.value = '请先选择可执行的数字员工。'; return; }
      const input = {
        queryMode: 'managed-readonly' as const,
        sourceId,
        tableId: draft.tableId,
        idea,
        name: draft.name,
        employeeId: props.employeeId, permissionTier: props.permissionTier || 'default',
      };
      const result = await createDataAppProject({ ...input, requestId: intentId('create', JSON.stringify(input)) });
      sourceApps.value = [...sourceApps.value.filter(app => app.id !== result.app.id), result.app];
      objectTab.value = 'apps';
      createOpen.value = false;
      notice.value = `已准备「${result.app.name}」。正在打开项目；页面绑定后才算交付。`;
      openAppProject(result.projectId, result.startError);
    // A refresh failure must not turn a successful creation into a retryable
    // creation error. Keep the result and do not issue a second create request.
    try {
      sourceApps.value = await listDataApps(sourceId);
      await refreshQrMap(sourceApps.value);
    } catch (cause) {
      error.value = `应用已创建，但列表刷新失败。请点击刷新，不要重复创建。${friendlyError(cause)}`;
    }
  } catch (cause) { createError.value = friendlyError(cause); createCredentialRequired.value = (cause as { code?: string })?.code === 'DATABASE_CREDENTIAL_REQUIRED'; }
  finally { createBusy.value = false; }
}

async function removeApp(app: DataApp) {
  if (!window.confirm(`确定删除应用「${app.name}」？站点链接将失效，底层数据表仍保留。`)) return;
  deletingId.value = app.id; error.value = '';
  try {
    await deleteDataApp(app.id);
    if (activeApp.value?.id === app.id) activeApp.value = null;
    if (selected.value) {
      sourceApps.value = await listDataApps(selected.value.id);
      await refreshQrMap(sourceApps.value);
    }
    notice.value = `已删除「${app.name}」。`;
  } catch (cause) { error.value = friendlyError(cause); }
  finally { deletingId.value = ''; }
}
function openRenameSource(source: DataSource, event?: Event) {
  event?.stopPropagation();
  if (!isSpreadsheetSource(source)) return;
  renameTarget.value = source;
  renameDraft.value = source.name.replace(/\.(xlsx|csv)$/i, '');
  renameOpen.value = true;
  error.value = '';
}
async function saveRenameSource() {
  if (!renameTarget.value || !renameDraft.value.trim()) return;
  renameBusy.value = true; error.value = '';
  try {
    const updated = await renameDataSource(renameTarget.value.id, renameDraft.value.trim());
    sources.value = sources.value.map((item) => item.id === updated.id ? { ...item, name: updated.name } : item);
    if (selected.value?.id === updated.id) selected.value = { ...selected.value, name: updated.name };
    renameOpen.value = false;
    renameTarget.value = null;
    notice.value = `已重命名为「${updated.name}」。`;
  } catch (cause) { error.value = friendlyError(cause); }
  finally { renameBusy.value = false; }
}
async function removeSource(source: DataSource, event?: Event) {
  event?.stopPropagation();
  if (!canDeleteSource(source)) return;
  if (!window.confirm(`确定删除「${source.name}」？关联的网站应用会一并删除，资产库中的原文件仍保留。`)) return;
  deletingSourceId.value = source.id; error.value = '';
  try {
    await deleteDataSource(source.id);
    sources.value = sources.value.filter((item) => item.id !== source.id);
    if (selected.value?.id === source.id) {
      selected.value = null;
      selectedTable.value = null;
      sourceApps.value = [];
      preview.value = { columns: [], rows: [] };
      activeApp.value = null;
    }
    notice.value = `已删除「${source.name}」。`;
  } catch (cause) { error.value = friendlyError(cause); }
  finally { deletingSourceId.value = ''; }
}
async function submitOptimize() {
  if (!optimizeApp.value || !optimizeIdea.value.trim() || optimizeBusy.value) return;
  optimizeBusy.value = true; error.value = '';
  try {
    const input = { idea: optimizeIdea.value.trim(), employeeId: props.employeeId, permissionTier: props.permissionTier || 'default' };
    const result = await executeDataAppProject(optimizeApp.value.id, { ...input, requestId: intentId('optimize', JSON.stringify({ appId: optimizeApp.value.id, ...input })) });
    optimizeApp.value = null; optimizeIdea.value = '';
    objectTab.value = 'apps';
    openAppProject(result.projectId, result.startError);
  } catch (cause) { error.value = friendlyError(cause); }
  finally { optimizeBusy.value = false; }
}

function openAppProject(id: string, startError?: string) {
  emit('rememberNavigation', { sourceId: selected.value?.id || null, tableId: selectedTable.value?.id || null,
    tab: 'apps', category: activeCategory.value, query: sourceQuery.value }, props.navigationScope || '');
  emit('openProject', id, startError);
}
onMounted(load);
onUnmounted(() => {
  disposed = true;
  emit('rememberNavigation', {
    sourceId: selected.value?.id || pendingNavigation?.sourceId || null,
    tableId: selectedTable.value?.id || pendingNavigation?.tableId || null,
    tab: objectTab.value, category: activeCategory.value, query: sourceQuery.value,
  }, props.navigationScope || '');
  selectionRequest++;
});
</script>

<template>
  <section class="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--background)]">
    <header class="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--border)] px-8 py-6">
      <div>
        <p class="text-xs font-bold tracking-[.14em] text-[var(--accent)]">WORKMATE / DATA</p>
        <h1 class="mt-2 text-3xl font-bold tracking-[-.045em]">数据工作台</h1>
        <p class="mt-2 text-sm text-[var(--muted)]">接入数据，补充结构说明，让 AI 基于真实数据创建应用。</p>
      </div>
      <div class="flex max-w-full flex-wrap items-center gap-2">
        <button type="button" class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" @click="liveDatabaseOpen = true">数据库连接</button>
        <details class="relative"><summary class="cursor-pointer rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white">接入数据</summary><div class="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-lg"><button type="button" class="block w-full rounded-lg p-2 text-left text-sm hover:bg-[var(--surface-muted)]" @click="openPicker('files')">导入 Excel / CSV</button><button type="button" class="block w-full rounded-lg p-2 text-left text-sm hover:bg-[var(--surface-muted)]" @click="openPicker('sqlite')">导入 SQLite 数据库</button><button type="button" class="block w-full rounded-lg p-2 text-left text-sm hover:bg-[var(--surface-muted)]" @click="liveDatabaseOpen = true">创建实时数据库对象</button><button type="button" class="block w-full rounded-lg p-2 text-left text-sm hover:bg-[var(--surface-muted)]" @click="openDatabase()">导入数据库本地副本</button><button type="button" class="block w-full rounded-lg p-2 text-left text-sm hover:bg-[var(--surface-muted)]" @click="openPicker('json')">导入 JSON</button><button type="button" class="block w-full rounded-lg p-2 text-left text-sm hover:bg-[var(--surface-muted)]" @click="openCreateApi">连接 API</button></div></details>
        <button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="demoOpen = true">体验示例</button>
        <button class="rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:bg-[var(--surface-muted)]" type="button" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
        <input ref="fileInput" class="hidden" type="file" :accept="acceptedFiles" @change="upload" />
      </div>
    </header>
    <div v-if="demoOpen" class="absolute inset-0 z-40 overflow-y-auto bg-[var(--background)] p-8"><button class="mb-4 rounded-lg border px-4 py-2" @click="demoOpen = false; load()">← 返回数据工作台</button><DataTaskDemo @changed="load" /></div>

    <div v-if="error || notice" :role="error ? 'alert' : 'status'" class="mx-8 mt-4 flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm" :class="error ? 'border-rose-300 bg-rose-50 text-rose-700' : 'border-emerald-300 bg-emerald-50 text-emerald-700'">
      <span class="min-w-0 break-words">{{ error || notice }}</span>
      <button type="button" aria-label="关闭提示" class="shrink-0 rounded px-1 font-semibold focus-visible:outline-2" @click="error = ''; notice = ''">×</button>
    </div>

    <div v-if="uploadStage !== 'idle'" class="mx-8 mt-4 rounded-2xl border border-[var(--accent)]/25 bg-[var(--surface)] p-4 shadow-sm" aria-live="polite">
      <div class="flex items-center justify-between gap-4">
        <p class="text-sm font-bold">{{ uploadStatus }}</p>
        <span class="text-xs font-semibold text-[var(--accent)]">{{ uploadProgress }}%</span>
      </div>
      <div class="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-muted)]">
        <div class="h-full rounded-full bg-[var(--accent)] transition-all duration-500" :style="{ width: `${uploadProgress}%` }" />
      </div>
    </div>

    <div v-if="!activeApp && !selected" class="px-8 pt-5">
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <button v-for="item in [{ id: 'all', icon: '◫', title: '全部数据对象', note: '统一数据目录' }, { id: 'files', icon: 'X', title: 'Excel / CSV', note: '工作簿与列标注' }, { id: 'sqlite', icon: '▤', title: '本地 SQLite', note: '数据库与表标注' }, { id: 'mysql', icon: '◎', title: '在线数据库', note: 'MySQL / PostgreSQL' }, { id: 'other', icon: '⌁', title: 'API / JSON', note: '接口与结构说明' }]" :key="item.id" class="rounded-2xl border bg-[var(--surface)] p-4 text-left transition hover:border-[var(--accent)]" :class="activeCategory === item.id ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/10' : 'border-[var(--border)]'" type="button" @click="activeCategory = item.id as SourceCategory">
          <div class="flex items-start justify-between gap-3"><span class="grid h-9 w-9 place-items-center rounded-xl bg-[var(--accent-soft)] text-sm font-black text-[var(--accent)]">{{ item.icon }}</span><b class="text-xl">{{ categoryCount(item.id as SourceCategory) }}</b></div>
          <p class="mt-3 text-sm font-bold">{{ item.title }}</p><p class="mt-1 text-xs text-[var(--muted)]">{{ item.note }}</p>
        </button>
      </div>
    </div>

    <DataAppOperator v-if="activeApp" :app="activeApp" @close="activeApp = null" />

    <div v-else-if="loading && !hasSources" class="grid flex-1 place-items-center p-8 text-sm text-[var(--muted)]">正在连接数据工作台…</div>
    <div v-else-if="!hasSources" class="grid flex-1 place-items-center p-8">
      <div class="max-w-xl text-center">
        <h2 class="text-2xl font-bold">建立你的数据目录</h2>
        <p class="mx-auto mt-3 text-sm leading-6 text-[var(--muted)]">导入 Excel / CSV，或添加本地 SQLite 数据库。原文件保留在资产库，业务表安全复制到独立的数据工作台。</p>
        <div class="mt-7 flex justify-center gap-2"><button class="rounded-xl bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white" type="button" @click="openPicker('files')">上传 Excel / CSV</button><button class="rounded-xl border border-[var(--border)] px-5 py-2.5 text-sm font-semibold" type="button" @click="openPicker('sqlite')">打开 SQLite</button></div>
      </div>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-hidden">

      <div v-if="selected" class="h-full min-h-0 overflow-y-auto p-7">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <button class="mb-2 text-xs font-bold text-[var(--accent)]" type="button" @click="showCatalog(activeCategory)">← 返回数据对象</button>
            <h2 class="text-2xl font-bold tracking-[-.035em]">{{ selected.name }}</h2>
            <p class="mt-1 text-sm text-[var(--muted)]"><span class="mr-2 rounded-md bg-[var(--surface-muted)] px-2 py-1 text-[10px] font-bold">{{ selected.fileType }}</span><span v-if="selected.isDefault" class="mr-2 rounded-md bg-[var(--accent-soft)] px-2 py-1 text-[10px] font-bold text-[var(--accent)]">默认</span>{{ summary }}</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button v-if="selected.databaseConnection" type="button" class="rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold" @click="openDatabase(selected)">刷新快照</button>
            <button
              v-if="selected.assetId"
              class="rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:bg-[var(--surface-muted)]"
              type="button"
              @click="openAsset"
            >
              原文件
            </button>
            <button
              v-if="isApiSource(selected)"
              class="rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:bg-[var(--surface-muted)] disabled:opacity-50"
              type="button"
              :disabled="apiSyncBusy"
              @click="syncSelectedApi"
            >
              {{ apiSyncBusy ? '同步中…' : '同步 API' }}
            </button>
            <button
              v-if="isSpreadsheetSource(selected)"
              class="rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:bg-[var(--surface-muted)]"
              type="button"
              @click="openRenameSource(selected)"
            >
              编辑名称
            </button>
            <button
              v-if="isApiSource(selected)"
              class="rounded-xl border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:bg-[var(--surface-muted)]"
              type="button"
              @click="openEditApi(selected)"
            >
              编辑连接
            </button>
            <button
              v-if="canDeleteSource(selected)"
              class="rounded-xl border border-rose-200 px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              type="button"
              :disabled="deletingSourceId === selected.id"
              @click="removeSource(selected)"
            >
              {{ deletingSourceId === selected.id ? '删除中…' : '删除' }}
            </button>
            <button
              class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              type="button"
              :disabled="!selectedTable"
              @click="openCreateWebsite"
            >
              创建应用
            </button>
          </div>
        </div>

        <nav class="mt-6 flex gap-1 overflow-x-auto border-b border-[var(--border)]" aria-label="数据对象详情"><button v-for="tab in [{ id: 'overview', name: '对象说明' }, { id: 'schema', name: '字段说明' }, { id: 'preview', name: selected.accessMode === 'live' ? '数据测试' : '数据预览' }, { id: 'analysis', name: '查询分析' }, { id: 'apps', name: '应用' }]" :key="tab.id" type="button" :aria-current="objectTab === tab.id ? 'page' : undefined" class="shrink-0 border-b-2 px-4 py-3 text-sm font-semibold" :class="objectTab === tab.id ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--muted)]'" @click="objectTab = tab.id as typeof objectTab">{{ tab.name }}<span v-if="tab.id === 'apps'" class="ml-1.5 text-xs opacity-70">{{ sourceApps.length }}</span></button></nav>

        <div v-if="objectTab === 'overview'" class="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--accent-soft)] px-4 py-3">
          <div class="min-w-0"><p class="text-sm font-semibold">建议下一步：{{ nextStep.label }}</p><p class="mt-1 text-xs leading-5 text-[var(--muted)]">{{ nextStep.note }}</p></div>
          <button type="button" class="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold text-[var(--accent)]" :disabled="nextStep.action === 'create' && !selectedTable" @click="followNextStep">{{ nextStep.label }}</button>
        </div>
        <div v-if="objectTab === 'overview' && selected.liveConnection" class="mt-5 rounded-xl border border-[var(--border)] p-4 text-sm"><b>实时数据库 · {{ selected.liveConnection.writeEnabled ? '已开启原库写入' : '默认只读' }}</b><p class="mt-2 text-xs text-[var(--muted)]">数据库：{{ selected.liveConnection.database }}。业务数据不复制到本机；请在“数据测试”查询，按对象单独开启写入。</p></div>

        <section v-if="objectTab === 'overview'" class="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div v-if="selected.databaseConnection" class="mb-5 rounded-xl bg-[var(--surface-muted)] p-4 text-sm">
            <div class="flex flex-wrap items-center justify-between gap-2"><b>{{ selected.fileType }} · 本地副本</b><span class="text-xs text-[var(--muted)]">最近刷新 {{ new Date(selected.databaseConnection.lastSyncedAt).toLocaleString() }}</span></div>
            <p class="mt-2 break-all text-[var(--muted)]">{{ selected.databaseConnection.host }}:{{ selected.databaseConnection.port }} / {{ selected.databaseConnection.database }}</p>
            <p class="mt-2 text-xs text-[var(--muted)]">应用使用本地副本，不回写原数据库。密码未保存，刷新时再次输入。</p>
            <p v-if="selected.databaseConnection.truncatedTables.length" class="mt-2 break-words text-xs text-amber-700">以下表仅导入前 20,000 行：{{ selected.databaseConnection.truncatedTables.join('、') }}</p>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-3"><h3 class="font-bold">让 AI 理解这份数据</h3><button type="button" class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold" @click="annotationsOpen = true">编辑说明</button></div>
          <dl class="mt-4 space-y-4 text-sm"><div><dt class="font-semibold">业务说明</dt><dd class="mt-1 whitespace-pre-wrap break-words text-[var(--muted)]">{{ currentAnnotations.description || '尚未填写。说明包含什么数据、业务范围和统计口径。' }}</dd></div><div><dt class="font-semibold">数据来源与连接说明</dt><dd class="mt-1 whitespace-pre-wrap break-words text-[var(--muted)]">{{ currentAnnotations.connectionDescription || '尚未填写。可补充来源、更新频率与使用限制。' }}</dd></div></dl>
          <p class="mt-5 text-xs text-[var(--muted)]">已说明 {{ annotationCount }} / {{ fieldCount }} 个字段。保存后，AI 将使用最新说明；原始数据不会改变。</p>
          <div class="mt-4 flex flex-wrap gap-3"><button type="button" class="text-xs font-semibold text-[var(--accent)]" @click="objectTab = 'schema'">继续标注结构</button><button type="button" :disabled="schemaReading" class="text-xs font-semibold text-[var(--accent)]" @click="modelSchema ? modelSchema = '' : showModelSchema()">{{ schemaReading ? '读取中…' : modelSchema ? '收起模型可读 Schema' : '查看模型可读 Schema' }}</button></div>
          <pre v-if="modelSchema" class="mt-4 max-h-80 overflow-auto rounded-lg bg-[var(--surface-muted)] p-3 text-xs">{{ modelSchema }}</pre>
        </section>

        <section v-if="objectTab === 'overview' && isApiSource(selected) && selected.api" class="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 class="font-bold">API 连接</h3>
              <p class="mt-1 text-xs text-[var(--muted)]">{{ selected.api.method }} · {{ selected.api.baseUrl }}{{ selected.api.path.startsWith('/') ? '' : '/' }}{{ selected.api.path }}</p>
            </div>
            <span
              class="rounded-full px-2 py-1 text-[10px] font-bold"
              :class="selected.api.lastStatus === 'ok' ? 'bg-emerald-100 text-emerald-700' : selected.api.lastStatus === 'error' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-600'"
            >
              {{ selected.api.lastStatus === 'ok' ? '同步成功' : selected.api.lastStatus === 'error' ? '同步失败' : '未同步' }}
            </span>
          </div>
          <p v-if="selected.api.description" class="mt-3 text-sm leading-6 text-[var(--muted)]">{{ selected.api.description }}</p>
          <p v-if="selected.api.itemsPath" class="mt-2 text-xs text-[var(--muted)]">itemsPath：{{ selected.api.itemsPath }}</p>
          <p v-if="selected.api.lastError" class="mt-2 text-xs text-rose-700">{{ selected.api.lastError }}</p>
          <p v-if="selected.api.lastSyncedAt" class="mt-2 text-xs text-[var(--muted)]">上次同步：{{ new Date(selected.api.lastSyncedAt).toLocaleString() }}</p>
          <div v-if="selected.api.requestBody || selected.api.responseBody" class="mt-4 grid gap-3 lg:grid-cols-2">
            <div v-if="selected.api.requestBody">
              <p class="text-[10px] font-bold tracking-wide text-[var(--muted)]">请求体</p>
              <pre class="mt-1 max-h-40 overflow-auto rounded-xl bg-[var(--surface-muted)] p-3 text-[11px] leading-4">{{ selected.api.requestBody }}</pre>
            </div>
            <div v-if="selected.api.responseBody">
              <p class="text-[10px] font-bold tracking-wide text-[var(--muted)]">返回体</p>
              <pre class="mt-1 max-h-40 overflow-auto rounded-xl bg-[var(--surface-muted)] p-3 text-[11px] leading-4">{{ selected.api.responseBody }}</pre>
            </div>
          </div>
        </section>

        <section v-if="objectTab === 'schema' && isApiSource(selected)" class="mt-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div class="flex items-center justify-between gap-3"><h3 class="font-bold">API 接口结构标注</h3><button type="button" class="text-xs font-semibold text-[var(--accent)]" @click="annotationsOpen = true">编辑接口标注</button></div>
          <p class="mt-2 whitespace-pre-wrap break-words text-sm text-[var(--muted)]">{{ currentAnnotations.apiUrlDescription || '可补充 URL 用途与路径含义，并标注入参和返参。' }}</p>
          <div v-for="field in currentAnnotations.apiFields" :key="`${field.location}:${field.path}`" class="mt-3 border-t border-[var(--border)] pt-3 text-xs"><p class="break-all font-semibold">{{ field.location }} / {{ field.path }} <span class="font-normal text-[var(--muted)]">{{ field.type }} {{ field.required ? '必填' : '可选' }}</span></p><p class="mt-1 whitespace-pre-wrap break-words text-[var(--muted)]">{{ field.description || '未填写说明' }}</p></div>
        </section>

        <section v-if="objectTab === 'apps'" class="mt-6">
          <div class="mb-3 flex items-end justify-between gap-3">
            <div>
              <h3 class="text-lg font-bold">数据应用</h3>
              <p class="mt-1 text-xs text-[var(--muted)]">本机部署，局域网可扫码打开。</p>
            </div>
            <div class="flex shrink-0 items-center gap-3"><span class="text-xs text-[var(--muted)]">{{ sourceApps.length }} 个</span><label class="text-xs text-[var(--muted)]">排序 <select v-model="appSort" class="ml-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-xs"><option value="updated">最近修改优先</option><option value="created">最新创建优先</option><option value="name">按名称排序</option></select></label></div>
          </div>

          <p class="rounded-xl bg-[var(--surface-muted)] p-4 text-xs leading-5 text-[var(--muted)]">应用通过网关执行已登记的 SQL 或查询，默认只读。项目预览可直接用当前账号验证；发布页须登录。写操作需要你审核启用；授权后新增和保存直接执行，删除也直接执行，且对象已开启写入，链接不授予数据权限。</p>
          <details class="mb-3 rounded-xl border border-[var(--border)] p-3 text-xs text-[var(--muted)]"><summary class="cursor-pointer font-semibold">如何创建支持修改的应用？</summary><p class="mt-2 leading-6">1. 使用实时数据库对象，在“数据测试”中明确开启写入（需要所有者管理员权限；本地副本不能回写原库）。<br>2. 点击“创建应用”或“继续优化”，要求 AI 提供新增、修改、删除界面，并登记参数化 SQL 写操作。<br>3. 在项目“预览与发布”中审核并启用写操作，再测试页面；授权后新增和保存直接执行，删除也直接执行。首期支持单行新增，更新、删除需按完整主键定位。</p></details>
          <p v-if="sourceApps.length" class="mb-3 text-xs text-[var(--muted)]">修改时间以已绑定页面为准；未交付应用按创建时间排序。项目中的未交付草稿不改变已交付版本。</p>
          <div v-if="!sourceApps.length" class="rounded-2xl border border-dashed border-[var(--border)] px-5 py-10 text-center">
            <p class="font-semibold">基于这份数据创建第一个应用</p>
            <p class="mt-2 text-sm text-[var(--muted)]">告诉 AI 你想解决什么问题，在专属项目中制作并持续优化。</p>
            <button type="button" :disabled="!selectedTable" class="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" @click="openCreateWebsite">创建应用</button>
          </div>

          <div v-else class="grid gap-4 lg:grid-cols-2">
            <article v-for="app in sortedApps" :key="app.id" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="flex min-w-0 items-center gap-2 text-sm font-bold"><span class="truncate">{{ app.name }}</span><span v-if="app.id === latestAppId" class="shrink-0 rounded bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]">{{ app.customSite?.updatedAt ? '最近更新' : '最近创建' }}</span></p>
                  <p class="mt-1 text-xs text-[var(--muted)]">{{ app.appType }}</p>
                </div>
                <span
                  class="shrink-0 rounded-full px-2 py-1 text-[10px] font-bold"
                  :class="appPresentation(app).pending ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-700'"
                >
                  {{ appPresentation(app).label }}
                </span>
              </div>

              <p class="mt-3 text-xs leading-5 text-[var(--muted)]">创建：{{ formatAppTime(app.createdAt) }}<br>页面修改：{{ app.customSite?.updatedAt ? formatAppTime(app.customSite.updatedAt) : '尚无页面修改记录' }}</p>

              <p v-if="app.delivery?.status === 'awaiting-binding'" class="mt-3 text-xs leading-5 text-[var(--muted)]">页面尚未交付。请查看项目进度，或继续创建；只有成功绑定页面后才可用。</p>
              <p v-if="app.queryMode === 'managed-readonly'" class="mt-2 text-xs text-[var(--muted)]">受控数据操作 · 已验证 {{ app.queryState?.verifiedCount || 0 }} 个查询 · 所有者登录后可用</p>

              <details v-if="appPresentation(app).canShare && (app.publishUrl || app.lanUrl)" class="mt-4 rounded-xl bg-[var(--surface-muted)] p-3"><summary class="cursor-pointer text-xs font-semibold text-[var(--muted)]">手机访问与分享</summary><div class="mt-3 flex items-start gap-3">
                <img v-if="qrByApp[app.id]" :src="qrByApp[app.id]" alt="站点二维码" class="h-20 w-20 rounded-lg bg-white p-1" />
                <div class="min-w-0 flex-1">
                  <p class="text-[10px] font-bold tracking-wide text-[var(--muted)]">局域网扫码</p>
                  <p class="mt-1 break-all text-[11px] leading-4 text-[var(--muted)]">{{ app.lanUrl || app.publishUrl }}</p>
                  <p v-if="!app.lanUrl" class="mt-1 text-[10px] text-amber-700">未检测到局域网 IP，可先用本机链接。</p>
                </div>
              </div></details>

              <div class="mt-4 flex flex-wrap gap-2">
                <button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white" type="button" @click="appPresentation(app).pending ? openAppIteration(app) : openPublishedApp(app)">{{ appPresentation(app).primary }}</button>
                <button v-if="app.projectId" class="rounded-lg px-3 py-2 text-xs font-semibold text-[var(--accent)]" type="button" @click="openAppProject(app.projectId)">编辑应用</button>
                <details class="relative"><summary class="cursor-pointer rounded-lg px-3 py-2 text-xs font-semibold text-[var(--muted)]">更多</summary><div class="absolute right-0 z-10 mt-1 w-44 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg">
                <button v-if="appPresentation(app).pending" class="block w-full rounded px-3 py-2 text-left text-xs hover:bg-[var(--surface-muted)]" type="button" @click="openPublishedApp(app)">查看交付状态</button>
                <button v-if="app.queryMode !== 'managed-readonly'" class="block w-full rounded px-3 py-2 text-left text-xs hover:bg-[var(--surface-muted)]" type="button" @click="openExistingApp(app)">查看与管理数据</button>
                <button
                  class="block w-full rounded px-3 py-2 text-left text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                  type="button"
                  :disabled="deletingId === app.id"
                  @click="removeApp(app)"
                >
                  {{ deletingId === app.id ? '删除中…' : '删除' }}
                </button></div></details>
              </div>
            </article>
          </div>
        </section>

        <section v-if="(objectTab === 'schema' || objectTab === 'preview' || objectTab === 'analysis') && selected.tables?.length" class="mt-5">
          <template v-if="objectTab !== 'analysis'">
          <div class="flex flex-wrap items-center justify-between gap-3"><div><h3 class="font-bold">{{ objectTab === 'preview' ? selected.accessMode === 'live' ? '实时数据测试' : '数据预览' : '表与字段说明' }}</h3><p class="mt-1 text-xs text-[var(--muted)]">{{ objectTab === 'preview' ? selected.accessMode === 'live' ? '通过 Gateway 查询原库数据；写入需单独授权并确认。' : '查看前 20 行，确认结构与数据内容。' : '补充字段含义、单位和统计口径，帮助 AI 正确使用数据。' }}</p></div><button v-if="selectedTable" class="rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="editSchema">编辑字段说明</button></div>
          </template>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              v-for="table in selected.tables"
              :key="table.id"
              class="rounded-xl border px-3 py-2 text-sm font-semibold"
              :class="selectedTable?.id === table.id ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border)] hover:bg-[var(--surface-muted)]'"
              type="button"
              @click="chooseTable(table)"
            >
              {{ table.name }} <span v-if="selected.accessMode !== 'live'" class="ml-1 text-xs opacity-70">{{ table.rowCount }}</span>
            </button>
          </div>
          <p v-if="selectedTable?.description" class="mt-3 whitespace-pre-wrap text-sm text-[var(--muted)]">{{ selectedTable.description }}</p>
          <StructuredDataQuery v-if="objectTab === 'analysis' && selectedTable" :key="`${selected.id}:${selectedTable.id}`" :source="selected" :table="selectedTable" />
          <div v-if="selectedTable && objectTab === 'schema'" class="mt-4 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            <div class="grid grid-cols-[100px_minmax(160px,1fr)_120px_80px_minmax(120px,1fr)] gap-3 border-b border-[var(--border)] bg-[var(--surface-muted)] px-4 py-2 text-[10px] font-bold tracking-wide text-[var(--muted)]"><span>字段 ID</span><span>字段名称</span><span>类型</span><span>可空</span><span>样例</span></div>
            <div v-for="column in selectedTable.columns" :key="column.id" class="min-w-[600px] border-b border-[var(--border)] px-4 py-3 text-xs last:border-0"><div class="grid grid-cols-[100px_minmax(160px,1fr)_120px_80px_minmax(120px,1fr)] gap-3"><code class="text-[var(--accent)]">{{ column.id }}</code><b>{{ column.name }}</b><span>{{ column.type }}</span><span>{{ column.nullable ? '是' : '否' }}</span><span class="truncate text-[var(--muted)]">{{ column.sensitive ? '敏感字段，样例隐藏' : column.sample }}</span></div><p class="mt-2 whitespace-pre-wrap break-words text-[var(--muted)]">{{ column.description || '尚未填写字段说明' }}{{ column.unit ? `；单位：${column.unit}` : '' }}{{ column.enumDescription ? `；枚举：${column.enumDescription}` : '' }}</p></div>
          </div>
          <LiveDataTester v-if="objectTab === 'preview' && selectedTable && selected.accessMode === 'live'" :key="selectedTable.id" :source="selected" :table="selectedTable" @updated="liveAccessUpdated" />
          <div v-else-if="objectTab === 'preview' && selectedTable && preview.columns.length" class="mt-4 overflow-hidden rounded-xl border border-[var(--border)]">
            <div class="border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--muted)]">{{ selectedTable.name }} · 前 20 行</div>
            <div class="overflow-auto">
              <table class="min-w-full text-left text-xs">
                <thead class="bg-[var(--surface-muted)] text-[var(--muted)]">
                  <tr><th v-for="column in preview.columns" :key="column" class="whitespace-nowrap px-3 py-2 font-semibold">{{ column }}</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(row, index) in preview.rows" :key="index" class="border-t border-[var(--border)]">
                    <td v-for="(value, cell) in row" :key="cell" class="max-w-[200px] truncate px-3 py-2">{{ value }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-if="!preview.rows.length" class="p-4 text-sm text-[var(--muted)]">当前表尚无记录，可以先完善结构标注，再同步或录入数据。</p>
            </div>
          </div>
        </section>
      </div>
      <main v-else class="h-full min-h-0 overflow-y-auto px-8 py-7">
        <div class="flex flex-wrap items-end justify-between gap-4">
          <div><h2 class="text-2xl font-bold">{{ activeCategory === 'all' ? '全部数据对象' : activeCategory === 'files' ? 'Excel / CSV' : activeCategory === 'sqlite' ? '本地 SQLite' : activeCategory === 'mysql' ? '在线数据库' : 'API / JSON' }}</h2><p class="mt-2 text-sm text-[var(--muted)]">选择数据对象，完善结构说明，再基于数据创建应用。</p></div>
          <div class="flex flex-wrap gap-2">
            <template v-if="activeCategory === 'files'"><button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" :disabled="mobileUploadBusy" @click="openMobileUpload">{{ mobileUploadBusy ? '生成中…' : '手机上传' }}</button><button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white" type="button" @click="openPicker('files')">上传 Excel / CSV</button></template>
            <template v-else-if="activeCategory === 'sqlite'"><button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" @click="openPicker('sqlite')">打开数据库</button><button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white" type="button" @click="createSqliteOpen = true">新建数据库</button></template>
            <template v-else-if="activeCategory === 'other'"><button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" @click="openPicker('json')">导入 JSON</button><button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white" type="button" @click="openCreateApi">连接 API</button></template>
            <button v-else-if="activeCategory === 'mysql'" type="button" class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white" @click="openDatabase()">连接数据库</button>
          </div>
        </div>
        <div class="mt-5 flex flex-wrap items-center gap-3">
          <label class="min-w-0 flex-1"><span class="sr-only">搜索数据对象</span><input v-model="sourceQuery" type="search" placeholder="搜索名称、类型或业务说明" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm outline-none focus:border-[var(--accent)]" /></label>
          <button v-if="sourceQuery" type="button" class="text-xs font-semibold text-[var(--accent)]" @click="sourceQuery = ''">清除搜索</button>
          <span role="status" class="text-xs text-[var(--muted)]">{{ filteredSources.length }} 个对象</span>
        </div>
        <div v-if="filteredSources.length" class="mt-5 grid gap-3 xl:grid-cols-2">
          <article
            v-for="source in filteredSources"
            :key="source.id"
            class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-left transition hover:border-[var(--accent)] hover:shadow-md"
          >
            <button class="w-full text-left" type="button" @click="chooseSource(source.id)">
              <div class="flex items-start justify-between gap-3">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="rounded-lg bg-[var(--accent-soft)] px-2 py-1 text-[10px] font-bold text-[var(--accent)]">{{ source.fileType }}</span>
                  <span v-if="source.accessMode === 'live' || source.accessMode === 'snapshot'" class="rounded-lg bg-[var(--surface-muted)] px-2 py-1 text-[10px] font-bold text-[var(--muted)]">{{ source.accessMode === 'live' ? '实时连接' : '本地副本' }}</span>
                  <span v-if="source.isDefault" class="rounded-lg bg-[var(--surface-muted)] px-2 py-1 text-[10px] font-bold text-[var(--muted)]">默认</span>
                </div>
                <span class="text-xs text-[var(--muted)]">{{ new Date(source.createdAt).toLocaleDateString() }}</span>
              </div>
              <b class="mt-4 block truncate">{{ source.name }}</b>
              <p class="mt-2 text-xs text-[var(--muted)]">{{ source.tableCount }} 张表 · {{ source.accessMode === 'live' ? '按需查询原库' : source.rowCount.toLocaleString() + ' 条记录' }}</p>
              <p class="mt-3 line-clamp-2 text-xs leading-5 text-[var(--muted)]">{{ source.annotations?.description || source.summary }}</p>
            </button>
            <div v-if="canEditSource(source) || canDeleteSource(source)" class="mt-4 flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
              <button
                v-if="canEditSource(source)"
                class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-muted)]"
                type="button"
                @click="openEditSource(source, $event)"
              >
                编辑
              </button>
              <button
                v-if="canDeleteSource(source)"
                class="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                type="button"
                :disabled="deletingSourceId === source.id"
                @click="removeSource(source, $event)"
              >
                {{ deletingSourceId === source.id ? '删除中…' : '删除' }}
              </button>
            </div>
          </article>
        </div>
        <div v-else class="mt-6 rounded-2xl border border-dashed border-[var(--border)] px-6 py-12 text-center"><p class="font-semibold">{{ sourceQuery.trim() ? '没有找到匹配的数据对象' : '此分类还没有数据对象' }}</p><p class="mt-2 text-sm text-[var(--muted)]">{{ sourceQuery.trim() ? '试试其他关键词，或清除搜索查看此分类的全部对象。' : activeCategory === 'mysql' ? '点击「连接数据库」，测试连接后选择要导入的库与表。' : activeCategory === 'other' ? '连接 API 或导入 JSON，补充接口与结构说明。' : '点击右上方按钮添加第一份数据。' }}</p><button v-if="sourceQuery.trim()" type="button" class="mt-4 text-sm font-semibold text-[var(--accent)]" @click="sourceQuery = ''">清除搜索</button></div>
      </main>
    </div>

    <DatabaseConnectionDialog v-if="databaseDialogOpen" :source="databaseRefreshSource" @close="databaseDialogOpen = false; databaseRefreshSource = null" @saved="databaseSaved" />
    <LiveDatabaseDialog v-if="liveDatabaseOpen" :initial-connection-id="repairConnectionId" :credential-only="Boolean(repairConnectionId)" @close="liveDatabaseOpen = false; repairConnectionId = ''" @saved="liveDatabaseSaved" @credential-saved="connectionCredentialSaved" />
    <DataObjectAnnotationsEditor v-if="annotationsOpen && selected" :annotations="currentAnnotations" :api="isApiSource(selected)" :busy="annotationsSaving" :save-error="error" @close="annotationsOpen = false" @save="saveAnnotations" />
    <div v-if="mobileUploadOpen" class="absolute inset-0 z-30 grid place-items-center bg-slate-950/35 p-5 backdrop-blur-[2px]"><section class="w-full max-w-lg rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center shadow-2xl"><button class="float-right text-lg text-[var(--muted)]" type="button" @click="mobileUploadOpen = false">×</button><p class="text-xs font-bold tracking-[.12em] text-[var(--accent)]">MOBILE UPLOAD</p><h2 class="mt-2 text-2xl font-bold">用手机上传 Excel / CSV</h2><p class="mt-2 text-sm leading-6 text-[var(--muted)]">手机和电脑连接同一局域网，扫码后选择文件。链接 30 分钟内有效。</p><img v-if="mobileUploadQr" :src="mobileUploadQr" alt="手机上传二维码" class="mx-auto mt-5 h-56 w-56 rounded-2xl border border-[var(--border)] bg-white p-3"><p class="mt-4 break-all rounded-xl bg-[var(--surface-muted)] p-3 text-left text-xs text-[var(--muted)]">{{ mobileUploadUrl }}</p><p class="mt-3 text-xs text-[var(--muted)]">有效期至 {{ new Date(mobileUploadExpiresAt).toLocaleTimeString() }}</p><div class="mt-5 flex justify-center gap-2"><button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" @click="navigator.clipboard?.writeText(mobileUploadUrl)">复制链接</button><button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white" type="button" @click="mobileUploadOpen = false; load()">完成并刷新</button></div></section></div>

    <div v-if="optimizeApp" class="absolute inset-0 z-30 grid place-items-center bg-slate-950/35 p-5 backdrop-blur-[2px]">
      <section class="w-full max-w-xl rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
        <button class="float-right text-lg text-[var(--muted)]" type="button" :disabled="optimizeBusy" @click="optimizeApp = null">×</button>
        <p class="text-xs font-bold tracking-[.12em] text-teal-700">CONVERSATIONAL ITERATION</p>
        <h2 class="mt-2 text-2xl font-bold">{{ optimizeApp.delivery?.status === 'awaiting-binding' ? '继续创建' : '继续优化' }}「{{ optimizeApp.name }}」</h2>
        <p class="mt-2 text-sm leading-6 text-[var(--muted)]">{{ optimizeApp.delivery?.status === 'awaiting-binding' ? 'Agent 会使用最新数据说明完成页面并绑定到原应用，不会创建重复站点。' : 'Agent 会读取当前页面，在原应用上修改并生成新版本；绑定成功前保留已有页面。' }}</p>
        <textarea v-model="optimizeIdea" rows="5" class="mt-5 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-teal-600" placeholder="例如：增加按项目阶段筛选；金额用柱状图展示；移动端卡片更紧凑。" />
        <div class="mt-6 flex justify-end gap-2">
          <button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" :disabled="optimizeBusy" @click="optimizeApp = null">取消</button>
          <button class="rounded-xl bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" :disabled="optimizeBusy || !optimizeIdea.trim()" @click="submitOptimize">{{ optimizeBusy ? '准备中…' : '开始项目执行' }}</button>
        </div>
      </section>
    </div>

    <div v-if="createSqliteOpen" class="absolute inset-0 z-30 grid place-items-center bg-slate-950/35 p-5 backdrop-blur-[2px]">
      <section class="w-full max-w-md rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl"><button class="float-right text-lg text-[var(--muted)]" type="button" @click="createSqliteOpen = false">×</button><p class="text-xs font-bold tracking-[.12em] text-[var(--accent)]">NEW SQLITE</p><h2 class="mt-2 text-2xl font-bold">新建本地数据库</h2><p class="mt-2 text-sm leading-6 text-[var(--muted)]">创建独立数据库副本和默认 data 表，随后可以编辑 Schema 并通过网站应用录入数据。</p><label class="mt-5 block"><span class="mb-1.5 block text-xs font-semibold">数据库名称</span><input v-model="sqliteName" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" @keyup.enter="createSqlite" /></label><div class="mt-6 flex justify-end gap-2"><button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" @click="createSqliteOpen = false">取消</button><button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" :disabled="importing || !sqliteName.trim()" @click="createSqlite">{{ importing ? '创建中…' : '创建数据库' }}</button></div></section>
    </div>

    <div v-if="apiEditorOpen" class="absolute inset-0 z-30 grid place-items-center bg-slate-950/35 p-5 backdrop-blur-[2px]">
      <section class="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
        <button class="float-right text-lg text-[var(--muted)]" type="button" @click="apiEditorOpen = false">×</button>
        <p class="text-xs font-bold tracking-[.12em] text-[var(--accent)]">API SOURCE</p>
        <h2 class="mt-2 text-2xl font-bold">{{ apiEditingId ? '编辑 API 数据源' : '新建 API 数据源' }}</h2>
        <p class="mt-2 text-sm leading-6 text-[var(--muted)]">接入返回 JSON 的 REST 接口，同步后可在工作台预览并创建网站应用。</p>
        <div class="mt-5 space-y-3">
          <label class="block"><span class="mb-1.5 block text-xs font-semibold">名称</span><input v-model="apiForm.name" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" /></label>
          <label class="block"><span class="mb-1.5 block text-xs font-semibold">自然语言描述</span><textarea v-model="apiForm.description" rows="3" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" placeholder="例如：拉取订单列表，按创建时间倒序返回；用于生成订单看板。" /><span class="mt-1 block text-[11px] text-[var(--muted)]">用自然语言说明这个 API 做什么、适合哪些业务场景。</span></label>
          <label class="block"><span class="mb-1.5 block text-xs font-semibold">Base URL</span><input v-model="apiForm.baseUrl" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" placeholder="https://api.example.com" /></label>
          <div class="grid gap-3 sm:grid-cols-[110px_1fr]">
            <label class="block"><span class="mb-1.5 block text-xs font-semibold">方法</span><select v-model="apiForm.method" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm"><option value="GET">GET</option><option value="POST">POST</option></select></label>
            <label class="block"><span class="mb-1.5 block text-xs font-semibold">Path</span><input v-model="apiForm.path" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" placeholder="/v1/items" /></label>
          </div>
          <label class="block"><span class="mb-1.5 block text-xs font-semibold">itemsPath（可选）</span><input v-model="apiForm.itemsPath" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" placeholder="data.items" /><span class="mt-1 block text-[11px] text-[var(--muted)]">响应是数组可留空；对象内数组用点路径，如 data.list</span></label>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block"><span class="mb-1.5 block text-xs font-semibold">鉴权</span><select v-model="apiForm.authType" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm"><option value="none">无</option><option value="bearer">Bearer Token</option><option value="header">自定义 Header</option></select></label>
            <label class="block"><span class="mb-1.5 block text-xs font-semibold">Header 名</span><input v-model="apiForm.authHeaderName" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" :disabled="apiForm.authType === 'none'" /></label>
          </div>
          <label v-if="apiForm.authType !== 'none'" class="block"><span class="mb-1.5 block text-xs font-semibold">Token / Key{{ apiEditingId ? '（留空表示不修改）' : '' }}</span><input v-model="apiForm.authToken" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]" type="password" autocomplete="off" /></label>
          <label class="block"><span class="mb-1.5 block text-xs font-semibold">请求体 JSON{{ apiForm.method === 'GET' ? '（文档用，GET 同步不发送）' : '' }}</span><textarea v-model="apiForm.requestBody" rows="6" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-mono text-xs outline-none focus:border-[var(--accent)]" placeholder='{"page":1,"size":20}' /><span class="mt-1 block text-[11px] text-[var(--muted)]">POST 同步时会按此请求体发送；也可用作 Agent 理解入参的样例。</span></label>
          <label class="block"><span class="mb-1.5 block text-xs font-semibold">返回体 JSON（样例 / 结构）</span><textarea v-model="apiForm.responseBody" rows="6" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 font-mono text-xs outline-none focus:border-[var(--accent)]" placeholder='{"data":{"items":[{"id":1,"name":"示例"}]}}' /><span class="mt-1 block text-[11px] text-[var(--muted)]">可手填期望返回结构；若为空，首次同步成功后会自动保存一份样例。</span></label>
          <label class="flex items-center gap-2 text-sm"><input v-model="apiForm.syncNow" type="checkbox" /><span>保存后立即同步</span></label>
        </div>
        <div class="mt-6 flex justify-end gap-2">
          <button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" @click="apiEditorOpen = false">取消</button>
          <button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" :disabled="apiEditorBusy || !apiForm.name.trim() || !apiForm.baseUrl.trim()" @click="saveApiSource">{{ apiEditorBusy ? '保存中…' : (apiEditingId ? '保存' : '创建') }}</button>
        </div>
      </section>
    </div>

    <div v-if="renameOpen && renameTarget" class="absolute inset-0 z-30 grid place-items-center bg-slate-950/35 p-5 backdrop-blur-[2px]">
      <section class="w-full max-w-md rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
        <button class="float-right text-lg text-[var(--muted)]" type="button" @click="renameOpen = false">×</button>
        <p class="text-xs font-bold tracking-[.12em] text-[var(--accent)]">EDIT SOURCE</p>
        <h2 class="mt-2 text-2xl font-bold">编辑数据源名称</h2>
        <p class="mt-2 text-sm leading-6 text-[var(--muted)]">仅修改数据工作台中的显示名称，不会改动资产库原文件。</p>
        <label class="mt-5 block">
          <span class="mb-1.5 block text-xs font-semibold">名称</span>
          <input
            v-model="renameDraft"
            class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]"
            @keyup.enter="saveRenameSource"
          />
        </label>
        <p class="mt-2 text-xs text-[var(--muted)]">保存后会保留 .{{ renameTarget.fileType === 'CSV' ? 'csv' : 'xlsx' }} 后缀。</p>
        <div class="mt-6 flex justify-end gap-2">
          <button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold" type="button" @click="renameOpen = false">取消</button>
          <button
            class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            type="button"
            :disabled="renameBusy || !renameDraft.trim()"
            @click="saveRenameSource"
          >
            {{ renameBusy ? '保存中…' : '保存' }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="schemaEditing && schemaDraft" class="absolute inset-0 z-30 grid place-items-center bg-slate-950/35 p-5 backdrop-blur-[2px]">
      <section class="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="schema-editor-title">
        <button class="float-right text-lg text-[var(--muted)]" type="button" :disabled="schemaSaving" aria-label="关闭结构编辑" @click="schemaEditing = false">×</button><h2 id="schema-editor-title" class="text-xl font-bold">编辑结构标注</h2>
        <p class="mt-2 text-sm text-[var(--muted)]">保存最新 Schema；仅调整工作台元数据，不修改原文件和字段 ID。</p>
        <label class="mt-5 block"><span class="mb-2 block text-xs font-semibold">数据表 / 工作表名称</span><input v-model="schemaDraft.name" maxlength="100" class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm" /></label>
        <label class="mt-4 block"><span class="mb-2 block text-xs font-semibold">表说明</span><textarea v-model="schemaDraft.description" rows="2" maxlength="4000" placeholder="这张表记录什么、统计范围与关联关系。" class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm" /></label>
        <div class="mt-5 space-y-3"><div v-for="column in schemaDraft.columns" :key="column.id" class="rounded-lg border border-[var(--border)] p-3">
          <div class="grid items-center gap-2 sm:grid-cols-[65px_minmax(0,1fr)_100px_65px]"><code class="text-xs text-[var(--accent)]">{{ column.id }}</code><input v-model="column.name" :aria-label="`${column.id}显示名称`" maxlength="100" class="min-w-0 rounded border border-[var(--border)] bg-[var(--surface-muted)] p-2 text-sm" /><select v-model="column.type" :aria-label="`${column.name}类型`" class="rounded border border-[var(--border)] bg-[var(--surface-muted)] p-2 text-sm"><option v-for="type in ['文本', '整数', '小数', '日期', '布尔值']" :key="type">{{ type }}</option></select><label class="flex items-center gap-1 text-xs"><input v-model="column.nullable" type="checkbox" />可空</label></div>
          <textarea v-model="column.description" :aria-label="`${column.name}业务说明`" rows="2" maxlength="1000" placeholder="业务说明：字段含义、统计口径或关联关系" class="mt-3 w-full rounded border border-[var(--border)] bg-[var(--surface-muted)] p-2 text-sm" />
          <details class="mt-2 text-xs text-[var(--muted)]"><summary class="cursor-pointer">更多标注</summary><div class="mt-3 grid gap-3 sm:grid-cols-2"><label>单位<input v-model="column.unit" maxlength="100" placeholder="元、件、秒" class="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-muted)] p-2" /></label><label>枚举说明<input v-model="column.enumDescription" maxlength="1000" placeholder="0=待支付，1=已支付" class="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface-muted)] p-2" /></label><label class="flex items-center gap-2"><input v-model="column.sensitive" type="checkbox" />敏感字段（AI 样例隐藏，不替代访问权限）</label></div></details>
        </div></div>
        <p v-if="error" role="alert" class="mt-4 text-sm text-rose-600">{{ error }}</p>
        <div class="mt-6 flex justify-end gap-2"><button class="rounded-lg border border-[var(--border)] px-4 py-2 text-sm" type="button" :disabled="schemaSaving" @click="schemaEditing = false">取消</button><button class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" :disabled="schemaSaving" @click="saveSchema">{{ schemaSaving ? '保存中…' : '保存 Schema' }}</button></div>
      </section>
    </div>

    <DataAppCreateDialog v-if="createOpen && selected && selectedTable" :source="selected" :table-id="selectedTable.id" :busy="createBusy" :error="createError" :notice="createNotice" :credential-required="createCredentialRequired" :suspended="liveDatabaseOpen" @repair-connection="repairCreateConnection" @close="createOpen = false" @submit="submitCreate" />
  </section>
</template>
