<script setup lang="ts">
import { ref } from 'vue';
import { dataObjectAnnotationsSchema, type DataObjectAnnotations } from '@openclawx/contracts';
const props = defineProps<{ annotations: DataObjectAnnotations; api: boolean; busy: boolean; saveError: string }>();
const emit = defineEmits<{ save: [value: DataObjectAnnotations]; close: [] }>();
const draft = ref<DataObjectAnnotations>(JSON.parse(JSON.stringify(props.annotations)));
const error = ref('');
function save() {
  const result = dataObjectAnnotationsSchema.safeParse(draft.value);
  if (!result.success) { error.value = result.error.issues[0]?.message || '请检查说明内容。'; return; }
  error.value = ''; emit('save', result.data);
}
</script>

<template>
  <div class="absolute inset-0 z-30 grid place-items-center bg-slate-950/35 p-4">
    <form class="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="object-editor-title" @submit.prevent="save">
      <div class="flex items-center justify-between gap-3"><h2 id="object-editor-title" class="text-xl font-bold">编辑数据对象说明</h2><button type="button" :disabled="busy" aria-label="关闭编辑" @click="emit('close')">×</button></div>
      <p class="mt-2 text-sm text-[var(--muted)]">说明会提供给 AI 理解数据；保存后立即使用最新内容，不改变原文件与连接凭据。请勿填写密钥或个人隐私。</p>
      <label class="mt-5 block"><span class="mb-2 block text-sm font-semibold">业务说明</span><textarea v-model="draft.description" rows="3" maxlength="4000" placeholder="这份数据包含什么，适合解决什么问题？例如：已支付订单，不含退款订单。" class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm" /></label>
      <label class="mt-4 block"><span class="mb-2 block text-sm font-semibold">数据来源与连接说明</span><textarea v-model="draft.connectionDescription" rows="3" maxlength="4000" placeholder="来源、更新方式、时效与使用限制；不填写账号或密钥。" class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm" /></label>
      <template v-if="api">
        <label class="mt-4 block"><span class="mb-2 block text-sm font-semibold">接口 URL 说明</span><textarea v-model="draft.apiUrlDescription" rows="2" maxlength="2000" placeholder="接口用途、路径含义、分页或错误处理规则。" class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm" /></label>
        <div class="mt-5 flex items-center justify-between"><h3 class="font-semibold">入参 / 返参标注</h3><button type="button" :disabled="draft.apiFields.length >= 300" class="text-sm font-semibold text-[var(--accent)] disabled:opacity-50" @click="draft.apiFields.push({ path: '', location: 'query', type: 'string', required: false, description: '' })">添加字段</button></div>
        <p class="mt-1 text-xs text-[var(--muted)]">嵌套路径示例：data.items[].amount。这里只描述结构，实际请求参数在连接配置中设置。</p>
        <div v-for="(field, index) in draft.apiFields" :key="index" class="mt-3 grid gap-2 rounded-lg border border-[var(--border)] p-3 sm:grid-cols-[110px_minmax(0,1fr)_100px_65px_40px]">
          <select v-model="field.location" :aria-label="`字段 ${index + 1} 位置`" class="min-w-0 rounded border border-[var(--border)] bg-[var(--surface-muted)] p-2 text-xs"><option value="query">查询参数</option><option value="path">路径参数</option><option value="header">请求头</option><option value="body">请求体</option><option value="response">返回字段</option></select>
          <input v-model="field.path" :aria-label="`字段 ${index + 1} 路径`" required maxlength="300" placeholder="字段路径" class="min-w-0 rounded border border-[var(--border)] bg-[var(--surface-muted)] p-2 text-xs" />
          <select v-model="field.type" :aria-label="`字段 ${index + 1} 类型`" class="min-w-0 rounded border border-[var(--border)] bg-[var(--surface-muted)] p-2 text-xs"><option v-for="type in ['string', 'number', 'integer', 'boolean', 'object', 'array']" :key="type">{{ type }}</option></select>
          <label class="flex items-center gap-1 text-xs"><input v-model="field.required" type="checkbox" />必填</label>
          <button type="button" :aria-label="`删除字段 ${index + 1}`" class="text-xs text-[var(--muted)]" @click="draft.apiFields.splice(index, 1)">删除</button>
          <input v-model="field.description" maxlength="1000" :aria-label="`字段 ${index + 1} 说明`" placeholder="字段含义、单位、枚举或约束" class="min-w-0 rounded border border-[var(--border)] bg-[var(--surface-muted)] p-2 text-xs sm:col-span-5" />
        </div>
        <p v-if="!draft.apiFields.length" class="mt-3 rounded-lg bg-[var(--surface-muted)] p-3 text-xs text-[var(--muted)]">还没有参数标注，可以先保存对象说明，再逐步补充。</p>
      </template>
      <p v-if="error || saveError" role="alert" class="mt-4 text-sm text-rose-600">{{ error || saveError }}</p>
      <div class="mt-6 flex justify-end gap-2"><button type="button" :disabled="busy" class="rounded-lg border border-[var(--border)] px-4 py-2 text-sm" @click="emit('close')">取消</button><button type="submit" :disabled="busy" class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{{ busy ? '保存中…' : '保存说明' }}</button></div>
    </form>
  </div>
</template>
