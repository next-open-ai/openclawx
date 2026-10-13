<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { remoteDatabaseConnectionSchema, remoteDatabaseImportSchema } from '@workmate/contracts';
import { inspectDatabaseConnection, importDatabaseObject, refreshDatabaseObject, type DataSource } from '../../services/api';

const props = defineProps<{ source?: DataSource | null }>();
const emit = defineEmits<{ close: []; saved: [source: DataSource] }>();
const saved = props.source?.databaseConnection;
const engine = ref<'mysql' | 'postgresql'>(saved?.engine || 'mysql');
const host = ref(saved?.host || '');
const port = ref(saved?.port || 3306);
const user = ref(saved?.user || '');
const password = ref('');
const tls = ref(saved?.tls ?? true);
const ca = ref(saved?.ca || '');
const database = ref(saved?.database || '');
const objectName = ref(props.source?.name || '');
const databases = ref<string[]>([]);
const tables = ref<Array<{ schema: string; name: string; description: string }>>([]);
const selectedKeys = ref<string[]>([]);
const search = ref('');
const busy = ref<'connect' | 'tables' | 'import' | ''>('');
const error = ref('');
const connected = ref(false);
const connectionEditing = ref(true);
const key = (t: { schema: string; name: string }) => JSON.stringify([t.schema, t.name]);
const filteredTables = computed(() => tables.value.filter(t => `${t.schema}.${t.name} ${t.description}`.toLowerCase().includes(search.value.toLowerCase())));
const refresh = computed(() => Boolean(saved));
const dialog = ref<HTMLElement | null>(null);
let previousFocus: HTMLElement | null = null;
onMounted(() => { previousFocus = document.activeElement as HTMLElement; dialog.value?.querySelector<HTMLInputElement>('input:not([type="checkbox"])')?.focus(); });
function keepFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const controls = [...(dialog.value?.querySelectorAll<HTMLElement>('button,input,select,textarea,summary') || [])].filter(el => el.offsetParent !== null && !el.matches(':disabled'));
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
watch(engine, value => { port.value = value === 'mysql' ? 3306 : 5432; database.value = ''; });
watch([engine, host, port, user, password, tls, ca], () => { connected.value = false; databases.value = []; tables.value = []; selectedKeys.value = []; });
watch(database, () => { tables.value = []; selectedKeys.value = []; });
onBeforeUnmount(() => { password.value = ''; if (previousFocus?.isConnected) previousFocus.focus(); });
function connection() {
  return remoteDatabaseConnectionSchema.parse({ engine: engine.value, host: host.value, port: port.value, user: user.value, password: password.value, database: database.value, tls: tls.value, ca: ca.value });
}
function failure(e: unknown) {
  error.value = e && typeof e === 'object' && 'issues' in e ? '请检查连接信息，并选择数据库和数据表。' : e instanceof Error ? e.message : '连接失败，请重试。';
}
async function inspect(includeTables = false) {
  busy.value = includeTables ? 'tables' : 'connect'; error.value = '';
  try {
    const result = await inspectDatabaseConnection(connection());
    databases.value = result.databases; connected.value = true; connectionEditing.value = false;
    tables.value = result.tables; selectedKeys.value = [];
    if (database.value && !objectName.value) objectName.value = database.value;
  } catch (e) { connected.value = false; tables.value = []; failure(e); }
  finally { busy.value = ''; }
}
async function submit() {
  busy.value = 'import'; error.value = '';
  try {
    const source = refresh.value && props.source
      ? await refreshDatabaseObject(props.source.id, password.value)
      : await importDatabaseObject(remoteDatabaseImportSchema.parse({ connection: connection(), name: objectName.value || database.value, tables: tables.value.filter(t => selectedKeys.value.includes(key(t))) }));
    password.value = ''; emit('saved', source);
  } catch (e) { failure(e); } finally { busy.value = ''; }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" @click.self="!busy && emit('close')">
    <section ref="dialog" role="dialog" aria-modal="true" aria-labelledby="database-dialog-title" class="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl" @keydown="keepFocus" @keydown.esc.stop="!busy && emit('close')">
      <header class="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border)] px-6 py-5">
        <div><h2 id="database-dialog-title" class="text-xl font-bold">{{ refresh ? '刷新数据库本地副本' : '导入数据库本地副本' }}</h2><p class="mt-1 text-sm text-[var(--muted)]">{{ refresh ? '保持现有表与标注，重新读取原库数据。' : '只读导入 MySQL 或 PostgreSQL 数据，不创建实时连接。' }}</p></div>
        <button type="button" aria-label="关闭连接窗口" class="rounded-lg px-2 py-1 text-xl text-[var(--muted)] disabled:opacity-40" :disabled="Boolean(busy)" @click="emit('close')">×</button>
      </header>
      <form id="database-connect-form" class="min-h-0 overflow-y-auto px-6 py-5" @submit.prevent="submit">
        <fieldset :disabled="Boolean(busy)" class="min-w-0 space-y-5">
          <template v-if="!refresh">
            <div class="grid grid-cols-2 gap-3" role="group" aria-label="数据库类型">
              <button v-for="item in [{ id: 'mysql', label: 'MySQL', hint: '默认端口 3306' }, { id: 'postgresql', label: 'PostgreSQL', hint: '默认端口 5432' }]" :key="item.id" type="button" :aria-pressed="engine === item.id" class="rounded-xl border p-3 text-left transition-colors" :class="engine === item.id ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)]'" @click="engine = item.id as typeof engine"><span class="block text-sm font-bold">{{ item.label }}</span><span class="mt-1 block text-xs text-[var(--muted)]">{{ item.hint }}</span></button>
            </div>
            <div v-if="!connected || connectionEditing" class="space-y-4">
            <div class="grid gap-4 sm:grid-cols-[1fr_110px]">
              <label><span class="db-label">服务器地址</span><input v-model="host" required maxlength="253" placeholder="例如 db.example.com 或 192.168.1.10" class="db-input" autocomplete="off" /></label>
              <label><span class="db-label">端口</span><input v-model.number="port" required type="number" min="1" max="65535" class="db-input" /></label>
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              <label><span class="db-label">用户名</span><input v-model="user" required maxlength="128" placeholder="建议使用只读账号" class="db-input" autocomplete="off" /></label>
              <label><span class="db-label">密码</span><input v-model="password" type="password" maxlength="4096" placeholder="仅用于本次连接" class="db-input" autocomplete="new-password" /></label>
            </div>
            <details class="rounded-xl border border-[var(--border)] p-3"><summary class="cursor-pointer text-sm font-semibold">高级连接设置</summary><div class="mt-4 space-y-4">
              <label class="flex items-center gap-2 text-sm"><input v-model="tls" type="checkbox" class="accent-[var(--accent)]" />使用 TLS 加密（校验证书）</label>
              <p class="text-xs leading-5 text-[var(--muted)]">本地数据库未启用 TLS 时可关闭。远程连接建议保持开启。</p>
              <label v-if="tls"><span class="db-label">自定义 CA 证书（可选）</span><textarea v-model="ca" rows="3" maxlength="32768" placeholder="PEM 格式；留空使用系统可信证书" class="db-input font-mono" /></label>
              <label><span class="db-label">指定数据库（可选）</span><input v-model="database" maxlength="128" class="db-input" placeholder="PostgreSQL 默认先连接 postgres；也可直接指定" /></label>
            </div></details>
            </div>
            <div v-else class="flex items-start justify-between gap-3 rounded-xl bg-[var(--surface-muted)] p-3"><div class="min-w-0"><p class="break-all text-sm font-semibold">{{ host }}:{{ port }}</p><p class="mt-1 text-xs text-[var(--muted)]">{{ user }} · {{ tls ? 'TLS 已开启' : '未启用 TLS' }}</p></div><button type="button" class="shrink-0 text-xs font-semibold text-[var(--accent)]" @click="connectionEditing = true">更改连接</button></div>
            <div class="flex items-center justify-between gap-3"><p class="text-xs text-[var(--muted)]">密码不保存到本机，刷新时再次输入。</p><button type="button" :disabled="!host.trim() || !user.trim()" class="db-secondary" @click="inspect(Boolean(database))">{{ connected ? '重新测试' : '测试连接' }}</button></div>
            <div v-if="connected" class="space-y-4 border-t border-[var(--border)] pt-5">
              <p role="status" class="text-sm font-semibold text-emerald-700">连接成功，请选择要接入的数据。</p>
              <div class="flex flex-wrap items-end gap-3"><label class="min-w-0 flex-1"><span class="db-label">数据库</span><select v-model="database" class="db-input"><option value="">选择数据库</option><option v-for="name in [...new Set([...databases, ...(database ? [database] : [])])]" :key="name" :value="name">{{ name }}</option></select></label><button type="button" class="db-secondary" :disabled="!database" @click="inspect(true)">读取数据表</button></div>
              <template v-if="tables.length">
                <div class="flex items-center justify-between"><span class="text-sm font-semibold">数据表 <span class="font-normal text-[var(--muted)]">已选 {{ selectedKeys.length }} / 20</span></span><button type="button" class="text-xs text-[var(--accent)]" @click="selectedKeys = []">清除选择</button></div>
                <input v-model="search" aria-label="搜索数据表" class="db-input" placeholder="搜索表名或说明" />
                <div class="max-h-52 overflow-y-auto rounded-xl border border-[var(--border)]">
                  <label v-for="table in filteredTables" :key="key(table)" class="flex cursor-pointer items-start gap-3 border-b border-[var(--border)] px-3 py-2.5 last:border-0 hover:bg-[var(--surface-muted)]"><input v-model="selectedKeys" type="checkbox" :value="key(table)" :disabled="selectedKeys.length >= 20 && !selectedKeys.includes(key(table))" class="mt-1 accent-[var(--accent)]" /><span class="min-w-0"><b class="block break-all text-sm">{{ table.schema }}.{{ table.name }}</b><span v-if="table.description" class="mt-0.5 block break-words text-xs text-[var(--muted)]">{{ table.description }}</span></span></label>
                  <p v-if="!filteredTables.length" class="p-4 text-sm text-[var(--muted)]">没有匹配的数据表。</p>
                </div>
                <label><span class="db-label">数据对象名称</span><input v-model="objectName" maxlength="100" class="db-input" :placeholder="database" /></label>
              </template>
              <p v-else class="text-sm text-[var(--muted)]">选择数据库并读取数据表；若列表为空，请检查账号读取权限。</p>
            </div>
          </template>
          <template v-else>
            <div class="rounded-xl bg-[var(--surface-muted)] p-4"><p class="font-semibold">{{ source?.name }}</p><p class="mt-2 break-all text-sm text-[var(--muted)]">{{ saved?.host }}:{{ saved?.port }} / {{ saved?.database }}</p><p class="mt-1 text-xs text-[var(--muted)]">{{ saved?.tables.length }} 张表，最近刷新 {{ new Date(saved?.lastSyncedAt || 0).toLocaleString() }}</p></div>
            <label><span class="db-label">本次连接密码</span><input v-model="password" type="password" maxlength="4096" class="db-input" autocomplete="new-password" placeholder="密码不会保存" autofocus /></label>
          </template>
          <p class="rounded-xl bg-[var(--surface-muted)] p-3 text-xs leading-5 text-[var(--muted)]">导入为本地快照，每表最多 20,000 行、合计 20 MB。应用使用本地副本，不回写原库；刷新将替换副本中的数据，请先保留本地修改。</p>
        </fieldset>
        <p v-if="busy" role="status" class="mt-4 text-sm text-[var(--accent)]">{{ busy === 'import' ? '正在读取数据并保存快照…' : busy === 'tables' ? '正在读取数据库结构…' : '正在测试连接…' }}</p>
        <p v-if="error" role="alert" class="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{{ error }}</p>
      </form>
      <footer class="flex shrink-0 justify-end gap-3 border-t border-[var(--border)] px-6 py-4"><button type="button" :disabled="Boolean(busy)" class="db-secondary" @click="emit('close')">取消</button><button type="submit" form="database-connect-form" class="rounded-xl bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40" :disabled="Boolean(busy) || (!refresh && (!connected || !selectedKeys.length || !database))">{{ refresh ? '刷新快照' : '接入数据' }}</button></footer>
    </section>
  </div>
</template>

<style scoped>
.db-label { display:block; margin-bottom:6px; font-size:12px; font-weight:600; }
.db-input { width:100%; min-width:0; border:1px solid var(--border); border-radius:10px; background:var(--surface-muted); padding:10px 12px; font-size:14px; color:var(--text); outline:none; }
.db-input:focus { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-soft); }
.db-secondary { border:1px solid var(--border); border-radius:10px; padding:9px 14px; font-size:14px; font-weight:600; white-space:nowrap; }
button:disabled { opacity:.45; cursor:not-allowed; }
</style>
