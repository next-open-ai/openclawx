<script setup lang="ts">
import {onMounted,ref} from 'vue';
import type {ExperienceSettingsState} from '@openclawx/contracts';
import {getStoredSessionToken} from '../../services/auth';
import {useKnowledgeConfig} from '../../app/kb-config';
const {bases,load}=useKnowledgeConfig();
const state=ref<ExperienceSettingsState>({enabled:true,knowledgeBaseId:null,available:false}),busy=ref(false),error=ref(''),dirty=ref(false);
async function request(method='GET',suffix='',body?:unknown){
  const base=window.location.protocol==='file:'?'http://127.0.0.1:47832':'';
  const response=await fetch(base+'/api/experience/settings'+suffix,{method,headers:{'content-type':'application/json','x-openclawx-session':getStoredSessionToken()||''},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
  const data=await response.json();if(!response.ok)throw Error(data.message||'经验设置操作失败');return data as ExperienceSettingsState;
}
async function save(test=false){busy.value=true;error.value='';try{state.value=await request('PUT','',{enabled:state.value.enabled,knowledgeBaseId:state.value.knowledgeBaseId});dirty.value=false;if(test)state.value=await request('POST','/test');}catch(cause){error.value=cause instanceof Error?cause.message:'操作失败';}finally{busy.value=false;}}
onMounted(async()=>{try{await Promise.all([load(),request().then(value=>state.value=value)]);}catch(cause){error.value=cause instanceof Error?cause.message:'读取设置失败';}});
</script>
<template>
  <section class="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
    <h3 class="text-sm font-bold">智能体经验 · 本地优先</h3>
    <p class="mt-2 text-xs leading-6 text-[var(--muted)]">保存与加载不依赖 Embedding 才启用。先保存本地 SQLite 与 JSON 副本；知识库同步和语义预取在后台进行，不等待服务超时来判断可用性。本地文本匹配不是语义检索。</p>
    <p class="mt-2 rounded-lg bg-amber-500/10 p-3 text-xs leading-5 text-amber-700">当前使用组织内共享经验池，加载不区分用户或智能体，仍保留组织边界；每条经验记录来源。只保存可共享的方法和踩坑经验，不保存凭据、私人信息或业务明细。</p>
    <label class="mt-3 flex items-center gap-2 text-sm"><input v-model="state.enabled" type="checkbox" :disabled="busy" @change="state.available=false;dirty=true" />启用经验保存与加载</label>
    <label class="mt-3 block text-xs">固定系统经验知识库（可选，建议专用库）
      <select v-model="state.knowledgeBaseId" :disabled="busy" class="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2" @change="state.available=false;dirty=true">
        <option :value="null">仅本地，不同步知识库</option>
        <option v-for="kb in bases.filter(b=>b.enabled && ['lancedb','bailian'].includes(b.provider))" :key="kb.id" :value="kb.id">{{ kb.name }} · {{ kb.provider }}</option>
      </select>
    </label>
    <div class="mt-3 flex flex-wrap items-center gap-3 text-xs">
      <button :disabled="busy" class="rounded-lg border border-[var(--border)] px-3 py-2 disabled:opacity-50" @click="save()">保存设置</button>
      <button :disabled="busy || !state.enabled || !state.knowledgeBaseId" class="rounded-lg bg-[var(--accent)] px-3 py-2 text-white disabled:opacity-50" @click="save(true)">保存并验证知识库</button>
      <span role="status">{{ busy ? '正在处理配置…' : dirty ? '修改尚未保存' : !state.enabled ? '经验功能已关闭' : state.available ? '知识库可用 · 后台同步' : '仅本地 · 不调用知识库' }}</span>
    </div>
    <p v-if="state.message" class="mt-2 text-xs text-[var(--muted)]">{{ state.message }}</p>
    <p v-if="error" role="alert" class="mt-2 text-xs text-rose-600">{{ error }}</p>
  </section>
</template>
