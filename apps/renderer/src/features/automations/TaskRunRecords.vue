<script setup lang="ts">
import {ref,onMounted} from 'vue';
import type {TaskRunListItem} from '@workmate/contracts';
import {templateTasksApi as api} from '../../services/template-tasks';
import TaskRunMonitor from './TaskRunMonitor.vue';
const emit=defineEmits<{'open-conversation':[id:string]}>();
const records=ref<TaskRunListItem[]>([]),selected=ref<TaskRunListItem|null>(null),error=ref(''),busy=ref(false),query=ref(''),status=ref('');
const offset=ref(0),total=ref(0),nextOffset=ref<number|null>(null);
function selectRecord(item:TaskRunListItem){selected.value=item;}
const date=(time:number)=>new Date(time).toLocaleString('zh-CN');
const label=(value:string)=>({completed:'已完成',failed:'失败',running:'运行中'}[value]??value);
async function reload(){busy.value=true;error.value='';try{const page=await api.runs({offset:String(offset.value),limit:'30',...(status.value?{status:status.value}:{}),...(query.value?{search:query.value}:{})});records.value=page.records;total.value=page.total;nextOffset.value=page.nextOffset;}catch(cause){error.value=cause instanceof Error?cause.message:'读取记录失败';}finally{busy.value=false;}}
function search(){offset.value=0;void reload();}
function paginate(next:number){offset.value=next;void reload();}
onMounted(reload);
</script>
<template>
  <section class="records"><header><div><h2>任务运行记录</h2><p>每次运行独立保存输入、状态与 json-result；历史结果不会被后续任务修改覆盖。</p></div><button :disabled="busy" @click="reload">刷新</button></header>
    <p v-if="error" role="alert">{{error}}</p><p v-if="busy" role="status">正在读取运行记录…</p>
    <div class="filters"><input v-model="query" maxlength="120" aria-label="搜索运行任务" placeholder="搜索任务名称" @keydown.enter="search"><select v-model="status" aria-label="运行状态" @change="search"><option value="">全部状态</option><option value="completed">已完成</option><option value="failed">失败</option><option value="running">运行中</option></select><button :disabled="busy" @click="search">查询</button></div>
    <p v-if="!records.length&&!busy" class="empty">暂无匹配的运行记录。先在任务管理中创建并运行任务。</p>
    <button v-for="item in records" :key="`${item.taskId}:${item.run.id}`" class="run-card" @click="selectRecord(item)"><strong>{{item.taskName}}</strong><span>{{item.mode==='direct'?'直接创建':'应用任务'}} · {{item.run.trigger==='scheduled'?'自动触发':'手动触发'}} · {{date(item.run.startedAt)}} · {{label(item.run.status)}}</span><small>{{item.run.error||'查看监控 · 报告与 result-json →'}}</small></button>
    <div class="filters"><span>共 {{total}} 条 · 第 {{Math.floor(offset/30)+1}} 页</span><button :disabled="busy||offset===0" @click="paginate(Math.max(0,offset-30))">上一页</button><button :disabled="busy||nextOffset===null" @click="paginate(nextOffset!)">下一页</button></div>
    <TaskRunMonitor v-if="selected" :key="`${selected.taskId}:${selected.run.id}`" :task-id="selected.taskId" :run-id="selected.run.id" :task-name="selected.taskName" @close="selected=null" @open-conversation="id=>emit('open-conversation',id)" />
  </section>
</template>
<style scoped>
.records{font-size:14px}header,.filters{display:flex;gap:12px;align-items:center;flex-wrap:wrap}header>div{flex:1;min-width:0}h2{font-size:20px;font-weight:700}h3{font-weight:700}p,span,small{color:var(--muted);line-height:1.7;margin:8px 0}button,input,select{font:inherit;background:var(--surface);color:var(--text);border:1px solid var(--border);padding:10px 14px;border-radius:10px;min-width:0}button{cursor:pointer}button:disabled{opacity:.5}.filters{margin:18px 0}.filters input{flex:1}.run-card{display:grid;gap:5px;text-align:left;width:100%;margin:10px 0;padding:18px}.run-card span,.run-card small{margin:0;font-size:12px}.run-card:hover{border-color:var(--accent)}.detail{margin-top:22px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px}.detail p{overflow-wrap:anywhere}pre{overflow:auto;max-height:60vh;border-radius:10px;padding:16px;background:var(--surface-muted);font-size:12px}.empty{text-align:center;padding:30px}
</style>
