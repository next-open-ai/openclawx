<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import type { SkillRecord } from '../../app/capabilities';
import { listSkillFiles, readSkillFile, streamChat, writeSkillDraft, writeSkillFile } from '../../services/api';
import { useModelConfig, toModelPayload } from '../../app/model-config';
import { useNotify } from '../../app/notify';
import { useTheme } from '../../app/theme.js';

type FileEntry = { path: string; relative: string; type: 'directory' | 'file' };
const props = defineProps<{ skill: SkillRecord; initialContent?: string; initialRequest?: string }>();
const emit = defineEmits<{ close: []; saved: [skill: SkillRecord] }>();
const { activeConfig, configured, load: loadModels } = useModelConfig();
const notify = useNotify();
const { resolvedTheme } = useTheme();
function monacoTheme() {
  return resolvedTheme.value === 'light' ? 'vs' : 'vs-dark';
}
const editorHost = ref<HTMLElement>(); const diffHost = ref<HTMLElement>();
const current = ref(''); const selectedFile = ref('SKILL.md'); const selectedPath = ref(''); const files = ref<FileEntry[]>([]);
const prompt = ref(''); const messages = ref<Array<{ role: 'user' | 'assistant'; content: string }>>([]); const busy = ref(false); const error = ref(''); const saving = ref(false);
const proposed = ref(''); const pendingFiles = ref<Array<{ relative: string; content: string }>>([]); const showDiff = ref(false); const isDraft = ref(!props.skill.path);
const collapsedDirectories = ref(new Set<string>()); const assistantCollapsed = ref(false);
let editor: monaco.editor.IStandaloneCodeEditor | undefined; let diff: monaco.editor.IStandaloneDiffEditor | undefined;
(self as unknown as { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

const treeEntries = computed(() => {
  const standard = [
  { path: '', relative: 'SKILL.md', type: 'file' as const },
  { path: '', relative: 'scripts', type: 'directory' as const },
  { path: '', relative: 'references', type: 'directory' as const },
  { path: '', relative: 'assets', type: 'directory' as const },
  { path: '', relative: 'tests', type: 'directory' as const },
  ];
  const merged = new Map(standard.map((entry) => [entry.relative, entry]));
  files.value.forEach((entry) => merged.set(entry.relative, entry));
  return [...merged.values()].sort((left, right) => left.relative === 'SKILL.md' ? -1 : right.relative === 'SKILL.md' ? 1 : left.relative.localeCompare(right.relative));
});
const visibleTreeEntries = computed(() => treeEntries.value.filter((entry) => {
  const parts = entry.relative.split('/');
  return parts.slice(0, -1).every((_, index) => !collapsedDirectories.value.has(parts.slice(0, index + 1).join('/')));
}));
function language(file: string) { if (/\.json$/i.test(file)) return 'json'; if (/\.(ya?ml)$/i.test(file)) return 'yaml'; if (/\.(sh|bash)$/i.test(file)) return 'shell'; if (/\.(ts|js)$/i.test(file)) return 'typescript'; return 'markdown'; }
function safeName(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 64) || props.skill.name; }
function skillName(content: string) { return safeName(content.match(/^name:\s*['"]?([^\r\n'"]+)/mi)?.[1] || props.skill.name); }
function description(content: string) { return content.match(/^description:\s*(.+)$/mi)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || props.skill.description; }
function fileBlocks(reply: string) { return [...reply.matchAll(/<file\s+path=["']([^"']+)["']\s*>\s*([\s\S]*?)\s*<\/file>/gi)].map((match) => ({ relative: match[1].replace(/^\.\//, ''), content: match[2] })).filter((item) => item.relative && !item.relative.includes('..')); }
function fileLabel(entry: FileEntry) { return entry.relative.split('/').pop() || entry.relative; }
function fileDepth(entry: FileEntry) { return Math.max(0, entry.relative.split('/').length - 1); }
function toggleDirectory(entry: FileEntry) { const next = new Set(collapsedDirectories.value); if (next.has(entry.relative)) next.delete(entry.relative); else next.add(entry.relative); collapsedDirectories.value = next; }
function createEditor() {
  if (!editorHost.value) return;
  editor = monaco.editor.create(editorHost.value, { value: current.value, language: language(selectedFile.value), theme: monacoTheme(), automaticLayout: true, minimap: { enabled: false }, fontSize: 13, lineHeight: 21, wordWrap: 'on', padding: { top: 16 }, scrollBeyondLastLine: false });
  editor.onDidChangeModelContent(() => { current.value = editor?.getValue() || ''; });
}
function setEditorContent(value: string, file = selectedFile.value) { current.value = value; selectedFile.value = file; if (editor) { monaco.editor.setModelLanguage(editor.getModel()!, language(file)); editor.setValue(value); } }
async function loadFiles() { if (!props.skill.path) return; files.value = await listSkillFiles(props.skill.path); }
async function selectFile(entry: FileEntry) {
  if (entry.type === 'directory' || entry.relative === selectedFile.value || !entry.path) return;
  try { const result = await readSkillFile(entry.path); selectedPath.value = result.path; setEditorContent(result.content, entry.relative); } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}
async function openDiff() { await nextTick(); if (!diffHost.value) return; diff?.dispose(); diff = monaco.editor.createDiffEditor(diffHost.value, { theme: monacoTheme(), automaticLayout: true, readOnly: true, minimap: { enabled: false }, renderSideBySide: true }); diff.setModel({ original: monaco.editor.createModel(current.value, language(selectedFile.value)), modified: monaco.editor.createModel(proposed.value, language(selectedFile.value)) }); }
async function restoreEditor() { showDiff.value = false; await nextTick(); editor?.dispose(); editor = undefined; createEditor(); }
watch(resolvedTheme, () => {
  monaco.editor.setTheme(monacoTheme());
});
async function generateInitial() {
  if (!props.initialRequest) return;
  await loadModels();
  // 模型未配置时，仅写 error 会把提示挂在右侧面板底部 —— 刚进工作区看不到，
  // 表现为「什么都没发生」。这里同时弹出 toast，说明为何没有生成初稿。
  if (!configured.value) { error.value = '请先在设置中配置可用的对话模型。'; notify.warning('notify.error.modelMissing', error.value); return; }
  busy.value = true; let output = ''; messages.value.push({ role: 'user', content: props.initialRequest }); messages.value.push({ role: 'assistant', content: '' });
  try {
    const task = `Create a complete SKILL.md. Return only the raw SKILL.md content, starting with YAML frontmatter. Keep frontmatter limited to name and description. Use concise, progressive disclosure instructions. Skill name: ${props.skill.name}. Description: ${props.skill.description}. User request: ${props.initialRequest}`;
    await streamChat({ profile: { id: 'administrator', name: 'System Administrator', toolIds: ['skill-authoring'], instructions: 'Create safe and concise Agent Skills.' }, messages: [{ role: 'user', content: task }], model: toModelPayload(activeConfig.value) }, (delta) => { output += delta; messages.value[messages.value.length - 1].content = output; setEditorContent(output, 'SKILL.md'); });
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); notify.error(cause); }
  finally { busy.value = false; }
}
async function askAdministrator() {
  const request = prompt.value.trim(); if (!request || busy.value) return; await loadModels(); if (!configured.value) { error.value = '请先在设置中配置可用的对话模型。'; notify.warning('notify.error.modelMissing', error.value); return; }
  messages.value.push({ role: 'user', content: request }); prompt.value = ''; busy.value = true; error.value = ''; let reply = ''; messages.value.push({ role: 'assistant', content: '' });
  try {
    const context = `Skill: ${props.skill.name}\nCurrent file: ${selectedFile.value}\nDirectory: ${treeEntries.value.map((item) => item.relative).join(', ')}\nContent:\n${current.value}\n\nRequest: ${request}`;
    await streamChat({ profile: { id: 'administrator', name: 'System Administrator', toolIds: ['skill-authoring'], instructions: 'Return each proposed file as <file path="relative/path">full content</file>. Include the current file. You may propose new files under scripts, references, assets, or tests. Never claim changes are saved.' }, messages: [{ role: 'user', content: context }], model: toModelPayload(activeConfig.value) }, (delta) => { reply += delta; messages.value[messages.value.length - 1].content = reply; });
    const changes = fileBlocks(reply); const currentChange = changes.find((item) => item.relative === selectedFile.value) || changes[0]; if (currentChange) { if (currentChange.relative !== selectedFile.value) { const existing = treeEntries.value.find((entry) => entry.relative === currentChange.relative); if (existing?.path) await selectFile(existing); else setEditorContent('', currentChange.relative); } proposed.value = currentChange.content; pendingFiles.value = changes.filter((item) => item !== currentChange); showDiff.value = true; await openDiff(); }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); notify.error(cause); }
  finally { busy.value = false; }
}
async function persist(value = current.value) {
  saving.value = true; error.value = '';
  try {
    if (isDraft.value || selectedFile.value === 'SKILL.md') {
      const name = skillName(value); const manifest = await writeSkillDraft({ name, content: value });
      isDraft.value = false; selectedPath.value = manifest.path; files.value = await listSkillFiles(manifest.path);
      emit('saved', { ...props.skill, id: `local:${name}`, name, path: manifest.path, source: 'local', description: description(value) });
      notify.success('notify.saved', `${name}/SKILL.md`);
    } else if (selectedPath.value) { await writeSkillFile({ path: selectedPath.value, content: value }); notify.success('notify.saved', selectedFile.value); }
  } catch (cause) {
    // 保存失败必须显式反馈：后端 /skills/draft 与 /skills/file 都是 requireAdmin，
    // 非管理员会拿到 403，此前只写 error 容易被当成「保存成功了」。
    error.value = cause instanceof Error ? cause.message : String(cause);
    notify.error(cause, '保存失败');
  }
  finally { saving.value = false; }
}
async function acceptDiff() {
  await persist(proposed.value);
  current.value = proposed.value;
  const root = selectedPath.value.replace(/[\\/][^\\/]+$/, '');
  for (const file of pendingFiles.value) await writeSkillFile({ path: `${root}/${file.relative}`, content: file.content });
  await loadFiles();
  proposed.value = '';
  pendingFiles.value = [];
  diff?.dispose();
  diff = undefined;
  await restoreEditor();
}
async function rejectDiff() { proposed.value = ''; pendingFiles.value = []; diff?.dispose(); diff = undefined; await restoreEditor(); }
onMounted(async () => { current.value = props.initialContent || `---\nname: ${props.skill.name}\ndescription: ${props.skill.description}\n---\n\n# ${props.skill.name}\n`; await nextTick(); createEditor(); await loadFiles(); await generateInitial(); });
onBeforeUnmount(() => { editor?.dispose(); diff?.dispose(); });
</script>
<template>
  <section class="flex h-full min-h-0 flex-col bg-[var(--background)]"><header class="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-6 py-4"><div><p class="text-[11px] font-extrabold tracking-[.12em] text-[var(--accent)]">OpenClawX / SKILL WORKSPACE</p><h1 class="mt-1 text-lg font-bold">{{ skill.name }} <span class="font-normal text-[var(--muted)]">/ {{ selectedFile }}</span></h1></div><div class="flex items-center gap-3"><span v-if="isDraft" class="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-700">未保存草案</span><button class="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold" @click="emit('close')">关闭</button><button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40" :disabled="saving" @click="persist()">{{ saving ? '正在保存…' : '保存 Skill' }}</button></div></header>
    <div :class="['grid min-h-0 flex-1', assistantCollapsed ? 'lg:grid-cols-[210px_minmax(0,1fr)_44px]' : 'lg:grid-cols-[210px_minmax(0,1fr)_360px]']"><aside class="min-h-0 overflow-y-auto border-r border-[var(--border)] bg-[var(--surface)] p-3"><div class="mb-3 flex items-center justify-between px-2"><span class="text-xs font-bold text-[var(--muted)]">{{ skill.name }}/</span><span class="text-[10px] text-[var(--muted)]">{{ isDraft ? 'DRAFT' : 'LOCAL' }}</span></div><button v-for="entry in visibleTreeEntries" :key="entry.relative" :style="{ paddingLeft: `${10 + fileDepth(entry) * 14}px` }" :class="['flex w-full items-center gap-2 rounded-lg py-2 text-left text-sm', entry.type === 'directory' ? 'text-[var(--muted)] hover:bg-[var(--surface-muted)]' : selectedFile === entry.relative ? 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]' : 'hover:bg-[var(--surface-muted)]']" @click="entry.type === 'directory' ? toggleDirectory(entry) : selectFile(entry)"><span>{{ entry.type === 'directory' ? (collapsedDirectories.has(entry.relative) ? '›' : '⌄') : '▧' }}</span><span class="truncate">{{ fileLabel(entry) }}</span></button><p class="mt-5 px-2 text-xs leading-relaxed text-[var(--muted)]">SKILL.md 是入口文件。点击目录可展开或收起。</p></aside>
      <main class="min-h-0 border-r border-[var(--border)]"><div v-if="!showDiff" ref="editorHost" class="h-full"></div><div v-else class="flex h-full min-h-0 flex-col"><div class="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-3"><span class="text-sm font-semibold">AI 变更预览 · {{ selectedFile }}</span><div class="flex gap-2"><button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold" @click="rejectDiff">拒绝</button><button class="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white" @click="acceptDiff">接受并保存</button></div></div><div ref="diffHost" class="min-h-0 flex-1"></div></div></main>
      <aside v-if="!assistantCollapsed" class="flex min-h-0 flex-col bg-[var(--surface)]"><div class="flex items-start justify-between border-b border-[var(--border)] px-5 py-4"><div><p class="text-sm font-bold">系统管理员</p><p class="mt-1 text-xs text-[var(--muted)]">上下文：{{ selectedFile }}、Skill 文件树与本次对话。</p></div><button class="rounded-lg p-2 text-[var(--muted)] hover:bg-[var(--surface-muted)]" title="向右折叠智能体面板" @click="assistantCollapsed = true">›</button></div><div class="border-b border-[var(--border)] px-5 py-3 text-xs text-[var(--muted)]"><span v-if="busy" class="font-semibold text-[var(--accent)]">正在生成并显示草案…</span><span v-else>AI 修改将先进入 Diff，确认后才写入。</span></div><div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-5"><div v-if="!messages.length" class="rounded-xl bg-[var(--surface-muted)] p-3 text-sm text-[var(--muted)]">说明希望如何调整当前文件；我会先提出变更预览。</div><article v-for="(message, index) in messages" :key="index" :class="['rounded-xl p-3 text-sm leading-relaxed whitespace-pre-wrap', message.role === 'user' ? 'ml-8 bg-[var(--accent-soft)]' : 'mr-4 bg-[var(--surface-muted)]']">{{ message.content || '正在生成…' }}</article></div><div class="shrink-0 border-t border-[var(--border)] p-4"><textarea v-model="prompt" rows="3" class="w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--background)] p-3 text-sm" placeholder="例如：增加对 CSV 列校验失败时的处理规范…" @keydown.meta.enter.prevent="askAdministrator" @keydown.ctrl.enter.prevent="askAdministrator"></textarea><p v-if="error" class="mt-2 text-xs text-rose-600">{{ error }}</p><button class="mt-3 w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40" :disabled="busy || !prompt.trim()" @click="askAdministrator">{{ busy ? '正在生成…' : '生成变更预览' }}</button></div></aside>
      <aside v-else class="flex justify-center border-l border-[var(--border)] bg-[var(--surface)] pt-3"><button class="h-9 w-8 rounded-lg text-lg text-[var(--muted)] hover:bg-[var(--surface-muted)]" title="展开智能体面板" @click="assistantCollapsed = false">‹</button></aside>
    </div></section>
</template>
