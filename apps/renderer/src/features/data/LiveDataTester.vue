<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { liveDataRequest } from '../../services/live-data';
import type { DataSource, DataTable } from '../../services/api';
type RecordRow = { id: string; values: Record<string, string | null> };
const props = defineProps<{ source: DataSource; table: DataTable }>();
const emit = defineEmits<{ updated: [source: DataSource] }>();
const search = ref(''), rows = ref<RecordRow[]>([]), busy = ref(false), loading = ref(false), error = ref(''), notice = ref(''), hasMore = ref(false);
const action = ref<'enable' | 'disable' | 'insert' | 'update' | 'delete'>('insert'), dialog = ref<HTMLDialogElement>();
const selected = ref<RecordRow | null>(null), draft = ref<Record<string, string>>({}), nulls = ref<Record<string, boolean>>({});
const metadata = computed(() => props.source.liveConnection?.tables.find(t => t.tableId === props.table.id));
const writable = computed(() => props.source.liveConnection?.writeEnabled && metadata.value?.writable);
const columns = computed(() => props.table.columns.filter(c => {
  const m = metadata.value?.columns.find(m => m.id === c.id);
  return m && !m.generated && !(action.value === 'update' && m.primary);
}));
let querySequence = 0;
async function query() {
  const seq = ++querySequence, sourceId = props.source.id, tableId = props.table.id;
  loading.value = true; error.value = ''; rows.value = [];
  try {
    const result = await liveDataRequest<{ rows: RecordRow[]; hasMore: boolean }>(`/gateway/records?${new URLSearchParams({ sourceId, tableId, search: search.value, limit: '100' })}`);
    if (seq === querySequence) { rows.value = result.rows; hasMore.value = result.hasMore; }
  } catch (e) { if (seq === querySequence) error.value = e instanceof Error ? e.message : '读取失败'; }
  finally { if (seq === querySequence) loading.value = false; }
}
watch([() => props.source.id, () => props.table.id], () => { search.value = ''; notice.value = ''; dialog.value?.close(); void query(); }, { immediate: true });
async function open(type: typeof action.value, record: RecordRow | null = null) {
  action.value = type; selected.value = record; draft.value = {}; nulls.value = {}; error.value = '';
  for (const col of props.table.columns) { draft.value[col.id] = record?.values[col.id] ?? ''; nulls.value[col.id] = record?.values[col.id] === null; }
  await nextTick(); dialog.value?.showModal();
}
async function submit() {
  busy.value = true; error.value = ''; notice.value = '';
  try {
    if (action.value === 'enable' || action.value === 'disable') {
      emit('updated', await liveDataRequest<DataSource>(`/sources/${props.source.id}/access`, 'PATCH', { writeEnabled: action.value === 'enable', confirm: action.value === 'enable' }));
      notice.value = action.value === 'enable' ? '已开启原库写入。每次写入仍需确认。' : '已恢复只读。';
    } else {
      const fields: Record<string, string | null> = {};
      for (const col of columns.value) {
        if (action.value === 'insert' && draft.value[col.id] === '' && !nulls.value[col.id]) continue;
        fields[col.id] = nulls.value[col.id] ? null : draft.value[col.id];
      }
      await liveDataRequest('/gateway/records', action.value === 'insert' ? 'POST' : action.value === 'update' ? 'PATCH' : 'DELETE', { sourceId: props.source.id, tableId: props.table.id, ...(action.value === 'delete' ? {} : { fields }), ...(selected.value ? { recordId: selected.value.id } : {}) });
      notice.value = '操作成功，已重新读取原库数据。'; await query();
    }
    dialog.value?.close();
  } catch (e) { error.value = e instanceof Error ? e.message : '操作失败，请刷新核对'; }
  finally { busy.value = false; }
}
const title = computed(() => ({ enable: '开启原库写入', disable: '恢复只读', insert: '新增记录', update: '修改记录', delete: '删除记录' })[action.value]);
</script>
<template>
  <section class="tester">
    <div class="policy"><div><b>{{ source.liveConnection?.writeEnabled ? '已允许原库写入' : '只读访问' }}</b><p>{{ source.liveConnection?.writeEnabled ? '此处操作直接影响原数据库，不是本地副本。' : '查询实时读取原数据库，默认不会修改业务数据。' }}</p></div><button class="secondary" :disabled="busy || loading" @click="open(source.liveConnection?.writeEnabled ? 'disable' : 'enable')">{{ source.liveConnection?.writeEnabled ? '恢复只读' : '开启写入…' }}</button></div>
    <p v-if="!metadata?.writable" class="hint">此表没有可用主键、含不可安全比较的二进制字段，或不支持安全事务，仅支持查询。字段说明修改不影响原库结构。</p>
    <form class="toolbar" @submit.prevent="query"><input v-model="search" aria-label="搜索实时数据" maxlength="120" placeholder="搜索当前表的数据…" /><button class="secondary" :disabled="loading || busy">{{ loading ? '查询中…' : '查询 / 刷新' }}</button><button type="button" class="primary" :disabled="!writable || busy || loading" @click="open('insert')">新增记录</button></form>
    <p v-if="notice" role="status" class="success">{{ notice }}</p><p v-if="error && !dialog?.open" role="alert" class="failure">{{ error }}</p>
    <div class="grid-wrap" :aria-busy="loading"><table><thead><tr><th v-for="col in table.columns" :key="col.id" :title="col.description">{{ col.name }}<small v-if="metadata?.columns.find(c => c.id === col.id)?.primary">主键</small></th><th>操作</th></tr></thead><tbody><tr v-for="(record, i) in rows" :key="record.id || i"><td v-for="col in table.columns" :key="col.id"><span v-if="record.values[col.id] === null" class="null">NULL</span><span v-else>{{ record.values[col.id] }}</span></td><td class="actions"><button :disabled="!writable || busy || loading" @click="open('update', record)">修改</button><button :disabled="!writable || busy || loading" @click="open('delete', record)">删除</button></td></tr></tbody></table><p v-if="!rows.length">{{ loading ? '正在从数据库读取…' : error ? '未能读取数据，请检查提示后重试。' : '没有符合条件的记录。' }}</p></div>
    <p class="hint">已显示 {{ rows.length }} 条{{ hasMore ? '，仍有更多结果；请缩小搜索范围。' : '。' }}单次最多 100 条，记录编辑凭证 15 分钟有效。</p>
    <dialog ref="dialog" class="edit-dialog" :aria-label="title" @cancel.prevent="!busy && dialog?.close()"><form @submit.prevent="submit"><header><h3>{{ title }}</h3><button type="button" :disabled="busy" aria-label="关闭" @click="dialog?.close()">×</button></header><div class="edit-body">
      <p v-if="action === 'enable'" class="warning">开启后，该对象中有主键的表可通过 Gateway 新增、修改和删除原库数据。建议先在测试库验证，并确保有备份；数据库账号权限仍然生效。确定开启吗？</p>
      <p v-else-if="action === 'disable'">恢复后将拒绝后续写入。已经完成的写入不会撤销。</p>
      <p v-else-if="action === 'delete'" class="warning">确定删除这条原库记录吗？此操作无法在 OpenClawX 中撤销。</p>
      <template v-else><p class="warning">将写入原数据库。主键不可修改；自动生成字段由数据库处理。新增时留空字段不提交，由数据库默认值处理。</p><label v-for="col in columns" :key="col.id" class="field"><span>{{ col.name }} <small>{{ col.description }}</small></span><input v-model="draft[col.id]" :disabled="busy || nulls[col.id]" maxlength="8192" /><span v-if="metadata?.columns.find(c => c.id === col.id)?.nullable" class="null-toggle"><input v-model="nulls[col.id]" type="checkbox" :disabled="busy" />设为 NULL</span></label></template>
      <p v-if="error" role="alert" class="failure">{{ error }}</p>
    </div><footer><button type="button" class="secondary" :disabled="busy" @click="dialog?.close()">取消</button><button class="primary" :disabled="busy">{{ busy ? '处理中…' : '确认' + title }}</button></footer></form></dialog>
  </section>
</template>
<style scoped>
.tester{margin-top:16px}.policy{display:flex;gap:16px;justify-content:space-between;align-items:center;border:1px solid var(--border);border-radius:12px;padding:16px;background:var(--surface-muted)}p{font-size:12px;line-height:1.7;color:var(--muted);margin:6px 0}.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}.toolbar input{flex:1;min-width:180px}input:not([type=checkbox]){padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface)}input:focus{outline:2px solid var(--accent);outline-offset:2px}.primary,.secondary{padding:9px 13px;border-radius:10px;font-size:13px;font-weight:650;white-space:nowrap}.primary{background:var(--accent);color:white}.secondary{background:var(--surface);border:1px solid var(--border)}button:disabled{opacity:.4;cursor:not-allowed}.grid-wrap{overflow:auto;max-height:420px;border:1px solid var(--border);border-radius:12px}.grid-wrap>p{padding:28px;text-align:center}table{width:100%;font-size:13px;text-align:left}th{background:var(--surface-muted);position:sticky;top:0;white-space:nowrap;font-weight:650}th,td{padding:12px;border-bottom:1px solid var(--border)}td{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.null,small{font-size:11px;color:var(--muted)}th small{margin-left:6px}.actions{display:flex;gap:12px;color:var(--accent)}.failure{padding:12px;border-radius:10px;background:#fff1f2;color:#be123c}.success{color:#047857}.warning{background:#fffbeb;color:#92400e;padding:12px;border-radius:10px}.edit-dialog{padding:0;width:min(560px,calc(100vw - 32px));max-height:85dvh;border:1px solid var(--border);border-radius:16px;background:var(--surface);color:var(--text)}.edit-dialog::backdrop{background:#11182766}.edit-dialog form{display:flex;flex-direction:column;max-height:85dvh}header,footer{padding:18px 22px;display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border)}h3{font-size:18px;font-weight:700}.edit-body{padding:8px 22px 20px;overflow:auto}footer{border-top:1px solid var(--border);border-bottom:0;justify-content:flex-end}.field{display:block;margin-top:16px;font-size:13px;font-weight:600}.field>input{display:block;width:100%;margin-top:6px}.field small{display:block;font-weight:400}.null-toggle{display:flex;gap:6px;margin-top:5px;font-size:12px;font-weight:400;color:var(--muted)}
</style>
