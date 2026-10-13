<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ProjectInstruction } from '@workmate/contracts';
import DocumentAttachments from '../chat/DocumentAttachments.vue';
import VoiceInputDialog from '../chat/VoiceInputDialog.vue';
import { uploadProjectDocument } from '../../services/orchestration';

const props = defineProps<{
  projectId: string; running: boolean; managed: boolean; preferredEmployeeId?: string; conversation?: boolean;
  members: Array<{ id: string; name: string }>;
  submit: (input: ProjectInstruction) => Promise<void>;
}>();
const emit = defineEmits<{ cancel: [] }>();
const draft = ref(''); const selectedId = ref(''); const sending = ref(false); const error = ref('');
const requestId = ref(crypto.randomUUID()); const fileIds = ref<string[]>([]);
const documentsOpen = ref(false); const uploading = ref(false); const documentsValid = ref(true);
const documents = ref<InstanceType<typeof DocumentAttachments>>();
const voiceOpen = ref(false); const textarea = ref<HTMLTextAreaElement>();
const mentionOpen = ref(false); const mentionIndex = ref(0);
const busy = computed(() => props.running || sending.value || uploading.value);
watch(() => props.members.map(member => member.id).join(','), () => {
  if (!props.members.some(member => member.id === selectedId.value)) {
    selectedId.value = props.members.find(member => member.id === props.preferredEmployeeId)?.id ?? props.members.at(-1)?.id ?? '';
  }
}, { immediate: true });
const selected = computed(() => props.members.find(member => member.id === selectedId.value));
const mentions = computed(() => {
  const query = draft.value.match(/@([^\s]*)$/)?.[1]?.toLowerCase() ?? '';
  return props.members.filter(member => member.name.toLowerCase().includes(query) || member.id.toLowerCase().includes(query));
});
const canSend = computed(() => !busy.value && !voiceOpen.value && !!selected.value && documentsValid.value && (!!draft.value.trim() || fileIds.value.length > 0));
function input() { mentionOpen.value = /@[^\s]*$/.test(draft.value); mentionIndex.value = 0; }
function mention(member: { id: string; name: string }) {
  selectedId.value = member.id; draft.value = draft.value.replace(/@[^\s]*$/, ''); mentionOpen.value = false;
  textarea.value?.focus();
}
async function send() {
  if (!canSend.value) return;
  sending.value = true; error.value = '';
  try {
    await props.submit({ employeeId: selectedId.value, content: draft.value.trim() || '请阅读本次参考文档并继续当前项目。', requestId: requestId.value, fileIds: [...fileIds.value] });
    draft.value = ''; fileIds.value = []; requestId.value = crypto.randomUUID(); documentsOpen.value = false; mentionOpen.value = false; documentsValid.value = true;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '发送失败，请重试；输入内容已保留。'; }
  finally { sending.value = false; }
}
function keydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (mentionOpen.value && mentions.value.length) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); mentionIndex.value = (mentionIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + mentions.value.length) % mentions.value.length; return; }
    if (event.key === 'Enter') { event.preventDefault(); mention(mentions.value[mentionIndex.value] ?? mentions.value[0]); return; }
  }
  if (event.key === 'Escape') { mentionOpen.value = false; return; }
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
}
async function addFiles(files: File[]) {
  if (!files.length || busy.value) return;
  if (!props.managed) { error.value = '此项目暂不支持参考文档上传，请使用文字或语音输入。'; return; }
  documentsOpen.value = true; await nextTick(); await documents.value?.addFiles(files);
}
async function openDocuments() { documentsOpen.value = true; await nextTick(); documents.value?.openPicker(); }
function drop(event: DragEvent) { event.preventDefault(); void addFiles(Array.from(event.dataTransfer?.files ?? [])); }
function paste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length) { event.preventDefault(); void addFiles(files); }
}
function voiceText(text: string) { draft.value = [draft.value.trim(), text.trim()].filter(Boolean).join('\n'); voiceOpen.value = false; void nextTick(() => textarea.value?.focus()); }
</script>

<template>
  <div class="relative rounded-2xl border border-[var(--border)] bg-[var(--background)] p-3 shadow-sm focus-within:border-[var(--accent)]" @dragover.prevent @drop="drop">
    <textarea ref="textarea" v-model="draft" rows="3" aria-label="项目对话输入" class="max-h-48 min-h-20 w-full resize-y bg-transparent px-1 py-1 text-sm leading-6 outline-none disabled:opacity-60" :disabled="busy" :placeholder="running ? '项目正在执行，完成后可继续追问或修改…' : '继续追问，或描述需要修改的内容… 输入 @ 可切换项目员工'" @input="input" @keydown="keydown" @paste="paste" />
    <div v-if="mentionOpen" class="absolute bottom-full left-3 z-30 mb-2 max-h-48 w-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-xl" role="listbox" aria-label="项目员工">
      <button v-for="(member, index) in mentions" :key="member.id" type="button" :class="['block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--accent-soft)]', index === mentionIndex ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : '']" @click="mention(member)">{{ member.name }}</button>
      <p v-if="!mentions.length" class="p-2 text-xs text-[var(--muted)]">没有匹配的项目员工</p>
    </div>
    <DocumentAttachments v-if="documentsOpen" :key="requestId" ref="documents" compact :disabled="running || sending" :upload-file="file => uploadProjectDocument(projectId, requestId, file)" @change="fileIds = $event" @uploading="uploading = $event" @valid="documentsValid = $event" />
    <p v-if="error" role="alert" class="mt-2 text-xs text-rose-600">{{ error }}</p>
    <div class="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-2">
      <button type="button" aria-label="语音输入" class="rounded-lg px-2.5 py-2 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:opacity-40" :disabled="busy || !members.length" @click="voiceOpen = true">语音输入</button>
      <button v-if="managed" type="button" class="rounded-lg px-2.5 py-2 text-xs font-semibold text-[var(--muted)] hover:bg-[var(--surface-muted)] disabled:opacity-40" :disabled="busy" @click="openDocuments">添加文档</button>
      <slot name="tools" :disabled="busy || voiceOpen" />
      <select v-model="selectedId" aria-label="回复员工" class="max-w-40 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-xs outline-none disabled:opacity-40" :disabled="busy || !members.length">
        <option v-if="!members.length" value="">暂无可用员工</option>
        <option v-for="member in members" :key="member.id" :value="member.id">{{ member.name }}</option>
      </select>
      <button v-if="running" type="button" class="ml-auto rounded-lg border border-rose-500/30 px-3 py-2 text-xs font-semibold text-rose-600" @click="emit('cancel')">停止执行</button>
      <button v-else type="button" class="ml-auto rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white disabled:opacity-40" :disabled="!canSend" @click="send">{{ sending ? '正在发送…' : uploading ? '解析文档中…' : '发送' }}</button>
    </div>
    <p class="mt-2 px-1 text-[10px] leading-4 text-[var(--muted)]">{{ !members.length ? '暂无可用员工，请检查员工配置。' : conversation ? 'Enter 发送 · Shift+Enter 换行 · 每轮独立执行，成功成果集中保存' : 'Enter 发送 · Shift+Enter 换行 · 原项目续聊，目标员工及下游按依赖增量执行' }}<span v-if="managed"> · 可拖入文档</span></p>
    <VoiceInputDialog v-if="voiceOpen" auto-start @close="voiceOpen = false" @transcript="voiceText" />
  </div>
</template>
