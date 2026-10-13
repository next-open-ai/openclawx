<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue';
import type { ProjectApplicationStatus, ProjectApplicationView, DataAppOperationSummary, DataAppAccess, DataSchemaPlan } from '@workmate/contracts';
import * as orch from '../../services/orchestration.js';
import { liveDataRequest } from '../../services/live-data';

const props = defineProps<{ projectId: string; projectName: string; running: boolean; canWrite: boolean }>();
const dialog = ref<HTMLDialogElement>();
const frame = ref<HTMLIFrameElement>();
const dataApp = ref<DataAppAccess & { appId: string | null; canApprove: boolean }>();
let generation = 0, inflight = 0;
async function refreshDataApp() {
  const epoch = generation;
  const info = await liveDataRequest<NonNullable<typeof dataApp.value>>(`/projects/${encodeURIComponent(props.projectId)}/application`);
  if (epoch === generation) dataApp.value = info;
}
async function approve(operation: DataAppOperationSummary) {
  if (!dataApp.value?.appId || !dataApp.value.canApprove || !operation.revision) return;
  if (!window.confirm(`启用数据库写操作？\n${operation.description}\n${operation.sql}\n批准后新增和保存可直接执行；删除也可直接提交。此处不修改数据。`)) return;
  const epoch = generation;
  try { await liveDataRequest(`/apps/${encodeURIComponent(dataApp.value.appId)}/operations/${encodeURIComponent(operation.operationId)}/approve`, 'POST', { revision: operation.revision }); if (epoch === generation) { await refreshDataApp(); frame.value?.contentWindow?.postMessage({ type: 'workmate.app.access-changed' }, '*'); } }
  catch (cause) { if (epoch === generation) error.value = cause instanceof Error ? cause.message : '批准失败'; }
}
async function receive(event: MessageEvent) {
  if (!dialog.value?.open || !dataApp.value?.appId || event.source !== frame.value?.contentWindow || !['workmate.app.query','workmate.app.mutate','workmate.app.access'].includes(event.data?.type)) return;
  const d = event.data, epoch = generation, appId = dataApp.value.appId;
  const send = (v: Record<string, unknown>) => { if (epoch === generation && dialog.value?.open && event.source === frame.value?.contentWindow) frame.value.contentWindow?.postMessage({ type: 'workmate.app.result', id: d.id, ...v }, '*'); };
  if (!Number.isSafeInteger(d.id) || typeof d.operationId !== 'string') { send({ ok: false, code: 'APP_BRIDGE_INVALID_REQUEST', error: '数据请求格式错误，请检查操作 ID 和请求编号' }); return; }
  if (JSON.stringify(d).length > 20000) { send({ ok: false, code: 'APP_BRIDGE_PAYLOAD_TOO_LARGE', error: '数据请求超过大小限制，请减少参数内容' }); return; }
  if (inflight >= 4) { send({ ok: false, code: 'APP_BRIDGE_BUSY', error: '数据通道正在处理其他请求，请稍后再试' }); return; }
  inflight++;
  try {
    if (d.type === 'workmate.app.access') { const access = await liveDataRequest<DataAppAccess>(`/apps/${encodeURIComponent(appId)}/operations`); send({ ok: true, data: access }); return; }
    let body: Record<string, unknown> = { operationId: d.operationId, parameters: d.parameters || {} }, path = 'query';
    if (d.type === 'workmate.app.mutate') {
      await refreshDataApp();
      if (epoch !== generation) return;
      const op = dataApp.value?.operations.find(o => o.operationId === d.operationId);
      if (!op?.approved || op.action === 'select') throw new Error('写操作尚未启用，请先在预览上方审核并确认操作定义。');
      if (!dataApp.value?.canWrite) throw new Error('当前对象未开启写入，或账号没有写入权限。');
      body = { ...body, revision: op.revision }; path = 'mutate';
    }
    if (epoch !== generation || !dialog.value?.open) return;
    const data = await liveDataRequest(`/apps/${encodeURIComponent(appId)}/${path}`, 'POST', body);
    send({ ok: true, data });
  } catch (cause) { send({ ok: false, error: cause instanceof Error ? cause.message : '操作失败' }); }
  finally { inflight--; }
}
const busy = ref(false), error = ref(''), notice = ref(''), confirming = ref(false);
const trialParameters = ref<Record<string,string>>({});
async function schemaAccess(){
  const info=dataApp.value;if(!info?.appId||!info.canApprove||busy.value)return;
  const enabled=!info.schemaCreation?.enabled;
  if(!window.confirm(enabled?'允许此数据对象创建新业务表？这是独立的结构权限，不会开启CRUD写入。每个建表方案仍需审核。':'关闭此对象的结构创建权限？已创建表不会删除。'))return;
  const epoch=generation;busy.value=true;error.value='';
  try{await liveDataRequest(`/apps/${encodeURIComponent(info.appId)}/schema-access`,'PATCH',{enabled,confirmed:true});if(epoch===generation)await refreshDataApp();}
  catch(cause){if(epoch===generation)error.value=cause instanceof Error?cause.message:'权限设置失败';}finally{busy.value=false;}
}
async function executeSchema(plan:DataSchemaPlan){
  const info=dataApp.value;if(!info?.appId||!info.canApprove||busy.value)return;
  if(!window.confirm(`创建 ${plan.tables.join('、')} 并加入当前数据对象及当前应用？\n请先在测试库验证完整SQL。MySQL建表可能立即提交，失败不能保证回滚；不会自动删除已建表。\n${plan.description}`))return;
  const epoch=generation;busy.value=true;error.value='';notice.value='';
  try{const result=await liveDataRequest<DataSchemaPlan>(`/apps/${encodeURIComponent(info.appId)}/schema-plans/${encodeURIComponent(plan.id)}/execute`,'POST',{revision:plan.revision,confirmed:true,includeInObject:true});if(epoch!==generation)return;await refreshDataApp();if(result.state==='applied')notice.value='新表已创建，并已纳入当前对象和应用。继续对话，让AI读取最新Schema生成页面。';else error.value=result.error||'结构执行结果未确认，请核对数据库，不要重复执行。';}
  catch(cause){if(epoch===generation)error.value=cause instanceof Error?cause.message:'结构执行失败，请核对数据库';}finally{busy.value=false;}
}
async function trialSql(op: DataAppOperationSummary) {
  if (!dataApp.value?.appId || !op.revision || busy.value) return;
  if (!window.confirm('仅在测试库执行！请确认当前对象连接的是测试库，并接受自增号/序列可能前进、外部副作用未必恢复。\n系统执行后会回滚，不会提交；这不是生产库无副作用保证。')) return;
  const epoch=generation, appId=dataApp.value.appId;
  busy.value=true; error.value=''; notice.value='';
  try {
    const parameters=JSON.parse(trialParameters.value[op.operationId] || '{}');
    await liveDataRequest(`/apps/${encodeURIComponent(appId)}/sql-trial`,'POST',{operationId:op.operationId,revision:op.revision,parameters,testDatabaseConfirmed:true,acknowledgeSideEffects:true});
    if(epoch!==generation)return;
    notice.value='事务试写通过，已回滚。自增号/序列可能变化。'; await refreshDataApp();
  } catch(cause) { if(epoch===generation) error.value=cause instanceof Error?cause.message:'试写失败，未确认回滚时请核对数据'; }
  finally { busy.value=false; }
}
const status = ref<ProjectApplicationStatus>();
const preview = ref<ProjectApplicationView>();
const viewing = ref<ProjectApplicationView>();
const viewMode = ref<'draft' | 'published'>('draft');
const viewReady = ref(false);
const viewUrl = computed(() => viewing.value ? orch.projectApplicationViewUrl(viewing.value) : '');
const unchanged = computed(() => !!preview.value && preview.value.revision === status.value?.published?.version);
const canPublish = computed(() => props.canWrite && !props.running && !!preview.value && viewReady.value && viewMode.value === 'draft' && !unchanged.value && !busy.value);

async function preparePreview() {
  if (busy.value || props.running) return;
  busy.value = true; error.value = ''; notice.value = ''; confirming.value = false;
  viewReady.value = false;
  try {
    status.value = await orch.getProjectApplication(props.projectId);
    await refreshDataApp();
    preview.value = undefined;
    if (status.value.entrypoint) {
      preview.value = await orch.previewProjectApplication(props.projectId);
      viewing.value = preview.value; viewMode.value = 'draft';
    } else viewing.value = undefined;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '预览失败，请重试。'; }
  finally { busy.value = false; }
}
async function open() {
  generation++; dataApp.value = undefined;
  error.value = ''; notice.value = ''; confirming.value = false;
  preview.value = undefined; viewing.value = undefined; status.value = undefined;
  viewReady.value = false;
  dialog.value?.showModal();
  if (!props.running) await preparePreview();
  else {
    busy.value = true;
    try { status.value = await orch.getProjectApplication(props.projectId); }
    catch (cause) { error.value = cause instanceof Error ? cause.message : '读取应用状态失败。'; }
    finally { busy.value = false; }
  }
}
async function openPublished() {
  if (busy.value) return;
  busy.value = true; error.value = ''; confirming.value = false; notice.value = '';
  viewReady.value = false;
  try { viewing.value = await orch.viewPublishedProjectApplication(props.projectId); viewMode.value = 'published'; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '打开已发布应用失败。'; }
  finally { busy.value = false; }
}
async function publish() {
  if (!canPublish.value || !preview.value || !confirming.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const published = await orch.publishProjectApplication(props.projectId, { revision: preview.value.revision, expectedVersion: status.value?.published?.version ?? null });
    status.value = { entrypoint: preview.value.entrypoint, published };
    viewReady.value = false;
    viewing.value = await orch.viewPublishedProjectApplication(props.projectId);
    viewMode.value = 'published'; confirming.value = false;
    notice.value = '本地发布成功。后续修改不会自动更新此版本。';
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '发布失败，原发布版本保持不变。'; }
  finally { busy.value = false; }
}
function close() { if (!busy.value) { generation++; dialog.value?.close(); } }
watch(viewUrl, () => { generation++; });
watch(() => props.projectId, () => { generation++; dialog.value?.close(); dataApp.value = undefined; });
onMounted(() => window.addEventListener('message', receive));
onBeforeUnmount(() => { generation++; window.removeEventListener('message', receive); });
</script>

<template>
  <button type="button" aria-haspopup="dialog" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold hover:border-[var(--accent)] hover:text-[var(--accent)]" @click="open">预览与发布</button>
  <Teleport to="body">
    <dialog ref="dialog" aria-labelledby="project-application-title" class="application-dialog m-auto w-[min(1120px,calc(100vw-24px))] max-h-[92dvh] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text)] shadow-2xl" @cancel="busy ? $event.preventDefault() : close()">
      <header class="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
        <div class="min-w-0"><h2 id="project-application-title" class="text-lg font-bold">项目应用</h2><p class="mt-1 truncate text-xs text-[var(--muted)]">{{ projectName }} · {{ dataApp?.appId ? '数据应用 · 当前账号验证' : '本地静态应用' }}</p></div>
        <button type="button" aria-label="关闭项目应用" :disabled="busy" class="shrink-0 rounded-lg px-3 py-2 text-sm hover:bg-[var(--surface-muted)] disabled:opacity-40" @click="close">关闭</button>
      </header>
      <div class="space-y-4 p-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0 text-xs leading-6 text-[var(--muted)]">
            <p>{{ status?.published ? `已发布 · ${new Date(status.published.publishedAt).toLocaleString()}` : '尚未发布' }}<span v-if="unchanged" class="ml-2 text-emerald-600">当前成果与发布版一致</span></p>
            <p v-if="preview">{{ preview.entrypoint }} · {{ preview.fileCount }} 个页面资源 · {{ Math.ceil(preview.bytes / 1024) }} KB</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button type="button" :disabled="busy || running" class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs disabled:opacity-40" @click="preparePreview">预览最新成果</button>
            <button v-if="status?.published" type="button" :disabled="busy" class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs disabled:opacity-40" @click="openPublished">打开已发布版本</button>
            <button v-if="canWrite" type="button" :disabled="!canPublish" class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40" @click="confirming = true">{{ status?.published ? '更新发布' : '发布应用' }}</button>
          </div>
        </div>
        <div class="rounded-xl bg-[var(--surface-muted)] px-4 py-3 text-xs leading-5 text-[var(--muted)]">
          <p>修改不会影响已发布版本，预览满意后再确认更新。</p>
          <details class="mt-2">
            <summary class="cursor-pointer font-medium">发布范围与资源清单</summary>
            <p class="mt-2">仅保存本地静态页面及资源（含 JSON），不部署到公网。上传材料目录、工具脚本和隐藏配置不参与发布；请检查下方清单，勿在页面资源中保存密钥。普通页面不能访问联网接口；关联数据应用通过受控通道查询，预览无需先发布。此处发布页面快照，数据工作台应用入口沿用其已绑定版本。资源使用相对路径，服务端程序不在此运行。</p>
            <ul v-if="preview?.resources.length" class="mt-2 max-h-28 overflow-y-auto rounded-lg bg-[var(--surface)] px-3 py-2 font-mono text-[11px]"><li v-for="resource in preview.resources" :key="resource" class="break-all">{{ resource }}</li></ul>
          </details>
        </div>
        <p v-if="running" role="status" class="text-sm text-amber-700">项目正在执行，完成后可预览并发布新成果；已发布版本仍可打开。</p>
        <p v-if="busy" role="status" class="text-sm text-[var(--muted)]">正在处理，请稍候…</p>
        <p v-if="error" role="alert" class="rounded-xl bg-rose-500/10 p-3 text-sm leading-6 text-rose-600">{{ error }}</p>
        <p v-if="notice" role="status" class="text-sm text-emerald-600">{{ notice }}</p>
        <section v-if="dataApp?.appId" class="rounded-xl border border-[var(--border)] p-4 text-xs leading-6">
          <p class="font-semibold">预览已接入数据网关，无需先发布。查询使用当前账号，数据库密码不进入页面。</p>
          <section v-if="dataApp.schemaCreation?.supported" class="mt-3 border-t border-[var(--border)] pt-3">
            <div class="flex flex-wrap items-center justify-between gap-2"><b>新业务表 · {{ dataApp.schemaCreation.enabled ? '允许结构创建' : '默认关闭结构创建' }}</b><button v-if="dataApp.canApprove" type="button" :disabled="busy" class="rounded border px-3 py-1" @click="schemaAccess">{{ dataApp.schemaCreation.enabled ? '关闭结构创建' : '开启结构创建' }}</button></div>
            <p class="text-[var(--muted)]">需要新表时，在项目对话中让AI生成建表方案；此处审核后执行。仅支持新MySQL表及其索引，不支持删除或改列；DDL不保证回滚。</p>
            <article v-for="plan in dataApp.schemaCreation.plans" :key="plan.id" class="mt-3 rounded border border-[var(--border)] p-3">
              <b>{{ plan.description }}</b><p>新增：{{ plan.tables.join('、') }} · {{ ({draft:'待审核',executing:'执行中',applied:'已创建并纳入对象',partial:'部分完成',failed:'未完成',unconfirmed:'结果未确认'})[plan.state] }} · {{ plan.completed }}/{{ plan.sql.length }}</p>
              <details><summary class="cursor-pointer">审核完整建表 SQL</summary><pre class="max-h-72 overflow-auto whitespace-pre-wrap">{{ plan.sql.join(';\n\n') }}</pre></details>
              <p v-if="plan.error" role="alert" class="text-rose-600">{{ plan.error }}</p>
              <button v-if="plan.state==='draft' && dataApp.canApprove" type="button" :disabled="busy || !dataApp.schemaCreation.enabled" class="mt-2 rounded border border-amber-400 px-3 py-1 disabled:opacity-50" @click="executeSchema(plan)">审核通过 · 创建并纳入当前应用</button>
            </article>
          </section>
          <div v-for="op in dataApp.operations.filter(o => o.kind === 'sql' && o.action !== 'select')" :key="op.operationId" class="mt-3 border-t border-[var(--border)] pt-3">
            <p>{{ op.description }} · {{ !op.approved ? '待审核启用' : !dataApp.canWrite ? '已审核 · 对象只读或账号无写入权限' : '已启用 · 提交即可保存' }}</p>
            <details><summary class="cursor-pointer">查看 SQL 定义</summary><pre class="overflow-auto whitespace-pre-wrap">{{ op.sql }}</pre></details>
            <p v-if="op.validation">{{ op.validation.level === 'rollback' ? '事务试写通过，已回滚' : '静态与数据库预检查通过，未试写' }} · {{ new Date(op.validation.checkedAt).toLocaleString() }}</p>
            <details v-if="op.approved && dataApp.canWrite && dataApp.canApprove" class="mt-2"><summary class="cursor-pointer">可选：事务试写（仅测试库）</summary><p>填写测试参数 JSON；执行后回滚，但自增号/序列未必恢复。</p><p>参数：{{ op.parameters.map(p => `${p.name} (${p.type})`).join('、') }}</p><textarea v-model="trialParameters[op.operationId]" placeholder="{}" aria-label="事务试写参数 JSON" class="w-full rounded border p-2 font-mono" /><button type="button" :disabled="busy" class="rounded border px-3 py-1 disabled:opacity-50" @click="trialSql(op)">事务试写并回滚</button></details>
            <button v-if="!op.approved && dataApp.canApprove" class="mt-2 rounded-lg border border-amber-400 px-3 py-1 text-amber-700" type="button" @click="approve(op)">审核并启用此写操作</button>
          </div>
        </section>
        <div v-if="confirming" class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-soft)] p-4">
          <p class="text-sm leading-6">确认{{ status?.published ? '更新' : '发布' }}已预览的 {{ preview?.fileCount }} 个页面资源？{{ status?.published ? '成功后切换为新版本，失败保留原版本。' : '仅保存本地可查看版本，不会自动公开到互联网。' }}</p>
          <div class="flex gap-2"><button type="button" :disabled="busy" class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs disabled:opacity-40" @click="confirming = false">暂不发布</button><button type="button" :disabled="!canPublish" class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40" @click="publish">确认发布</button></div>
        </div>
        <div v-if="viewUrl" class="overflow-hidden rounded-xl border border-[var(--border)]">
          <p class="border-b border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--muted)]">{{ viewMode === 'published' ? '已发布快照' : '最新成果预览（尚未发布）' }} · 查看链接30分钟后失效，可重新打开</p>
          <p v-if="!viewReady" role="status" class="px-3 py-2 text-xs text-[var(--muted)]">正在加载页面预览…</p>
          <iframe ref="frame" :key="viewUrl" :src="viewUrl" title="项目应用预览" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" class="h-[min(55dvh,580px)] min-h-[260px] w-full bg-white" @load="viewReady = true" />
        </div>
        <div v-else-if="status && !status.entrypoint && !busy" class="rounded-xl border border-dashed border-[var(--border)] px-5 py-12 text-center">
          <h3 class="font-semibold">还没有网站入口</h3><p class="mt-2 text-sm leading-6 text-[var(--muted)]">在项目对话中描述要创建的应用，生成 index.html 后即可预览与发布。</p>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.application-dialog::backdrop { background: rgb(15 23 42 / 35%); backdrop-filter: blur(3px); }
</style>
