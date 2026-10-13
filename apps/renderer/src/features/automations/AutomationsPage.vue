<script setup lang="ts">
import {ref} from 'vue';
import type {Employee, Conversation} from '../../app/workspace';
import type {ProviderConfig} from '../../app/model-config';
import type {Automation, AutomationRunTranscript} from '../../app/automations';
import TaskTemplateManager from './TaskTemplateManager.vue';
import TemplateTasksPanel from './TemplateTasksPanel.vue';
import TaskRunRecords from './TaskRunRecords.vue';

const props=defineProps<{
  employees:Employee[];
  models:ProviderConfig[];
  conversations:Conversation[];
  runAutomation:(item:Automation)=>Promise<AutomationRunTranscript|undefined>;
  openConversation:(id:string)=>void;
  returnDefinitionId?:string;
  returnProjectId?:string;
}>();
const emit=defineEmits<{'open-project':[id:string,definitionId:string]}>();
const tab=ref<'templates'|'configure'|'records'>(props.returnDefinitionId?'configure':'templates');
</script>

<template>
  <section class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col px-6 py-10 sm:px-12">
      <header class="shrink-0">
        <p class="text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">WORKMATE / TASKS</p>
        <h1 class="mt-2 text-3xl font-bold tracking-tight">任务中心</h1>
        <p class="mt-3 text-sm text-[var(--muted)]">创建并安排任务，在运行记录中查看进度与成果。</p>
        <nav class="mt-6 inline-flex rounded-xl bg-[var(--surface-muted)] p-1" aria-label="任务中心导航">
          <button v-for="item in [{id:'templates',label:'任务管理'},{id:'records',label:'任务运行记录'}] as const" :key="item.id" type="button" :aria-current="tab===item.id||(tab==='configure'&&item.id==='templates')?'page':undefined" :class="['rounded-lg px-4 py-2 text-sm font-semibold',(tab===item.id||(tab==='configure'&&item.id==='templates'))?'bg-[var(--surface)] shadow-sm':'text-[var(--muted)]']" @click="tab=item.id">{{item.label}}</button>
        </nav>
      </header>
      <div class="mt-6 min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <TemplateTasksPanel v-if="tab==='templates'" :employees="employees" @manage-templates="tab='configure'" @open-conversation="openConversation" />
        <div v-else-if="tab==='configure'"><div class="template-return-bar"><button type="button" class="template-return" @click="tab='templates'">← 返回任务管理</button><span>模板管理</span></div><TaskTemplateManager :employees="employees" :return-definition-id="returnDefinitionId" :return-project-id="returnProjectId" @open-project="(id,definitionId)=>emit('open-project',id,definitionId)" /></div>
        <TaskRunRecords v-else @open-conversation="openConversation" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.template-return-bar{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:16px;padding:12px 0 16px;background:var(--background,#f8f9fc);border-bottom:1px solid var(--border);margin-bottom:16px}
.template-return{display:inline-flex;align-items:center;min-height:44px;padding:10px 18px;border:1px solid var(--accent);border-radius:10px;background:var(--accent-soft);color:var(--accent);font-size:14px;font-weight:700;white-space:nowrap;cursor:pointer}
.template-return:hover{background:var(--accent);color:white}.template-return:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.template-return-bar span{font-size:13px;color:var(--muted)}
</style>
