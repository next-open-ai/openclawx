<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue';
import { useI18n } from '../../app/i18n';
import { defaultSkillExecution, isBaselineCatalogSkill, useCapabilities, type SkillRecord, type SkillSource } from '../../app/capabilities';
import { deleteManagedSkill, discoverSkills, importGitSkill, importSkillZip, installSkillPackage, readSkillFile, streamChat, writeSkillDraft } from '../../services/api';
import { useModelConfig, toModelPayload } from '../../app/model-config';
import { useAuth } from '../../app/auth';
import { useNotify } from '../../app/notify';
import SkillAuthoringList from './SkillAuthoringList.vue';
import McpConnectorsPanel from './McpConnectorsPanel.vue';
import { isDesktopShell } from '../../app/platform.js';
const SkillEditorWorkspace = defineAsyncComponent(() => import('./SkillEditorWorkspace.vue'));

type RegistrySkill = { reference: string; source: string; slug: string; name: string; description: string; installs: string; url: string };
const { t } = useI18n(); const { skills, policies, load, saveSkills, removeSkill, setExecutionPolicy } = useCapabilities(); const { activeConfig, configured, load: loadModels } = useModelConfig();
const { isAdmin } = useAuth();
const notify = useNotify();
const domain = ref<'skills' | 'mcp'>('skills');
const tab = ref<'catalog' | 'discover' | 'create'>('catalog');
const query = ref(''); const categoryFilter = ref('all'); const discoverQuery = ref(''); const results = ref<RegistrySkill[]>([]); const searching = ref(false); const searchError = ref(''); const selected = ref<RegistrySkill | null>(null); const libraryDetail = ref<SkillRecord | null>(null); const executionHosts = ref(''); const editingSkill = ref<SkillRecord | null>(null); const editorInitialContent = ref(''); const editorInitialRequest = ref(''); const packageRef = ref(''); const gitState = ref(''); const importingGit = ref(false); const creatorOpen = ref(false); const creatorBusy = ref(false); const creatorError = ref(''); const creatorReply = ref(''); const creatorRequest = ref(''); const newSkillName = ref(''); const newSkillDescription = ref(''); const existingSkillId = ref('new'); const draft = ref<{ name: string; content: string } | null>(null);
const installProgress = ref<{ name: string; label: string; percent: number } | null>(null);
const importManifestText = ref('');
const zipInput = ref<HTMLInputElement | null>(null);

function switchDomain(next: 'skills' | 'mcp') {
  domain.value = next;
  if (next === 'skills' && tab.value !== 'catalog' && tab.value !== 'discover' && tab.value !== 'create') tab.value = 'catalog';
}
function setSkillTab(next: string) {
  if (next === 'catalog' || next === 'discover' || next === 'create') tab.value = next;
}
function skillCategory(skill: SkillRecord) {
  return skill.tags?.[0] || (skill.source === 'builtin' ? '平台' : skill.source);
}
const categories = computed(() => {
  const counts = new Map<string, number>();
  for (const skill of skills.value) {
    const key = skillCategory(skill);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
});
const catalogStats = computed(() => {
  const all = skills.value;
  return {
    total: all.length,
    baseline: all.filter((skill) => isBaselineCatalogSkill(skill.id) || (skill.source === 'builtin' && !skill.systemOnly)).length,
    local: all.filter((skill) => skill.source === 'local' || skill.source === 'registry').length,
    granted: policies.value.filter((item) => item.mode !== 'disabled').length,
  };
});
const shownSkills = computed(() => {
  const q = query.value.trim().toLowerCase();
  return skills.value
    .filter((skill) => {
      if (categoryFilter.value !== 'all' && skillCategory(skill) !== categoryFilter.value) return false;
      if (!q) return true;
      return `${skill.name} ${skill.description} ${skill.tags?.join(' ') || ''}`.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const aBase = isBaselineCatalogSkill(a.id) || a.source === 'builtin' ? 0 : 1;
      const bBase = isBaselineCatalogSkill(b.id) || b.source === 'builtin' ? 0 : 1;
      if (aBase !== bBase) return aBase - bBase;
      return a.name.localeCompare(b.name, 'zh');
    });
});
const localSkills = computed(() => skills.value.filter((skill) => skill.source !== 'builtin')); const authoringSkills = computed(() => skills.value.filter((skill) => skill.source === 'local' && Boolean(skill.path))); const fullSearchUrl = computed(() => `https://skills.sh/search?q=${encodeURIComponent(discoverQuery.value.trim())}`);
function skillInitial(name: string) {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : '?';
}
function skillAccent(skill: SkillRecord) {
  if (isBaselineCatalogSkill(skill.id)) return 'from-sky-500 to-indigo-500';
  if (skill.source === 'local') return 'from-emerald-500 to-teal-600';
  if (skill.source === 'registry') return 'from-violet-500 to-fuchsia-600';
  return 'from-slate-500 to-slate-700';
}
function canonical(value: string) { return value.trim().replace(/^['"]|['"]$/g, '').toLowerCase(); }
function manifestToSkill(manifest: { path: string; content: string }, source: SkillRecord['source']): SkillRecord | null { const block = manifest.content.match(/^---\r?\n([\s\S]*?)\r?\n---/); if (!block) return null; const field = (name: string) => block[1].match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^['"]|['"]$/g, ''); const name = field('name'); const description = field('description'); return name && description ? { id: `${source}:${canonical(name)}`, name, description, source, status: 'ready', risk: 'low', path: manifest.path, tags: [source], execution: defaultSkillExecution() } : null; }
async function upsert(skill: SkillRecord) { const index = skills.value.findIndex((item) => item.source !== 'builtin' && canonical(item.name) === canonical(skill.name)); if (index >= 0) skills.value[index] = { ...skills.value[index], ...skill, id: skills.value[index].id }; else skills.value.push(skill); await saveSkills(); }
async function refresh() { await load(); }
async function discover() { if (discoverQuery.value.trim().length < 2) return; searching.value = true; searchError.value = ''; results.value = []; try { results.value = (await discoverSkills(discoverQuery.value.trim())).items ?? []; if (!results.value.length) searchError.value = t('capabilities.noResults'); } catch (error) { searchError.value = error instanceof Error ? error.message : String(error); } finally { searching.value = false; } }
async function importLocal() { if (!isAdmin.value) return; const manifest = await window.openclawxDesktop?.pickSkill(); if (!manifest) return; const skill = manifestToSkill(manifest, 'local'); if (!skill) { gitState.value = t('capabilities.invalidManifest'); return; } await upsert(skill); gitState.value = t('capabilities.localImported'); }
async function importPastedSkill() {
  if (!isAdmin.value) return;
  const content = importManifestText.value.trim();
  if (!content) return;
  const parsed = manifestToSkill({ path: '', content }, 'local');
  if (!parsed) {
    gitState.value = t('capabilities.invalidManifest');
    return;
  }
  const saved = await writeSkillDraft({ name: canonical(parsed.name), content });
  await upsert({ ...parsed, path: saved.path });
  importManifestText.value = '';
  gitState.value = t('capabilities.localImported');
}
async function importZipFile(file: File) {
  if (!isAdmin.value) return;
  gitState.value = '正在上传并导入 Skill zip…';
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  const result = await importSkillZip({ filename: file.name, base64: btoa(binary) });
  const skill = result.manifest ? manifestToSkill(result.manifest, 'local') : null;
  if (!skill) throw new Error(t('capabilities.invalidManifest'));
  await upsert(skill);
  gitState.value = `已导入 ${result.importedFiles} 个文件：${skill.name}`;
}
async function handleZipPicked(event: Event) {
  const input = event.target as HTMLInputElement | null;
  const file = input?.files?.[0];
  if (!file) return;
  try {
    await importZipFile(file);
  } catch (error) {
    gitState.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (input) input.value = '';
  }
}
async function importGit() {
  if (!isAdmin.value) return;
  if (!packageRef.value.trim() || importingGit.value) return;
  importingGit.value = true;
  gitState.value = t('capabilities.gitImporting');
  try {
    await runInstallProgress(packageRef.value.trim(), async () => {
      const result = await importGitSkill(packageRef.value.trim());
      for (const manifest of result?.manifests ?? []) {
        const skill = manifestToSkill(manifest, 'local');
        if (skill) await upsert(skill);
      }
      gitState.value = t('capabilities.gitImported', { count: result?.manifests.length ?? 0 });
      packageRef.value = '';
    });
  } catch (error) {
    gitState.value = error instanceof Error ? error.message : String(error);
  } finally {
    importingGit.value = false;
  }
}
function parseDraft(value: string) { const json = value.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? value.match(/\{[\s\S]*\}/)?.[0]; try { const parsed = JSON.parse(json || ''); return typeof parsed.name === 'string' && typeof parsed.content === 'string' ? parsed : null; } catch { return null; } }
function openCreator(skill?: SkillRecord | null) { existingSkillId.value = skill?.id ?? 'new'; creatorRequest.value = skill ? `${t('capabilities.creatorEditPrompt')} ${skill.name}.` : `${t('capabilities.creatorAutoPrompt')} ${canonical(newSkillName.value)}.`; creatorReply.value = ''; creatorError.value = ''; draft.value = null; creatorOpen.value = true; }
function openEditor(skill: SkillRecord) {
  if (!isAdmin.value) { notify.warning('capabilities.adminRequiredTitle', t('capabilities.adminRequiredHint')); return; }
  if (!skill.path) { notify.warning('capabilities.adminRequiredTitle', t('capabilities.editorManagedOnly')); return; }
  editorInitialContent.value = ''; editingSkill.value = skill;
}
// 进入创作工作区。此前这里对非管理员直接 `return`，而「进入工作区」按钮只按输入
// 是否为空来 disabled —— member 点了按钮毫无反应，也没有任何提示（后端
// /skills/draft 有 requireAdmin，确实不允许写）。现在改为明确反馈失败原因。
function startNewWorkspace() {
  if (!isAdmin.value) { notify.warning('capabilities.adminRequiredTitle', t('capabilities.adminRequiredHint')); return; }
  const name = canonical(newSkillName.value); const description = newSkillDescription.value.trim();
  if (!name || !description) { notify.warning('capabilities.draftIncompleteTitle', t('capabilities.draftIncompleteHint')); return; }
  const duplicate = skills.value.find((skill) => canonical(skill.name) === name);
  if (duplicate) { notify.warning('capabilities.draftDuplicateTitle', t('capabilities.draftDuplicateHint', { name })); return; }
  editorInitialContent.value = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n`;
  editorInitialRequest.value = `创建名为 ${name} 的 Skill。${description}`;
  editingSkill.value = { id: `local:${name}`, name, description, source: 'local', status: 'ready', risk: 'low', tags: ['local'], execution: defaultSkillExecution() };
  newSkillName.value = ''; newSkillDescription.value = '';
}
function createSkillWorkspace(name: string, description: string) { newSkillName.value = name; newSkillDescription.value = description; startNewWorkspace(); }
function openDraftWorkspace(value: { name: string; content: string }) { editorInitialContent.value = value.content; editingSkill.value = { id: `local:${canonical(value.name)}`, name: value.name, description: value.content.match(/^description:\s*(.+)$/mi)?.[1]?.trim() || '', source: 'local', status: 'ready', risk: 'low', tags: ['local'], execution: defaultSkillExecution() }; creatorOpen.value = false; }
async function createWithAdministrator() {
  if (!isAdmin.value) return;
  if (!creatorRequest.value.trim() || creatorBusy.value) return;
  await loadModels();
  if (!configured.value) { creatorError.value = t('capabilities.creatorModelRequired'); return; }
  creatorBusy.value = true; creatorReply.value = ''; creatorError.value = '';
  try {
    let existing = '';
    const target = skills.value.find((skill) => skill.id === existingSkillId.value);
    if (target?.path) existing = (await readSkillFile(target.path)).content || '';
    const prompt = `You are OpenClawX's System Administrator. Apply Skill Creator principles: understand concrete use, keep instructions concise, use progressive disclosure, and use lowercase hyphen name. Return ONLY JSON {"name":"...","content":"full SKILL.md"}. SKILL.md frontmatter must only include name and description. Request: ${creatorRequest.value}${existing ? `\nExisting skill:\n${existing}` : ''}`;
    await streamChat({ profile: { id: 'administrator', name: 'System Administrator', toolIds: ['skill-authoring'], instructions: 'Create safe, concise skills.' }, messages: [{ role: 'user', content: prompt }], model: toModelPayload(activeConfig.value) }, (delta) => { creatorReply.value += delta; });
    draft.value = parseDraft(creatorReply.value);
    if (!draft.value) creatorError.value = t('capabilities.creatorParseError');
    else openDraftWorkspace(draft.value);
  } catch (error) { creatorError.value = error instanceof Error ? error.message : String(error); }
  finally { creatorBusy.value = false; }
}
async function saveDraft() { if (!draft.value) return; openDraftWorkspace(draft.value); }
async function runInstallProgress(name: string, work: () => Promise<void>) {
  const stages = [
    { label: t('capabilities.installStagePrepare'), percent: 8 },
    { label: t('capabilities.installStageFetch'), percent: 28 },
    { label: t('capabilities.installStageUnpack'), percent: 58 },
    { label: t('capabilities.installStageRegister'), percent: 82 },
  ];
  let stageIdx = 0;
  installProgress.value = { name, label: stages[0].label, percent: stages[0].percent };
  const timer = setInterval(() => {
    stageIdx = Math.min(stageIdx + 1, stages.length - 1);
    const stage = stages[stageIdx];
    if (installProgress.value) installProgress.value = { name, label: stage.label, percent: Math.max(installProgress.value.percent, stage.percent) };
  }, 520);
  try {
    await work();
    installProgress.value = { name, label: t('capabilities.installStageDone'), percent: 100 };
    await new Promise((resolve) => setTimeout(resolve, 480));
  } finally {
    clearInterval(timer);
    installProgress.value = null;
  }
}

async function installSelected() {
  if (!isAdmin.value) return;
  if (!selected.value || installProgress.value) return;
  const target = selected.value;
  try {
    await runInstallProgress(target.name, async () => {
      const response = await installSkillPackage(target.reference);
      const skill = response?.manifest
        ? manifestToSkill(response.manifest, 'registry')
        : {
            id: `registry:${canonical(target.name)}`,
            name: target.name,
            description: target.description,
            source: 'registry' as const,
            status: 'ready' as const,
            risk: 'medium' as const,
            tags: ['registry'],
            execution: defaultSkillExecution(),
          };
      if (skill) await upsert(skill);
    });
    selected.value = null;
    tab.value = 'catalog';
  } catch (error) {
    searchError.value = error instanceof Error ? error.message : String(error);
  }
}

async function deleteSkill(skill: SkillRecord | null) { if (!isAdmin.value || !skill) return; if (window.confirm(t('capabilities.deleteConfirm', { name: skill.name }))) { if (skill.path) await deleteManagedSkill(skill.path); await removeSkill(skill.id); libraryDetail.value = null; } }
function openLibraryDetail(skill: SkillRecord) { skill.execution ??= defaultSkillExecution(); libraryDetail.value = skill; executionHosts.value = skill.execution.allowedNetworkHosts.join(', '); }
function isCatalogBuiltin(skill: SkillRecord) {
  return skill.source === 'builtin' || isBaselineCatalogSkill(skill.id);
}
async function saveExecutionPolicy() {
  if (!isAdmin.value) return;
  if (!libraryDetail.value) return;
  const current = libraryDetail.value.execution ?? defaultSkillExecution();
  await setExecutionPolicy(libraryDetail.value.id, { ...current, allowedNetworkHosts: executionHosts.value.split(',') });
  libraryDetail.value = skills.value.find((item) => item.id === libraryDetail.value?.id) ?? null;
}
function skillSourceLabel(source: SkillSource) { return t(`capabilities.source.${source}`); }
function skillSourceBadgeClass(source: SkillSource) {
  const base = 'inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold leading-none';
  if (source === 'builtin') return `${base} border-[var(--border)] bg-[var(--background)] text-[var(--muted)]`;
  if (source === 'local') return `${base} border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300`;
  return `${base} border-[var(--accent)]/35 bg-[var(--accent-soft)] text-[var(--accent)]`;
}
function riskLabel(risk: SkillRecord['risk']) { return t(`capabilities.risk.${risk}`); }
function riskTone(risk: SkillRecord['risk']) {
  if (risk === 'high') return 'bg-rose-500/12 text-rose-700 dark:text-rose-300';
  if (risk === 'medium') return 'bg-amber-500/12 text-amber-700 dark:text-amber-300';
  return 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300';
}
function grantCount(skillId: string) {
  return policies.value.filter((item) => item.skillId === skillId && item.mode !== 'disabled').length;
}
function parseInstallCount(raw: string) {
  const compact = raw.replace(/,/g, '').trim().toUpperCase();
  const match = compact.match(/^([\d.]+)\s*([KMB])?$/);
  if (!match) return Number.parseInt(compact.replace(/[^\d]/g, ''), 10) || 0;
  const base = Number.parseFloat(match[1]) || 0;
  const unit = match[2];
  if (unit === 'K') return Math.round(base * 1_000);
  if (unit === 'M') return Math.round(base * 1_000_000);
  if (unit === 'B') return Math.round(base * 1_000_000_000);
  return Math.round(base);
}
function heatLabel(installs: string) {
  const n = parseInstallCount(installs);
  if (n >= 50_000) return t('capabilities.heatHot');
  if (n >= 5_000) return t('capabilities.heatRising');
  if (n >= 500) return t('capabilities.heatWarm');
  return t('capabilities.heatNew');
}
function heatTone(installs: string) {
  const n = parseInstallCount(installs);
  if (n >= 50_000) return 'text-rose-600';
  if (n >= 5_000) return 'text-amber-600';
  if (n >= 500) return 'text-[var(--accent)]';
  return 'text-[var(--muted)]';
}
function capabilityChips(skill: SkillRecord) {
  const chips: string[] = [];
  if (skill.execution?.allowWorkspaceWrite) chips.push(t('capabilities.chipWrite'));
  if (skill.execution?.allowScriptExecution) chips.push(t('capabilities.chipScript'));
  if (skill.execution?.allowedNetworkHosts?.length) chips.push(t('capabilities.chipNetwork'));
  if (skill.systemOnly) chips.push(t('capabilities.chipSystem'));
  return chips;
}
onMounted(() => { void refresh(); void loadModels(); });
</script>
<template>
  <SkillEditorWorkspace v-if="editingSkill" :skill="editingSkill" :initial-content="editorInitialContent" :initial-request="editorInitialRequest" @close="editingSkill = null; editorInitialContent = ''; editorInitialRequest = ''" @saved="(skill) => { void upsert(skill); editingSkill = skill; editorInitialContent = ''; editorInitialRequest = '' }" />
  <section v-else class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col px-6 py-10 sm:px-12 sm:py-12">
      <header class="mb-6 shrink-0">
        <p class="text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">OpenClawX / GOVERNANCE</p>
        <h1 class="mt-2 text-4xl font-bold tracking-[-.045em]">{{ t('capabilities.title') }}</h1>
        <p class="mt-3 text-[var(--muted)]">{{ t('capabilities.subtitle') }}</p>
      </header>

      <div class="mb-5 shrink-0">
        <div class="inline-flex rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-sm">
          <button
            type="button"
            :class="['rounded-xl px-4 py-2.5 text-sm font-semibold transition', domain === 'skills' ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)] hover:text-[var(--foreground)]']"
            @click="switchDomain('skills')"
          >
            {{ t('capabilities.skillsDomain') }}
          </button>
          <button
            type="button"
            :class="['rounded-xl px-4 py-2.5 text-sm font-semibold transition', domain === 'mcp' ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)] hover:text-[var(--foreground)]']"
            @click="switchDomain('mcp')"
          >
            {{ t('capabilities.mcpDomain') }}
          </button>
        </div>
        <p class="mt-2 max-w-2xl text-xs leading-relaxed text-[var(--muted)]">
          {{ domain === 'skills' ? t('capabilities.skillsDomainHelp') : t('capabilities.mcpDomainHelp') }}
        </p>
        <p class="mt-2 text-xs text-[var(--muted)]">
          {{ isAdmin ? '当前为全局目录管理模式：全员可读，管理员可写。' : '当前为全局目录只读模式：你可以查看和使用预设 Skills / MCP，但只有管理员可以修改。' }}
        </p>
      </div>

      <nav v-if="domain === 'skills'" class="mb-5 flex shrink-0 gap-2 border-b border-[var(--border)] pb-3">
        <button
          v-for="item in [['catalog','capabilities.catalog'],['discover','capabilities.discover'],['create','capabilities.aiCreate']]"
          :key="item[0]"
          :class="['rounded-lg px-3 py-2 text-sm font-semibold', tab === item[0] ? 'bg-[var(--surface-muted)] text-[var(--foreground)] ring-1 ring-[var(--border)]' : 'text-[var(--muted)]']"
          @click="setSkillTab(item[0])"
        >
          {{ t(item[1]) }}
        </button>
      </nav>

      <div v-if="domain === 'mcp'" class="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
        <McpConnectorsPanel />
      </div>
      <div v-else-if="tab === 'catalog'" class="flex min-h-0 flex-1 flex-col gap-4">
        <div class="grid shrink-0 gap-3 sm:grid-cols-4">
          <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
            <p class="text-[10px] font-bold uppercase tracking-[.12em] text-[var(--muted)]">{{ t('capabilities.statTotal') }}</p>
            <p class="mt-1 text-2xl font-bold tabular-nums tracking-tight">{{ catalogStats.total }}</p>
          </div>
          <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
            <p class="text-[10px] font-bold uppercase tracking-[.12em] text-[var(--muted)]">{{ t('capabilities.statBaseline') }}</p>
            <p class="mt-1 text-2xl font-bold tabular-nums tracking-tight text-[var(--accent)]">{{ catalogStats.baseline }}</p>
          </div>
          <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
            <p class="text-[10px] font-bold uppercase tracking-[.12em] text-[var(--muted)]">{{ t('capabilities.statInstalled') }}</p>
            <p class="mt-1 text-2xl font-bold tabular-nums tracking-tight">{{ catalogStats.local }}</p>
          </div>
          <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
            <p class="text-[10px] font-bold uppercase tracking-[.12em] text-[var(--muted)]">{{ t('capabilities.statGrants') }}</p>
            <p class="mt-1 text-2xl font-bold tabular-nums tracking-tight">{{ catalogStats.granted }}</p>
          </div>
        </div>

        <div class="flex min-h-0 flex-1 flex-col gap-4 xl:flex-row">
          <div class="flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            <div class="flex shrink-0 flex-col gap-3 border-b border-[var(--border)] p-4">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 class="text-sm font-bold tracking-[-.01em]">{{ t('capabilities.catalog') }}</h2>
                  <p class="mt-0.5 text-[11px] text-[var(--muted)]">{{ t('capabilities.catalogCount', { count: shownSkills.length }) }} · {{ t('capabilities.progressiveHint') }}</p>
                </div>
                <input v-model="query" class="w-full max-w-xs rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm" :placeholder="t('capabilities.search')" />
              </div>
              <div class="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  :class="['rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition', categoryFilter === 'all' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-muted)] text-[var(--muted)] hover:text-[var(--foreground)]']"
                  @click="categoryFilter = 'all'"
                >
                  {{ t('capabilities.filterAll') }}
                </button>
                <button
                  v-for="[cat, count] in categories"
                  :key="cat"
                  type="button"
                  :class="['rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition', categoryFilter === cat ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-muted)] text-[var(--muted)] hover:text-[var(--foreground)]']"
                  @click="categoryFilter = cat"
                >
                  {{ cat }} · {{ count }}
                </button>
              </div>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
              <p v-if="!shownSkills.length" class="px-3 py-16 text-center text-sm text-[var(--muted)]">{{ t('capabilities.emptySkills') }}</p>
              <div v-else class="grid gap-1.5">
                <button
                  v-for="skill in shownSkills"
                  :key="skill.id"
                  type="button"
                  :class="[
                    'group flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition',
                    libraryDetail?.id === skill.id
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)]/35 shadow-sm ring-1 ring-[var(--accent)]/15'
                      : 'border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-muted)]/70',
                  ]"
                  @click="openLibraryDetail(skill)"
                >
                  <div :class="['grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br text-sm font-extrabold text-white shadow-sm', skillAccent(skill)]">
                    {{ skillInitial(skill.name) }}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-start justify-between gap-2">
                      <h3 class="truncate text-[13px] font-bold tracking-[-.01em]">{{ skill.name }}</h3>
                      <div class="flex shrink-0 items-center gap-1">
                        <span v-if="isBaselineCatalogSkill(skill.id)" class="rounded-md bg-[var(--accent)]/12 px-1.5 py-0.5 text-[10px] font-bold text-[var(--accent)]">{{ t('capabilities.skillBaselineBadge') }}</span>
                        <span :class="skillSourceBadgeClass(skill.source)">{{ skillSourceLabel(skill.source) }}</span>
                      </div>
                    </div>
                    <p class="mt-1 line-clamp-2 text-[12px] leading-relaxed text-[var(--muted)]">{{ skill.description }}</p>
                    <div class="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                      <span class="rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 font-medium text-[var(--muted)]">{{ skillCategory(skill) }}</span>
                      <span :class="['rounded-md px-1.5 py-0.5 font-semibold', riskTone(skill.risk)]">{{ riskLabel(skill.risk) }}</span>
                      <span class="rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 font-medium text-[var(--muted)]">{{ t('capabilities.grantCount', { count: grantCount(skill.id) }) }}</span>
                      <span v-for="chip in capabilityChips(skill).slice(0, 2)" :key="chip" class="rounded-md bg-[var(--accent-soft)]/60 px-1.5 py-0.5 font-medium text-[var(--accent)]">{{ chip }}</span>
                    </div>
                  </div>
                </button>
              </div>
            </div>
          </div>

          <aside class="flex w-full shrink-0 flex-col xl:w-[360px]">
            <section v-if="libraryDetail" class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
              <div class="border-b border-[var(--border)] p-5">
                <div class="flex items-start gap-3">
                  <div :class="['grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br text-base font-extrabold text-white', skillAccent(libraryDetail)]">
                    {{ skillInitial(libraryDetail.name) }}
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="text-[10px] font-extrabold tracking-[.12em] text-[var(--accent)]">{{ skillSourceLabel(libraryDetail.source).toUpperCase() }}</p>
                    <h2 class="mt-1 text-lg font-bold tracking-[-.02em]">{{ libraryDetail.name }}</h2>
                    <p class="mt-2 text-sm leading-relaxed text-[var(--muted)]">{{ libraryDetail.description }}</p>
                  </div>
                </div>
                <div class="mt-4 flex flex-wrap gap-1.5 text-[11px]">
                  <span v-if="isBaselineCatalogSkill(libraryDetail.id)" class="rounded-md bg-[var(--accent)]/12 px-2 py-1 font-bold text-[var(--accent)]">{{ t('capabilities.skillBaselineBadge') }}</span>
                  <span :class="['rounded-md px-2 py-1 font-semibold', riskTone(libraryDetail.risk)]">{{ riskLabel(libraryDetail.risk) }}</span>
                  <span class="rounded-md bg-[var(--surface-muted)] px-2 py-1 text-[var(--muted)]">{{ skillCategory(libraryDetail) }}</span>
                  <span class="rounded-md bg-[var(--surface-muted)] px-2 py-1 text-[var(--muted)]">{{ t('capabilities.grantCount', { count: grantCount(libraryDetail.id) }) }}</span>
                  <span v-for="chip in capabilityChips(libraryDetail)" :key="chip" class="rounded-md bg-[var(--accent-soft)] px-2 py-1 text-[var(--accent)]">{{ chip }}</span>
                </div>
              </div>

              <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
                <section v-if="libraryDetail.instructions" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/50 p-4">
                  <p class="text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">{{ t('capabilities.instructionsPreview') }}</p>
                  <p class="mt-2 text-xs leading-relaxed text-[var(--foreground)] whitespace-pre-wrap">{{ libraryDetail.instructions }}</p>
                </section>
                <section class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
                  <p class="text-sm font-bold">{{ t('capabilities.executionTitle') }}</p>
                  <p class="mt-1 text-xs leading-relaxed text-[var(--muted)]">{{ t('capabilities.executionHelp') }}</p>
                  <label class="mt-3 flex items-center gap-2 text-sm"><input v-model="libraryDetail.execution.allowWorkspaceWrite" type="checkbox" />{{ t('capabilities.allowWrite') }}</label>
                  <label class="mt-2 flex items-center gap-2 text-sm"><input v-model="libraryDetail.execution.allowScriptExecution" type="checkbox" />{{ t('capabilities.allowScript') }}</label>
                  <label class="mt-3 block text-sm">{{ t('capabilities.allowedHosts') }}<input v-model="executionHosts" class="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" placeholder="api.github.com, example.com" /></label>
                  <button class="mt-3 rounded-lg border border-[var(--accent)] px-3 py-2 text-sm font-semibold text-[var(--accent)] disabled:opacity-50" type="button" :disabled="!isAdmin" @click="saveExecutionPolicy">{{ t('capabilities.saveExecution') }}</button>
                </section>
                <p class="text-[11px] leading-relaxed text-[var(--muted)]">{{ t('capabilities.assignHint') }}</p>
              </div>

              <div class="flex gap-2 border-t border-[var(--border)] p-4">
                <button v-if="libraryDetail.path" class="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold disabled:opacity-50" type="button" :disabled="!isAdmin" @click="openCreator(libraryDetail)">{{ t('capabilities.editWithAdmin') }}</button>
                <button v-if="!isCatalogBuiltin(libraryDetail)" class="rounded-lg px-3 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-500/10 disabled:opacity-50" type="button" :disabled="!isAdmin" @click="deleteSkill(libraryDetail)">{{ t('capabilities.delete') }}</button>
                <button class="ml-auto rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold text-[var(--muted)]" type="button" @click="libraryDetail = null">{{ t('capabilities.closeDetail') }}</button>
              </div>
            </section>
            <section v-else class="flex flex-1 flex-col justify-center rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)]/60 px-6 py-10 text-center">
              <p class="text-sm font-bold">{{ t('capabilities.catalogDetailEmptyTitle') }}</p>
              <p class="mt-2 text-xs leading-relaxed text-[var(--muted)]">{{ t('capabilities.catalogDetailEmptyHelp') }}</p>
            </section>
          </aside>
        </div>
      </div>
      <div v-else-if="tab === 'discover'" class="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
        <section class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h2 class="text-lg font-bold">{{ t('capabilities.discoverTitle') }}</h2>
          <p class="mt-1 text-sm text-[var(--muted)]">{{ t('capabilities.discoverHelp') }}</p>
          <form class="mt-4 flex max-w-2xl gap-2" @submit.prevent="discover">
            <input v-model="discoverQuery" class="min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-2.5 text-sm" :placeholder="t('capabilities.searchQuery')" />
            <button class="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white" :disabled="searching">{{ searching ? t('capabilities.searching') : t('capabilities.searchAction') }}</button>
          </form>
        </section>
        <p v-if="searchError" class="mt-4 text-sm text-rose-600">{{ searchError }}</p>
        <div v-if="results.length" class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          <article
            v-for="(skill, index) in results"
            :key="skill.reference"
            class="flex flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3.5 transition hover:-translate-y-0.5 hover:border-[var(--accent)]/30 hover:shadow-[0_8px_24px_-12px_rgba(15,23,42,0.25)]"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-[10px] font-bold tracking-wide text-[var(--accent)]">{{ skill.source }}</span>
              <span class="rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--muted)]">#{{ index + 1 }}</span>
            </div>
            <h3 class="mt-1.5 truncate text-sm font-bold">{{ skill.name }}</h3>
            <p class="mt-1 line-clamp-2 text-[12px] leading-relaxed text-[var(--muted)]">{{ skill.description || t('capabilities.noDescription') }}</p>
            <div class="mt-2.5 flex flex-wrap items-center gap-1.5 text-[10px]">
              <span :class="['font-semibold', heatTone(skill.installs)]">{{ heatLabel(skill.installs) }}</span>
              <span class="rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-[var(--muted)]">↓ {{ skill.installs }}</span>
              <span class="rounded-md bg-[var(--accent-soft)]/60 px-1.5 py-0.5 font-medium text-[var(--accent)]">{{ t('capabilities.rankHot') }}</span>
            </div>
            <button type="button" class="mt-auto pt-3 text-left text-[12px] font-semibold text-[var(--accent)]" @click="selected = skill">{{ t('capabilities.viewDetails') }} →</button>
          </article>
        </div>
        <a v-if="results.length" class="mt-5 inline-flex rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold" :href="fullSearchUrl" target="_blank">{{ t('capabilities.openMoreOnRegistry') }} ↗</a>
        <div class="mt-6 grid gap-3 md:grid-cols-2">
          <article class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h3 class="text-sm font-bold">{{ t('capabilities.importLocalTitle') }}</h3>
            <p class="mt-1 text-xs text-[var(--muted)]">推荐上传完整 Skill 目录的 `.zip` 包，这样会连同 `scripts/`、`references/`、`assets/` 一起导入。仅导入 `SKILL.md` 适合临时草稿，不适合完整 Skill 包。</p>
            <input ref="zipInput" class="hidden" type="file" accept=".zip,application/zip" @change="handleZipPicked" />
            <div class="mt-3 flex flex-wrap gap-2">
              <button class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold" @click="zipInput?.click()">上传 Skill zip 包</button>
              <button class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold disabled:opacity-50" :disabled="!isAdmin || !isDesktopShell()" @click="importLocal">仅导入 SKILL.md</button>
            </div>
            <p class="mt-2 text-[11px] text-[var(--muted)]">如果只有一个 `SKILL.md` 草稿，没有 zip 包，也可以在下方直接粘贴 manifest 内容。</p>
            <div v-if="!isDesktopShell()" class="mt-3 grid gap-2">
              <textarea v-model="importManifestText" rows="8" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs font-mono" placeholder="粘贴完整 SKILL.md 内容（含 --- frontmatter ---）" />
              <button class="justify-self-start rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold disabled:opacity-50" :disabled="!isAdmin || !importManifestText.trim()" @click="importPastedSkill">
                直接导入粘贴的 SKILL.md
              </button>
            </div>
          </article>
          <article class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h3 class="text-sm font-bold">{{ t('capabilities.importGitTitle') }}</h3>
            <p class="mt-1 text-xs text-[var(--muted)]">{{ t('capabilities.importGitHelp') }}</p>
            <div class="mt-3 flex gap-2">
              <input v-model="packageRef" class="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm" placeholder="https://github.com/org/repository" />
              <button class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold" :disabled="!isAdmin || !packageRef || importingGit || !!installProgress" @click="importGit">{{ importingGit ? t('capabilities.gitImporting') : t('capabilities.install') }}</button>
            </div>
            <p v-if="gitState" class="mt-2 text-xs text-[var(--muted)]">{{ gitState }}</p>
          </article>
        </div>
      </div>
      <SkillAuthoringList v-else-if="tab === 'create'" class="min-h-0 flex-1 overflow-y-auto overscroll-contain" :skills="authoringSkills" :can-author="isAdmin" @create="createSkillWorkspace" @open="openEditor" @remove="deleteSkill" />
    </div>
  <div v-if="selected" class="fixed inset-0 z-30 grid place-items-center bg-slate-950/35 p-5" @click.self="selected = null">
    <article class="w-full max-w-lg rounded-2xl bg-[var(--surface)] p-6 shadow-2xl">
      <button class="float-right text-xl" type="button" @click="selected = null">×</button>
      <p class="text-xs font-bold text-[var(--accent)]">{{ selected.source }}</p>
      <h2 class="mt-2 text-2xl font-bold">{{ selected.name }}</h2>
      <p class="mt-4 text-sm leading-relaxed text-[var(--muted)]">{{ selected.description }}</p>
      <div class="mt-4 flex flex-wrap gap-2 text-xs">
        <span :class="['rounded-md bg-[var(--surface-muted)] px-2 py-1 font-semibold', heatTone(selected.installs)]">{{ heatLabel(selected.installs) }}</span>
        <span class="rounded-md bg-[var(--surface-muted)] px-2 py-1 text-[var(--muted)]">↓ {{ selected.installs }} {{ t('capabilities.installs') }}</span>
        <span class="rounded-md bg-[var(--accent-soft)] px-2 py-1 font-medium text-[var(--accent)]">{{ t('capabilities.rankHot') }}</span>
      </div>
      <button class="mt-6 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60" :disabled="!isAdmin || !!installProgress" @click="installSelected">{{ installProgress ? t('capabilities.installing') : t('capabilities.installAndReview') }}</button>
    </article>
  </div>
  <div v-if="installProgress" class="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 p-5 backdrop-blur-[2px]">
    <article class="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-[var(--surface)] p-6 shadow-2xl">
      <p class="text-[11px] font-extrabold tracking-[.14em] text-[var(--accent)]">{{ t('capabilities.installProgressTitle') }}</p>
      <h3 class="mt-2 truncate text-lg font-bold">{{ installProgress.name }}</h3>
      <p class="mt-1 text-sm text-[var(--muted)]">{{ installProgress.label }}</p>
      <div class="relative mt-5 h-3 overflow-hidden rounded-full bg-[var(--surface-muted)]">
        <div
          class="skill-install-bar absolute inset-y-0 left-0 rounded-full"
          :style="{ width: `${installProgress.percent}%` }"
        />
        <div class="skill-install-shine pointer-events-none absolute inset-0" />
      </div>
      <div class="mt-2 flex items-center justify-between text-xs font-semibold tabular-nums text-[var(--muted)]">
        <span>{{ installProgress.percent }}%</span>
        <span>{{ t('capabilities.installing') }}</span>
      </div>
    </article>
  </div>
  <div v-if="creatorOpen" class="fixed inset-0 z-40 grid place-items-center bg-slate-950/45 p-5"><article class="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl bg-[var(--surface)] p-6 shadow-2xl"><div class="flex justify-between"><div><p class="text-xs font-bold text-[var(--accent)]">SYSTEM ADMINISTRATOR · SKILL CREATOR</p><h2 class="mt-1 text-xl font-bold">{{ t('capabilities.creatorConversation') }}</h2></div><button class="text-xl" @click="creatorOpen = false">×</button></div><p class="mt-3 text-sm text-[var(--muted)]">{{ t('capabilities.creatorPromptHelp') }}</p><textarea v-model="creatorRequest" class="mt-4 min-h-28 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm" :placeholder="t('capabilities.creatorPlaceholder')"></textarea><div class="mt-3 flex items-center gap-3"><span class="text-xs text-[var(--muted)]">{{ configured ? t('capabilities.creatorReady') : t('capabilities.creatorModelRequired') }}</span><button class="ml-auto rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white" :disabled="creatorBusy" @click="createWithAdministrator">{{ creatorBusy ? t('capabilities.creatorWorking') : t('capabilities.creatorAsk') }}</button></div><pre v-if="creatorReply" class="mt-4 max-h-64 overflow-auto rounded-xl bg-[var(--surface-muted)] p-4 text-xs whitespace-pre-wrap">{{ creatorReply }}</pre><p v-if="creatorError" class="mt-3 text-sm text-rose-600">{{ creatorError }}</p><button v-if="draft" class="mt-4 self-end rounded-lg border border-[var(--accent)] px-3 py-2 text-sm font-semibold text-[var(--accent)]" @click="saveDraft">{{ t('capabilities.creatorApply') }}</button></article></div>
  </section>
</template>

<style scoped>
.skill-install-bar {
  background: linear-gradient(90deg, #0ea5e9, #2563eb 45%, #7c3aed);
  box-shadow: 0 0 18px rgba(37, 99, 235, 0.45);
  transition: width 0.45s cubic-bezier(0.22, 1, 0.36, 1);
}
.skill-install-shine {
  background: linear-gradient(110deg, transparent 20%, rgba(255, 255, 255, 0.35) 45%, transparent 70%);
  background-size: 220% 100%;
  animation: skill-install-shine 1.4s linear infinite;
}
@keyframes skill-install-shine {
  from { background-position: 120% 0; }
  to { background-position: -40% 0; }
}
</style>
