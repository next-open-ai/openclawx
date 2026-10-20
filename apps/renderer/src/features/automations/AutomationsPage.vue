<script setup lang="ts">
import {ref,onMounted} from 'vue';
import type {Employee, Conversation} from '../../app/workspace';
import type {ProviderConfig} from '../../app/model-config';
import type {Automation, AutomationRunTranscript} from '../../app/automations';
import TemplateTasksPanel from './TemplateTasksPanel.vue';
import TaskRunRecords from './TaskRunRecords.vue';
import TaskApplicationsPanel from './TaskApplicationsPanel.vue';
import {templateTasksApi} from '../../services/template-tasks';

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
const tab=ref<'applications'|'tasks'|'records'>('applications');
onMounted(async()=>{if(props.returnDefinitionId){try{const {definition}=await templateTasksApi.definition(props.returnDefinitionId);tab.value=definition.draft.application?'applications':'tasks';}catch{tab.value='tasks';}}});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col px-6 py-10 sm:px-12">
      <header class="shrink-0">
        <p class="text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">OPENCLAWX / TASKS</p>
        <h1 class="mt-2 text-3xl font-bold tracking-tight">任务中心</h1>
        <p class="mt-3 text-sm text-[var(--muted)]">创建并安排任务，在运行记录中查看进度与成果。</p>
        <nav class="mt-6 inline-flex rounded-xl bg-[var(--surface-muted)] p-1" aria-label="任务中心导航">
          <button v-for="item in [{id:'applications',label:'任务应用'},{id:'tasks',label:'任务管理'},{id:'records',label:'任务运行记录'}] as const" :key="item.id" type="button" :aria-current="tab===item.id?'page':undefined" :class="['rounded-lg px-4 py-2 text-sm font-semibold',tab===item.id?'bg-[var(--surface)] shadow-sm':'text-[var(--muted)]']" @click="tab=item.id">{{item.label}}</button>
        </nav>
      </header>
      <div class="mt-6 min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <TaskApplicationsPanel v-if="tab==='applications'" :employees="employees" :return-definition-id="returnDefinitionId" @open-project="(id,definitionId)=>emit('open-project',id,definitionId)" @open-conversation="openConversation" />
        <TemplateTasksPanel v-else-if="tab==='tasks'" :employees="employees" @open-conversation="openConversation" />
        <TaskRunRecords v-else @open-conversation="openConversation" />
      </div>
    </div>
  </section>
</template>
