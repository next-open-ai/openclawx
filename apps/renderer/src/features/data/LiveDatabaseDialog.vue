<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { savedDatabaseConnectionSchema } from '@openclawx/contracts';
import { liveDataRequest, type SavedDatabaseConnection } from '../../services/live-data';
import type { DataSource } from '../../services/api';
const props = defineProps<{ initialConnectionId?: string; credentialOnly?: boolean }>();
const emit = defineEmits<{ close: []; saved: [source: DataSource]; credentialSaved: [connectionId: string] }>();
const dialog = ref<HTMLDialogElement>();
const connections = ref<SavedDatabaseConnection[]>([]), connectionId = ref(''), editing = ref(false), renewing = ref(false);
const form = ref({ name: '', engine: 'mysql' as 'mysql' | 'postgresql', host: '', port: 3306, user: '', password: '', database: '', tls: true, ca: '' });
const database = ref(''), databases = ref<string[]>([]), tables = ref<{ schema: string; name: string; description: string }[]>([]);
const selected = ref<string[]>([]), name = ref(''), search = ref(''), busy = ref(false), error = ref(''), notice = ref('');
const current = computed(() => connections.value.find(c => c.id === connectionId.value));
const tableKey = (t: { schema: string; name: string }) => JSON.stringify([t.schema, t.name]);
const filtered = computed(() => tables.value.filter(t => `${t.schema}.${t.name} ${t.description}`.toLowerCase().includes(search.value.toLowerCase())));
watch(() => form.value.engine, engine => { form.value.port = engine === 'mysql' ? 3306 : 5432; });
watch(connectionId, () => { database.value = ''; databases.value = []; tables.value = []; selected.value = []; notice.value = ''; renewing.value = false; form.value.password = ''; });
watch(database, () => { tables.value = []; selected.value = []; });
async function attempt(action: () => Promise<void>) { busy.value = true; error.value = ''; notice.value = ''; try { await action(); } catch (e) { error.value = e instanceof Error ? e.message : '操作失败'; } finally { busy.value = false; } }
async function load() { connections.value = (await liveDataRequest<{ connections: SavedDatabaseConnection[] }>('/connections')).connections; if (!connectionId.value) connectionId.value = connections.value[0]?.id || ''; editing.value = !connections.value.length; }
onMounted(async () => { dialog.value?.showModal(); await attempt(async () => {
  await load();
  if (props.initialConnectionId && connections.value.some(c => c.id === props.initialConnectionId)) {
    connectionId.value = props.initialConnectionId; await nextTick(); renewing.value = true;
    await nextTick(); dialog.value?.querySelector<HTMLInputElement>('input[type="password"]')?.focus();
  } else if (props.credentialOnly) {
    connectionId.value = ''; throw new Error('当前绑定连接不存在或无权访问。请关闭窗口并检查数据对象的连接配置。');
  }
}); });
onBeforeUnmount(() => { form.value.password = ''; });
async function saveConnection() { await attempt(async () => {
  const parsed = savedDatabaseConnectionSchema.safeParse({ name: form.value.name, connection: form.value });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || '请检查连接配置');
  const saved = await liveDataRequest<SavedDatabaseConnection>('/connections', 'POST', parsed.data);
  form.value.password = ''; await load(); connectionId.value = saved.id; editing.value = false; await nextTick(); notice.value = '连接已保存，选择数据库和数据表即可创建对象。';
}); }
async function inspect() { await attempt(async () => {
  const result = await liveDataRequest<{ databases: string[]; tables: typeof tables.value }>(`/connections/${connectionId.value}/inspect?database=${encodeURIComponent(database.value)}`);
  databases.value = result.databases; tables.value = result.tables; selected.value = [];
  notice.value = database.value ? `已读取 ${tables.value.length} 张表` : '请选择数据库，再读取数据表。';
}); }
async function renew() { await attempt(async () => {
  if (!current.value || (props.credentialOnly && connectionId.value !== props.initialConnectionId)) throw new Error('当前绑定连接不可用，请重新打开窗口。');
  const id = connectionId.value;
  await liveDataRequest(`/connections/${id}/credential`, 'POST', { password: form.value.password });
  form.value.password = ''; renewing.value = false; notice.value = '连接测试与密码保存成功。';
  if (props.credentialOnly) emit('credentialSaved', id);
}); }
async function create() { await attempt(async () => {
  const source = await liveDataRequest<DataSource>('/sources/live', 'POST', { connectionId: connectionId.value, database: database.value, name: name.value.trim() || database.value, tables: tables.value.filter(t => selected.value.includes(tableKey(t))).map(({ schema, name }) => ({ schema, name })) });
  emit('saved', source);
}); }
</script>
<template>
  <dialog ref="dialog" class="live-dialog" aria-labelledby="live-db-title" @cancel.prevent="!busy && emit('close')">
    <header><div><h2 id="live-db-title">{{ credentialOnly ? '恢复当前数据库连接' : '数据库连接' }}</h2><p>{{ credentialOnly ? '补填此前未保存的密码。测试并保存成功后，返回继续创建应用。' : '复用连接，选择表，创建默认只读的实时数据对象。' }}</p></div><button :disabled="busy" aria-label="关闭" @click="emit('close')">×</button></header>
    <div class="body"><fieldset :disabled="busy">
      <template v-if="credentialOnly">
        <form v-if="current" id="repair-credential-form" class="panel space-y-4" @submit.prevent="renew">
          <div><b>{{ current.name }}</b><p>{{ current.engine }} · {{ current.host }}:{{ current.port }} · {{ current.user }}</p></div>
          <label>连接密码<input v-model="form.password" aria-label="当前连接密码" type="password" maxlength="4096" autocomplete="new-password" placeholder="请输入原数据库密码；允许空密码" /></label>
          <p>不会新建连接或数据对象。桌面运行时密码加密保存；此前已丢失的密码需补填一次。</p>
        </form>
      </template>
      <template v-else>
      <div class="flex items-end gap-3"><label class="min-w-0 flex-1">已保存连接<select v-model="connectionId"><option value="">请选择连接</option><option v-for="c in connections" :key="c.id" :value="c.id">{{ c.name }} · {{ c.engine }}</option></select></label><button class="secondary" @click="editing = !editing; renewing = false">{{ editing ? '取消新增' : '新建连接' }}</button></div>
      <form v-if="editing" class="panel space-y-4" @submit.prevent="saveConnection">
        <div class="grid gap-4 sm:grid-cols-2"><label>连接名称<input v-model="form.name" required maxlength="100" placeholder="例如：经营分析数据库" /></label><label>数据库类型<select v-model="form.engine"><option value="mysql">MySQL</option><option value="postgresql">PostgreSQL</option></select></label></div>
        <div class="grid gap-4 sm:grid-cols-[1fr_110px]"><label>服务器地址<input v-model="form.host" required maxlength="253" placeholder="db.example.com" /></label><label>端口<input v-model.number="form.port" type="number" min="1" max="65535" required /></label></div>
        <div class="grid gap-4 sm:grid-cols-2"><label>用户名<input v-model="form.user" required maxlength="128" placeholder="推荐只读账号" autocomplete="off" /></label><label>密码<input v-model="form.password" type="password" maxlength="4096" autocomplete="new-password" /></label></div>
        <label>初始数据库（可选）<input v-model="form.database" maxlength="128" placeholder="PostgreSQL 默认连接 postgres" /></label>
        <label class="check"><input v-model="form.tls" type="checkbox" />TLS 加密并校验证书</label><label v-if="form.tls">CA 证书（可选）<textarea v-model="form.ca" rows="2" maxlength="32768" placeholder="留空使用系统可信证书" /></label>
        <p>桌面版及桌面开发模式密码加密保存；无桌面的纯 API 模式仅在本次服务会话内保留。</p><button type="submit" class="primary">测试并保存连接</button>
      </form>
      <template v-if="current && !editing">
        <div class="panel"><b>{{ current.host }}:{{ current.port }}</b><p>{{ current.credentialPersistence === 'desktop' ? '密码由桌面安全存储管理' : '开发模式：密码仅在本次服务会话有效' }} · {{ current.tls ? 'TLS' : '未加密' }}</p><button class="link" @click="renewing = !renewing">重新填写密码</button><form v-if="renewing" class="mt-3 flex gap-3" @submit.prevent="renew"><input v-model="form.password" aria-label="新的连接密码" type="password" maxlength="4096" autocomplete="new-password" /><button class="secondary">更新</button></form></div>
        <div class="flex items-end gap-3"><label class="min-w-0 flex-1">数据库<select v-model="database"><option value="">先读取数据库列表</option><option v-for="db in databases" :key="db">{{ db }}</option></select></label><button class="secondary" @click="inspect">{{ database ? '读取数据表' : '读取数据库' }}</button></div>
        <template v-if="tables.length"><div class="flex items-center justify-between"><b>选择数据表</b><span class="text-xs text-[var(--muted)]">已选 {{ selected.length }} / 20</span></div><input v-model="search" aria-label="筛选数据表" placeholder="按表名或说明筛选" /><div class="tables"><label v-for="t in filtered" :key="tableKey(t)" class="check"><input v-model="selected" type="checkbox" :value="tableKey(t)" :disabled="selected.length >= 20 && !selected.includes(tableKey(t))" /><span><b>{{ t.schema }}.{{ t.name }}</b><small>{{ t.description }}</small></span></label><p v-if="!filtered.length">没有匹配的数据表。</p></div><label>数据对象名称<input v-model="name" maxlength="100" :placeholder="database" /></label></template>
      </template>
      </template>
    </fieldset><p v-if="busy" role="status">正在处理，请稍候…</p><p v-if="notice" role="status" class="text-emerald-700">{{ notice }}</p><p v-if="error" role="alert" class="text-rose-700">{{ error }}</p></div>
    <footer><p>{{ credentialOnly ? '成功后返回原应用草稿，不会自动调用 AI。' : '仅登记表结构，不导入业务数据。写入需在对象中单独开启。' }}</p><button class="secondary" :disabled="busy" @click="emit('close')">{{ credentialOnly ? '返回' : '关闭' }}</button><button v-if="credentialOnly" type="submit" form="repair-credential-form" class="primary" :disabled="busy || !current">{{ busy ? '测试并保存中…' : '测试保存并返回' }}</button><button v-else class="primary" :disabled="busy || editing || !database || !selected.length" @click="create">创建实时对象</button></footer>
  </dialog>
</template>
<style scoped>
.live-dialog{width:min(680px,calc(100vw - 32px));max-height:90dvh;padding:0;border:1px solid var(--border);border-radius:20px;background:var(--surface);color:var(--text);box-shadow:0 24px 80px #0003}.live-dialog[open]{display:flex;flex-direction:column}.live-dialog::backdrop{background:#11182766}header,footer{display:flex;align-items:center;gap:16px;padding:20px 24px;flex-shrink:0}header{justify-content:space-between;border-bottom:1px solid var(--border)}h2{font-weight:750;font-size:20px}p{font-size:12px;line-height:1.7;color:var(--muted);margin-top:5px}header button{font-size:24px}.body{overflow:auto;padding:24px}fieldset{display:flex;flex-direction:column;gap:18px;min-width:0}label{display:block;font-size:13px;font-weight:600}input:not([type=checkbox]),select,textarea{display:block;width:100%;margin-top:7px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface);font-weight:400;min-width:0}input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:2px}.check{display:flex;gap:10px;align-items:center}.check input{accent-color:var(--accent)}.panel{border-radius:12px;background:var(--surface-muted);padding:16px}.tables{max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:12px}.tables label{padding:12px;border-bottom:1px solid var(--border)}small{display:block;font-weight:400;color:var(--muted)}footer{border-top:1px solid var(--border);flex-wrap:wrap}footer p{flex:1;min-width:160px}.primary,.secondary{font-size:13px;font-weight:600;padding:10px 14px;border-radius:10px;white-space:nowrap}.primary{background:var(--accent);color:white}.secondary{border:1px solid var(--border);background:var(--surface)}.link{font-size:12px;color:var(--accent);margin-top:8px}button:disabled{opacity:.45;cursor:not-allowed}.text-rose-700{color:#be123c}.text-emerald-700{color:#047857}
</style>
