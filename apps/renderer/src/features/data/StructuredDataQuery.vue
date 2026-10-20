<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { structuredDataQuerySchema, type DataQueryPredicate, type StructuredDataQuery, type StructuredDataQueryResult } from '@openclawx/contracts';
import type { DataSource, DataTable } from '../../services/api';
import { liveDataRequest } from '../../services/live-data';

const props = defineProps<{ source: DataSource; table: DataTable }>();
const isCopy = computed(() => props.source.accessMode === 'snapshot' || Boolean(props.source.databaseConnection) || props.source.fileType === 'API');
type FilterDraft = { key: number; fieldId: string; operator: DataQueryPredicate['operator']; value: string; end: string };
const mode = ref<'detail' | 'aggregate'>('detail');
const fields = ref<string[]>(props.table.columns.map(c => c.id));
const filters = ref<FilterDraft[]>([]), logic = ref<'and' | 'or'>('and');
const group = ref(''), grain = ref<'' | 'year' | 'month' | 'day'>('');
const operation = ref<'count' | 'sum' | 'avg' | 'min' | 'max' | 'countDistinct'>('count');
const metricField = ref(''), sortField = ref(''), direction = ref<'asc' | 'desc'>('asc'), limit = ref(50);
const result = ref<StructuredDataQueryResult | null>(null), busy = ref(false), error = ref('');
let nextKey = 0, controller: AbortController | undefined;
const isDateGroup = computed(() => props.table.columns.find(c => c.id === group.value)?.type === '日期');
const metricColumns = computed(() => props.table.columns.filter(c => !['sum', 'avg'].includes(operation.value) || ['整数', '小数'].includes(c.type)).filter(c => !['min', 'max'].includes(operation.value) || c.type !== '布尔值'));
const outputOptions = computed(() => mode.value === 'detail' ? props.table.columns.filter(c => fields.value.includes(c.id)) : [...(group.value ? props.table.columns.filter(c => c.id === group.value) : []), { id: 'metric_1', name: '统计值' }]);
const operators: Array<{ id: DataQueryPredicate['operator']; label: string }> = [
  { id: 'eq', label: '等于' }, { id: 'ne', label: '不等于' }, { id: 'gt', label: '大于' }, { id: 'gte', label: '大于等于' }, { id: 'lt', label: '小于' }, { id: 'lte', label: '小于等于' },
  { id: 'contains', label: '包含文字' }, { id: 'startsWith', label: '以文字开头' }, { id: 'between', label: '范围' }, { id: 'in', label: '属于集合' }, { id: 'notIn', label: '不属于集合' }, { id: 'isNull', label: '为空' }, { id: 'isNotNull', label: '不为空' },
];
function availableOperators(fieldId: string) {
  const type = props.table.columns.find(c => c.id === fieldId)?.type;
  return operators.filter(o => type === '文本' || !['contains', 'startsWith'].includes(o.id)).filter(o => type !== '布尔值' || ['eq', 'ne', 'in', 'notIn', 'isNull', 'isNotNull'].includes(o.id));
}
function addFilter() { filters.value.push({ key: ++nextKey, fieldId: props.table.columns[0]?.id || '', operator: 'eq', value: '', end: '' }); }
function filterValue(f: FilterDraft): DataQueryPredicate {
  if (f.operator === 'isNull' || f.operator === 'isNotNull') return { fieldId: f.fieldId, operator: f.operator };
  if (f.operator === 'between') return { fieldId: f.fieldId, operator: f.operator, values: [f.value, f.end] };
  if (f.operator === 'in' || f.operator === 'notIn') return { fieldId: f.fieldId, operator: f.operator, values: f.value.split(/[,，]/).map(v => v.trim()).filter(Boolean) };
  return { fieldId: f.fieldId, operator: f.operator, value: f.value };
}
function draft(offset = 0): StructuredDataQuery {
  return structuredDataQuerySchema.parse({ sourceId: props.source.id, tableId: props.table.id,
    ...(mode.value === 'detail' ? { fields: fields.value } : {
      dimensions: group.value ? [{ fieldId: group.value, ...(isDateGroup.value && grain.value ? { grain: grain.value } : {}) }] : [],
      metrics: [{ operation: operation.value, alias: 'metric_1', ...(metricField.value ? { fieldId: metricField.value } : {}) }],
    }),
    ...(filters.value.length ? { filters: { logic: logic.value, conditions: filters.value.map(filterValue) } } : {}),
    orderBy: sortField.value ? [{ fieldId: sortField.value, direction: direction.value }] : [], limit: limit.value, offset,
  }) as StructuredDataQuery;
}
watch([mode, fields, filters, logic, group, grain, operation, metricField, sortField, direction, limit], () => { result.value = null; error.value = ''; }, { deep: true });
watch(mode, () => { sortField.value = ''; });
watch(operation, () => { if (metricField.value && !metricColumns.value.some(c => c.id === metricField.value)) metricField.value = ''; });
watch(group, () => { grain.value = ''; if (sortField.value !== 'metric_1') sortField.value = ''; });
watch(fields, () => { if (!fields.value.includes(sortField.value)) sortField.value = ''; });
async function run(offset = 0) {
  if (busy.value) return;
  error.value = ''; result.value = null;
  let input: StructuredDataQuery;
  try { input = draft(offset); }
  catch { error.value = '请至少选择一个返回字段；统计时选择指标字段，集合条件请填写逗号分隔的值。'; return; }
  busy.value = true; controller = new AbortController();
  try { result.value = await liveDataRequest<StructuredDataQueryResult>('/gateway/query', 'POST', input, controller.signal); }
  catch (cause) { if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '查询失败，请检查条件后重试。'; }
  finally { busy.value = false; }
}
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <div class="query-panel">
    <div class="query-intro"><div><h3>查询分析</h3><p>无需 SQL 或 AI，直接筛选明细或统计整张表。仅查询，不修改数据。</p></div><span class="query-badge">{{ source.accessMode === 'live' ? '实时原库' : isCopy ? '本地副本' : '本地数据' }}</span></div>
    <p v-if="isCopy && source.accessMode !== 'live'" class="query-copy-hint">查询与统计仅涵盖当前已导入或同步的数据；若副本有截断，不代表原库全量。</p>
    <form @submit.prevent="run()">
      <fieldset :disabled="busy" class="query-settings">
        <div class="query-mode"><button type="button" :aria-pressed="mode === 'detail'" @click="mode = 'detail'">明细查询</button><button type="button" :aria-pressed="mode === 'aggregate'" @click="mode = 'aggregate'">统计汇总</button></div>
        <details v-if="mode === 'detail'" class="query-fields"><summary>返回字段 · 已选 {{ fields.length }} / {{ table.columns.length }}</summary><div><label v-for="column in table.columns" :key="column.id"><input v-model="fields" type="checkbox" :value="column.id">{{ column.name }}</label></div></details>
        <div v-else class="query-grid">
          <label>分组字段<select v-model="group"><option value="">不分组 · 全部汇总</option><option v-for="column in table.columns" :key="column.id" :value="column.id">{{ column.name }}</option></select></label>
          <label v-if="isDateGroup">日期粒度<select v-model="grain"><option value="">原始日期值</option><option value="year">按年</option><option value="month">按月</option><option value="day">按日</option></select></label>
          <label>统计方式<select v-model="operation"><option value="count">计数</option><option value="sum">求和</option><option value="avg">平均值</option><option value="min">最小值</option><option value="max">最大值</option><option value="countDistinct">去重计数</option></select></label>
          <label>统计字段<select v-model="metricField" :required="operation !== 'count'"><option value="">{{ operation === 'count' ? '全部记录' : '请选择字段' }}</option><option v-for="column in metricColumns" :key="column.id" :value="column.id">{{ column.name }}</option></select></label>
        </div>
        <div class="query-filter-title"><b>筛选条件 <span v-if="!filters.length">（可选）</span></b><select v-if="filters.length > 1" v-model="logic" aria-label="条件组合"><option value="and">满足全部条件</option><option value="or">满足任一条件</option></select><button type="button" :disabled="filters.length >= 10" @click="addFilter">＋ 添加条件</button></div>
        <div v-for="(filter, index) in filters" :key="filter.key" class="query-filter-row">
          <select v-model="filter.fieldId" :aria-label="`条件 ${index + 1} 字段`" @change="filter.operator = 'eq'"><option v-for="column in table.columns" :key="column.id" :value="column.id">{{ column.name }}</option></select>
          <select v-model="filter.operator" :aria-label="`条件 ${index + 1} 操作`"><option v-for="op in availableOperators(filter.fieldId)" :key="op.id" :value="op.id">{{ op.label }}</option></select>
          <div v-if="!['isNull', 'isNotNull'].includes(filter.operator)" class="query-filter-values"><input v-model="filter.value" :aria-label="`条件 ${index + 1} 值`" :placeholder="['in', 'notIn'].includes(filter.operator) ? '多个值用逗号分隔' : '值；日期用 2026-09-01'"><input v-if="filter.operator === 'between'" v-model="filter.end" :aria-label="`条件 ${index + 1} 结束值`" placeholder="结束值"></div><span v-else class="query-filter-values query-hint">无需填写值</span>
          <button type="button" :aria-label="`移除条件 ${index + 1}`" @click="filters.splice(index, 1)">移除</button>
        </div>
        <div class="query-grid query-sort"><label>排序字段<select v-model="sortField"><option value="">默认顺序</option><option v-for="column in outputOptions" :key="column.id" :value="column.id">{{ column.name }}</option></select></label><label v-if="sortField">顺序<select v-model="direction"><option value="asc">升序</option><option value="desc">降序</option></select></label><label>每页条数<select v-model.number="limit"><option :value="20">20</option><option :value="50">50</option><option :value="100">100</option><option :value="200">200</option></select></label></div>
        <div class="query-actions"><span class="query-hint">{{ mode === 'aggregate' ? '统计覆盖全部匹配记录，不受每页条数限制。' : '修改条件后请重新查询，分页期间数据变化可能影响结果。' }}</span><button type="submit" class="query-primary">{{ busy ? '查询中…' : '执行查询' }}</button></div>
      </fieldset>
    </form>
    <p v-if="busy" role="status" class="query-feedback">正在通过数据网关查询，请稍候…</p>
    <p v-else-if="error" role="alert" class="query-error">{{ error }}</p>
    <div v-else-if="result" class="query-result">
      <div class="query-result-title" role="status"><b>查询成功 · 本页 {{ result.rows.length }} 条</b><span>{{ new Date(result.queriedAt).toLocaleTimeString() }} · {{ result.storageMode === 'live' ? '原库实时结果' : '本地数据结果' }}</span></div>
      <div class="query-table"><table><thead><tr><th v-for="field in result.fields" :key="field.id">{{ field.id === 'metric_1' ? '统计值' : field.name }}</th></tr></thead><tbody><tr v-for="(row, index) in result.rows" :key="index"><td v-for="field in result.fields" :key="field.id">{{ row[field.id] === null ? '—' : row[field.id] }}</td></tr></tbody></table><p v-if="!result.rows.length" class="query-feedback">没有匹配记录。请调整筛选条件后重试。</p></div>
      <div class="query-pagination"><span>第 {{ Math.floor(result.offset / result.limit) + 1 }} 页{{ result.hasMore ? ' · 后面还有结果' : '' }}{{ result.hasMore && result.nextOffset === null ? ' · 已到分页上限，请缩小范围' : '' }}</span><button type="button" :disabled="busy || result.offset === 0" @click="run(Math.max(0, result.offset - result.limit))">上一页</button><button type="button" :disabled="busy || result.nextOffset === null" @click="run(result.nextOffset!)">下一页</button></div>
      <p v-if="result.storageMode !== 'live' && mode === 'aggregate'" class="query-hint">本地统计使用 SQLite 原生数值精度；高精度财务核算请核对原库口径。</p>
    </div>
    <p v-else class="query-feedback">设置条件后点击“执行查询”，结果会显示在这里。</p>
  </div>
</template>

<style scoped>
.query-panel{margin-top:20px;border:1px solid var(--border);border-radius:16px;background:var(--surface);padding:20px;font-size:13px}
.query-intro,.query-filter-title,.query-actions,.query-result-title,.query-pagination{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:space-between}
.query-intro h3{font-weight:700;font-size:15px}.query-intro p,.query-hint,.query-result-title span,.query-pagination span{color:var(--muted);font-size:12px;line-height:1.6}.query-intro p{margin-top:6px}
.query-badge{border-radius:20px;background:var(--accent-soft);color:var(--accent);font-size:11px;padding:5px 10px;white-space:nowrap}
.query-copy-hint{margin-top:12px;padding:10px 12px;border-radius:8px;background:var(--surface-muted);font-size:12px;color:var(--muted);line-height:1.6}
.query-settings{border:0;min-width:0;padding:0;margin:18px 0 0}.query-settings:disabled{opacity:.65}
.query-mode{display:inline-flex;background:var(--surface-muted);padding:4px;border-radius:10px;margin-bottom:16px}.query-mode button{border:0;background:transparent}.query-mode button[aria-pressed=true]{background:var(--surface);color:var(--accent);box-shadow:0 1px 4px #00000012}
button,select,input:not([type=checkbox]){border:1px solid var(--border);border-radius:8px;background:var(--surface);padding:8px 10px;font:inherit;color:inherit;min-height:36px;max-width:100%}button{font-weight:600;cursor:pointer;white-space:nowrap}button:disabled{opacity:.45;cursor:default}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.query-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px}.query-grid label{display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:12px}.query-grid select{width:100%;color:var(--text)}
.query-fields{margin-bottom:14px}.query-fields summary{cursor:pointer;color:var(--muted)}.query-fields>div{display:flex;flex-wrap:wrap;gap:10px 18px;padding:12px 0}.query-fields label{display:flex;align-items:center;gap:6px}
.query-filter-title{margin:16px 0 10px;justify-content:flex-start}.query-filter-title b{margin-right:auto;font-weight:600}.query-filter-title span{font-weight:400;color:var(--muted)}
.query-filter-row{display:grid;grid-template-columns:minmax(100px,1fr) minmax(100px,1fr) minmax(150px,2fr) auto;gap:8px;margin:8px 0}.query-filter-values{display:flex;gap:8px;min-width:0;align-items:center}.query-filter-values input{width:100%;min-width:0}
.query-sort{padding-top:16px;margin-top:16px;border-top:1px solid var(--border)}.query-actions{margin-top:18px}.query-primary{background:var(--accent);color:white;border-color:var(--accent);padding:9px 20px;margin-left:auto}
.query-feedback{color:var(--muted);padding:24px 8px;text-align:center;line-height:1.6}.query-error{margin-top:18px;background:#fff1f2;color:#be123c;border-radius:10px;padding:14px;line-height:1.7}
.query-result{margin-top:20px;padding-top:16px;border-top:1px solid var(--border)}.query-result-title b{color:var(--accent);font-weight:600}.query-table{overflow:auto;border:1px solid var(--border);border-radius:10px;margin:12px 0}.query-table table{width:100%;text-align:left;white-space:nowrap}.query-table th,.query-table td{padding:10px 14px;border-bottom:1px solid var(--border);max-width:360px;overflow:hidden;text-overflow:ellipsis}.query-table th{font-weight:600;background:var(--surface-muted)}.query-table tr:last-child td{border-bottom:0}.query-pagination{justify-content:flex-end}.query-pagination span{margin-right:auto}.query-result>.query-hint{margin-top:12px}
@media(max-width:700px){.query-panel{padding:14px}.query-filter-row{grid-template-columns:1fr 1fr}.query-filter-values{grid-column:1 / -1}.query-filter-row>button{grid-column:2;justify-self:end}.query-grid{grid-template-columns:1fr 1fr}.query-actions{align-items:stretch}.query-actions>.query-hint{width:100%}}
</style>
