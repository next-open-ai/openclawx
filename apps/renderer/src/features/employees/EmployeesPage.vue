<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { Employee, EmployeeDraft, EmployeeId } from '../../app/workspace';
import { useI18n } from '../../app/i18n';
import { useCapabilities, type PolicyMode, type SkillRecord } from '../../app/capabilities';
import { chatEndpointLabel, useModelConfig } from '../../app/model-config';
import { searchProviderIds, useSearchConfig } from '../../app/search-config';
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_MAX_STEPS,
  MAX_MCP_TOOL_TIMEOUT_MS,
  MAX_RUN_TIMEOUT_MS,
  MIN_MAX_STEPS,
  MIN_MCP_TOOL_TIMEOUT_MS,
  MIN_RUN_TIMEOUT_MS,
  defaultEmployeeRuntimePrefs,
  useEmployeeRuntimePrefs,
  type EmployeeKnowledgeProvider,
  type EmployeeSearchMode,
} from '../../app/employee-prefs';
import { useNotify } from '../../app/notify';
import { mcpSummaryLine, useMcpConfig, isAssociableMcp } from '../../app/mcp-config';
import { knowledgeProviderMeta, useKnowledgeConfig } from '../../app/kb-config';
import { getServerRuntimeConfig } from '../../services/api';
import EmployeeDataObjects from './EmployeeDataObjects.vue';
import {
  EMPLOYEE_COLOR_PRESETS,
  defaultEmployeeDraft,
  draftFromEmployee,
  employeeDisplayDescription,
  employeeDisplayName,
  isEditableEmployee,
  isPresetEmployee,
} from '../../app/employees';

type EmployeeEngineChoice = '' | 'pi' | 'agentscope' | 'dsh' | 'opencode' | 'claude-code';

const props = defineProps<{
  employees: Employee[];
  selectedEmployeeId: EmployeeId;
  createEmployee: (draft: EmployeeDraft) => Promise<Employee>;
  updateEmployee: (id: EmployeeId, draft: EmployeeDraft) => Promise<Employee>;
  removeEmployee: (id: EmployeeId) => Promise<void>;
  resetEmployee: (id: EmployeeId) => Promise<void>;
  hasEmployeeOverride: (id: EmployeeId) => boolean;
}>();
const emit = defineEmits<{ startChat: [id: EmployeeId] }>();
const { t } = useI18n();
const notify = useNotify();
const selected = ref<EmployeeId | null>(null);
const savingSkillId = ref<string | null>(null);
const savingRuntime = ref(false);
const savingProfile = ref(false);
const formOpen = ref(false);
const editingId = ref<EmployeeId | null>(null);
const draft = ref(defaultEmployeeDraft());
const { skills, load, policyFor, setPolicy } = useCapabilities();
const { availableChatModels, load: loadModels, setEmployeeDefaultModel, settings: modelSettings } = useModelConfig();
const { settings: searchSettings, load: loadSearch } = useSearchConfig();
const { load: loadPrefs, get: getPrefs, set: setPrefs, reset: resetPrefs } = useEmployeeRuntimePrefs();
const { connections: mcpConnections, load: loadMcp } = useMcpConfig();
const { bases: knowledgeBases, load: loadKnowledge, isReady: isKnowledgeReady, isProviderEnabled, enabledProviders } = useKnowledgeConfig();

const draftModelId = ref('');
const draftSearchMode = ref<EmployeeSearchMode>('inherit');
const draftMaxSteps = ref(DEFAULT_MAX_STEPS);
const draftRunTimeoutSec = ref(Math.round(DEFAULT_RUN_TIMEOUT_MS / 1000));
const draftMcpToolTimeoutSec = ref(Math.round(DEFAULT_MCP_TOOL_TIMEOUT_MS / 1000));
const draftMcpIds = ref<string[]>([]);
const draftKnowledgeProvider = ref<EmployeeKnowledgeProvider>('off');
const draftKnowledgeBaseIds = ref<string[]>([]);
const draftEngine = ref<EmployeeEngineChoice>('');
const draftUseApplicationModels = ref(true);
const enabledEngines = ref<Array<'pi' | 'agentscope' | 'dsh' | 'opencode' | 'claude-code'>>(['pi', 'agentscope', 'dsh']);
const mcpPickerOpen = ref(false);
const mcpPickerDraft = ref<string[]>([]);
const skillPickerOpen = ref(false);
const skillPickerDraft = ref<string[]>([]);
const skillPickerQuery = ref('');
const savingSkills = ref(false);

const selectedEmployee = computed(() => props.employees.find((employee) => employee.id === selected.value) ?? null);
const availableMcps = computed(() => mcpConnections.value.filter((item) => isAssociableMcp(item)));
const useMcpModal = computed(() => availableMcps.value.length > 5);
const selectedMcpItems = computed(() => availableMcps.value.filter((item) => draftMcpIds.value.includes(item.id)));
const associableSkills = computed(() =>
  skills.value.filter((skill) => !(skill.systemOnly && selected.value !== 'administrator')),
);
const linkedSkills = computed(() =>
  associableSkills.value.filter((skill) => {
    const current = mode(skill.id);
    return current === 'available' || current === 'default';
  }),
);
const pickerSkills = computed(() => {
  const q = skillPickerQuery.value.trim().toLowerCase();
  if (!q) return associableSkills.value;
  return associableSkills.value.filter((skill) =>
    `${skill.name} ${skill.description} ${(skill.tags || []).join(' ')}`.toLowerCase().includes(q),
  );
});
const knowledgeProviderOptions = computed(() => [
  { value: 'off' as const, label: t('employee.kbProviderOff') },
  ...enabledProviders.value.map((item) => ({
    value: item.id,
    label: knowledgeProviderMeta[item.id].label,
  })),
]);
const availableKnowledgeBases = computed(() => {
  if (draftKnowledgeProvider.value === 'off') return [];
  return knowledgeBases.value.filter(
    (item) =>
      item.provider === draftKnowledgeProvider.value
      && isProviderEnabled(item.provider)
      && isKnowledgeReady(item),
  );
});
const canEditSelected = computed(() => selectedEmployee.value ? isEditableEmployee(selectedEmployee.value) : false);
const engineOptions = computed(() => [
  { value: '' as const, label: t('employee.engineInherit') },
  ...enabledEngines.value.map((id) => ({
    value: id,
    label: t(`employee.engine.${id}`),
  })),
]);

onMounted(async () => {
  await Promise.all([load(), loadModels(), loadSearch(), loadPrefs(), loadMcp(), loadKnowledge()]);
  try {
    const runtime = await getServerRuntimeConfig() as { enabledEngines?: string[] };
    const list = Array.isArray(runtime.enabledEngines)
      ? runtime.enabledEngines
        .map((id) => String(id).trim().toLowerCase())
        .filter((id): id is 'pi' | 'agentscope' | 'dsh' | 'opencode' | 'claude-code' => ['pi', 'agentscope', 'dsh', 'opencode', 'claude-code'].includes(id))
      : [];
    if (list.length) enabledEngines.value = [...new Set(list)];
  } catch {
    /* keep defaults */
  }
});

watch(
  selected,
  (id) => {
    if (!id) return;
    const prefs = getPrefs(id);
    const modelFromLegacy = modelSettings.value.employeeDefaultModelIds[id] || '';
    draftModelId.value = prefs.defaultModelId || modelFromLegacy || '';
    draftSearchMode.value = prefs.searchMode;
    draftMaxSteps.value = prefs.maxSteps;
    draftRunTimeoutSec.value = Math.round((prefs.runTimeoutMs || DEFAULT_RUN_TIMEOUT_MS) / 1000);
    draftMcpToolTimeoutSec.value = Math.round((prefs.mcpToolTimeoutMs || DEFAULT_MCP_TOOL_TIMEOUT_MS) / 1000);
    draftEngine.value = prefs.engine || '';
    draftUseApplicationModels.value = prefs.useApplicationModels;
    draftMcpIds.value = [...(prefs.mcpIds || [])].filter((id) =>
      mcpConnections.value.some((item) => item.id === id && isAssociableMcp(item)),
    );
    let provider = prefs.knowledgeProvider || 'off';
    const ids = [...(prefs.knowledgeBaseIds || [])];
    // Migrate legacy prefs that only stored knowledgeBaseIds.
    if (provider === 'off' && ids.length) {
      const first = knowledgeBases.value.find((item) => ids.includes(item.id));
      if (first) provider = first.provider;
    }
    draftKnowledgeProvider.value = provider;
    draftKnowledgeBaseIds.value = provider === 'off'
      ? []
      : ids.filter((id) => knowledgeBases.value.some((item) => item.id === id && item.provider === provider));
  },
);

function displayName(employee: Employee) {
  return employeeDisplayName(employee, t);
}

function displayDescription(employee: Employee) {
  return employeeDisplayDescription(employee, t);
}

function mode(skillId: string): PolicyMode {
  return selected.value ? policyFor(selected.value, skillId)?.mode ?? 'disabled' : 'disabled';
}

function skillRiskLabel(risk: SkillRecord['risk']) {
  return t(`capabilities.risk.${risk}`);
}

function skillRiskTone(risk: SkillRecord['risk']) {
  if (risk === 'high') return 'bg-rose-500/12 text-rose-700 dark:text-rose-300';
  if (risk === 'medium') return 'bg-amber-500/12 text-amber-700 dark:text-amber-300';
  return 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300';
}

function skillSourceLabel(skill: SkillRecord) {
  return t(`capabilities.source.${skill.source}`);
}

async function update(skillId: string, event: Event) {
  if (!selected.value) return;
  savingSkillId.value = skillId;
  try {
    await setPolicy(selected.value, skillId, (event.target as HTMLSelectElement).value as PolicyMode);
    notify.success('notify.saved');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    savingSkillId.value = null;
  }
}

async function unlinkSkill(skillId: string) {
  if (!selected.value) return;
  savingSkillId.value = skillId;
  try {
    await setPolicy(selected.value, skillId, 'disabled');
    notify.success('notify.saved');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    savingSkillId.value = null;
  }
}

function openSkillPicker() {
  skillPickerDraft.value = linkedSkills.value.map((skill) => skill.id);
  skillPickerQuery.value = '';
  skillPickerOpen.value = true;
}

function toggleSkillPickerDraft(id: string) {
  skillPickerDraft.value = skillPickerDraft.value.includes(id)
    ? skillPickerDraft.value.filter((item) => item !== id)
    : [...skillPickerDraft.value, id];
}

async function confirmSkillPicker() {
  if (!selected.value || savingSkills.value) return;
  savingSkills.value = true;
  try {
    const picked = new Set(skillPickerDraft.value);
    for (const skill of associableSkills.value) {
      const current = mode(skill.id);
      const wantLinked = picked.has(skill.id);
      if (wantLinked && current === 'disabled') {
        await setPolicy(selected.value, skill.id, 'available');
      } else if (!wantLinked && current !== 'disabled') {
        await setPolicy(selected.value, skill.id, 'disabled');
      }
    }
    skillPickerOpen.value = false;
    notify.success('notify.saved');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    savingSkills.value = false;
  }
}

async function saveRuntime() {
  if (!selected.value) return;
  savingRuntime.value = true;
  try {
    const modelId = draftModelId.value || null;
    await setPrefs(selected.value, {
      defaultModelId: modelId,
      searchMode: draftSearchMode.value,
      maxSteps: draftMaxSteps.value,
      runTimeoutMs: Math.round(draftRunTimeoutSec.value * 1000),
      mcpToolTimeoutMs: Math.round(draftMcpToolTimeoutSec.value * 1000),
      mcpIds: [...draftMcpIds.value],
      knowledgeProvider: draftKnowledgeProvider.value,
      knowledgeBaseIds: draftKnowledgeProvider.value === 'off' ? [] : [...draftKnowledgeBaseIds.value],
      engine: draftEngine.value || null,
      useApplicationModels: draftUseApplicationModels.value,
    });
    await setEmployeeDefaultModel(selected.value, modelId);
    notify.success('notify.employeeRuntimeSaved');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    savingRuntime.value = false;
  }
}

async function resetRuntime() {
  if (!selected.value) return;
  const defaults = defaultEmployeeRuntimePrefs();
  draftModelId.value = '';
  draftSearchMode.value = defaults.searchMode;
  draftMaxSteps.value = defaults.maxSteps;
  draftRunTimeoutSec.value = Math.round(defaults.runTimeoutMs / 1000);
  draftMcpToolTimeoutSec.value = Math.round(defaults.mcpToolTimeoutMs / 1000);
  draftMcpIds.value = [];
  draftKnowledgeProvider.value = defaults.knowledgeProvider;
  draftKnowledgeBaseIds.value = [];
  draftEngine.value = '';
  draftUseApplicationModels.value = true;
  await resetPrefs(selected.value);
  await setEmployeeDefaultModel(selected.value, null);
  notify.success('notify.employeeRuntimeReset');
}

function toggleMcp(id: string) {
  draftMcpIds.value = draftMcpIds.value.includes(id)
    ? draftMcpIds.value.filter((item) => item !== id)
    : [...draftMcpIds.value, id];
  void persistMcpSelection();
}

function openMcpPicker() {
  mcpPickerDraft.value = [...draftMcpIds.value].filter((id) => availableMcps.value.some((item) => item.id === id));
  mcpPickerOpen.value = true;
}

function toggleMcpPickerDraft(id: string) {
  mcpPickerDraft.value = mcpPickerDraft.value.includes(id)
    ? mcpPickerDraft.value.filter((item) => item !== id)
    : [...mcpPickerDraft.value, id];
}

async function persistMcpSelection() {
  if (!selected.value) return;
  try {
    await setPrefs(selected.value, { mcpIds: [...draftMcpIds.value] });
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

function confirmMcpPicker() {
  draftMcpIds.value = [...mcpPickerDraft.value];
  mcpPickerOpen.value = false;
  void persistMcpSelection().then(() => notify.success('notify.employeeRuntimeSaved'));
}

function removeSelectedMcp(id: string) {
  draftMcpIds.value = draftMcpIds.value.filter((item) => item !== id);
  void persistMcpSelection();
}

function toggleKnowledgeBase(id: string) {
  draftKnowledgeBaseIds.value = draftKnowledgeBaseIds.value.includes(id)
    ? draftKnowledgeBaseIds.value.filter((item) => item !== id)
    : [...draftKnowledgeBaseIds.value, id];
}

function onKnowledgeProviderChange() {
  if (draftKnowledgeProvider.value === 'off') {
    draftKnowledgeBaseIds.value = [];
    return;
  }
  draftKnowledgeBaseIds.value = draftKnowledgeBaseIds.value.filter((id) =>
    availableKnowledgeBases.value.some((item) => item.id === id),
  );
}

function openCreate() {
  editingId.value = null;
  draft.value = defaultEmployeeDraft();
  formOpen.value = true;
}

function openEdit(employee: Employee) {
  if (!isEditableEmployee(employee)) return;
  editingId.value = employee.id;
  draft.value = draftFromEmployee(employee, t);
  formOpen.value = true;
}

function closeForm() {
  formOpen.value = false;
  editingId.value = null;
  draft.value = defaultEmployeeDraft();
}

async function saveProfile() {
  savingProfile.value = true;
  try {
    if (editingId.value) {
      const saved = await props.updateEmployee(editingId.value, draft.value);
      selected.value = saved.id;
      notify.success('notify.employeeUpdated');
    } else {
      const saved = await props.createEmployee(draft.value);
      selected.value = saved.id;
      notify.success('notify.employeeCreated');
    }
    closeForm();
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    savingProfile.value = false;
  }
}

async function onResetPreset(employee: Employee) {
  await props.resetEmployee(employee.id);
  notify.success(t('employee.resetDone'));
}

async function onDelete(employee: Employee) {
  if (!isEditableEmployee(employee)) return;
  if (!window.confirm(t('employee.deleteConfirm', { name: displayName(employee) }))) return;
  try {
    await props.removeEmployee(employee.id);
    if (selected.value === employee.id) selected.value = null;
    notify.success('notify.employeeDeleted');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

const employeeModelSupportsBuiltinSearch = computed(() => {
  const preferredId = draftModelId.value || modelSettings.value.employeeDefaultModelIds[selected.value || ''] || modelSettings.value.activeChatModelId;
  const match = preferredId
    ? availableChatModels.value.find((item) => item.id === preferredId)
    : availableChatModels.value[0];
  return Boolean(match?.supportsBuiltinWebSearch);
});

const searchModeOptions = computed(() => {
  const base: Array<{ value: EmployeeSearchMode; label: string }> = [
    { value: 'inherit', label: t('employee.searchInherit') },
    { value: 'auto', label: t('employee.searchAuto') },
    { value: 'off', label: t('employee.searchOff') },
  ];
  if (employeeModelSupportsBuiltinSearch.value) {
    base.push({ value: 'llm-builtin', label: t('employee.searchBuiltin') });
  }
  for (const id of searchProviderIds) {
    const label = searchSettings.value.providers.find((item) => item.id === id)?.label ?? id;
    base.push({ value: id, label: `${t('employee.searchForce')} · ${label}` });
  }
  return base;
});

watch(employeeModelSupportsBuiltinSearch, (ok) => {
  if (!ok && draftSearchMode.value === 'llm-builtin') draftSearchMode.value = 'inherit';
});
</script>

<template>
  <section class="mx-auto w-full max-w-6xl px-6 py-14 sm:px-12">
    <header class="mb-9">
      <p class="mb-2 text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">OpenClawX / TEAM</p>
      <h1 class="text-4xl font-bold tracking-[-.045em]">{{ t('employee.title') }}</h1>
      <p class="mt-3 max-w-2xl leading-relaxed text-[var(--muted)]">{{ selectedEmployee ? t('employee.detailSubtitle') : t('employee.subtitle') }}</p>
    </header>

    <template v-if="!selectedEmployee">
      <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-sm font-semibold">{{ t('employee.directory') }}</p>
          <p class="mt-1 text-xs text-[var(--muted)]">{{ t('employee.directoryHelp') }}</p>
        </div>
        <button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white" type="button" @click="openCreate">
          {{ t('employee.create') }}
        </button>
      </div>
      <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <button
          v-for="employee in employees"
          :key="employee.id"
          class="group relative min-h-[190px] rounded-[18px] border border-[var(--border)] bg-[var(--surface)] p-5 text-left transition hover:-translate-y-0.5 hover:border-[var(--accent)] hover:shadow-sm"
          type="button"
          @click="selected = employee.id"
        >
          <span class="grid h-12 w-12 place-items-center rounded-2xl text-[11px] font-extrabold text-white" :style="{ background: employee.color }">{{ employee.initials }}</span>
          <div class="mt-4 flex flex-wrap items-center gap-2">
            <h2 class="text-[16px] font-bold">{{ displayName(employee) }}</h2>
            <span v-if="employee.system" class="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--accent)]">{{ t('employee.system') }}</span>
            <span v-else-if="isPresetEmployee(employee)" class="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--muted)]">{{ t('employee.preset') }}</span>
            <span v-else class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">{{ t('employee.custom') }}</span>
          </div>
          <p class="mt-2 line-clamp-3 text-[13px] leading-relaxed text-[var(--muted)]">{{ displayDescription(employee) }}</p>
          <span class="mt-5 inline-block text-sm font-semibold text-[var(--accent)]">{{ t('employee.viewDetails') }} →</span>
        </button>

        <button
          class="flex min-h-[190px] flex-col items-center justify-center rounded-[18px] border border-dashed border-[var(--border)] bg-[var(--surface)]/60 p-5 text-center transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]/30"
          type="button"
          @click="openCreate"
        >
          <span class="grid h-12 w-12 place-items-center rounded-2xl border border-dashed border-[var(--border)] text-xl text-[var(--muted)]">+</span>
          <strong class="mt-4 text-sm">{{ t('employee.create') }}</strong>
          <p class="mt-2 max-w-[14rem] text-xs leading-relaxed text-[var(--muted)]">{{ t('employee.createHint') }}</p>
        </button>
      </div>
    </template>

    <template v-else>
      <button class="mb-5 rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" @click="selected = null">← {{ t('employee.backToDirectory') }}</button>

      <section class="rounded-[20px] border border-[var(--border)] bg-[var(--surface)] p-6">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="flex gap-4">
            <span class="grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-xs font-extrabold text-white" :style="{ background: selectedEmployee.color }">{{ selectedEmployee.initials }}</span>
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-2xl font-bold">{{ displayName(selectedEmployee) }}</h2>
                <span v-if="selectedEmployee.system" class="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--accent)]">{{ t('employee.system') }}</span>
                <span v-else-if="isPresetEmployee(selectedEmployee)" class="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--muted)]">{{ t('employee.preset') }}</span>
                <span v-else class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">{{ t('employee.custom') }}</span>
              </div>
              <p class="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">{{ displayDescription(selectedEmployee) }}</p>
              <p v-if="selectedEmployee.instructions" class="mt-2 max-w-2xl text-xs leading-relaxed text-[var(--muted)]">
                <span class="font-semibold text-[var(--foreground)]">{{ t('employee.instructions') }}：</span>{{ selectedEmployee.instructions }}
              </p>
            </div>
          </div>
          <div class="flex flex-wrap gap-2">
            <button v-if="canEditSelected" class="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:border-[var(--accent)]" type="button" @click="openEdit(selectedEmployee)">
              {{ t('employee.edit') }}
            </button>
            <button v-if="canEditSelected && !isPresetEmployee(selectedEmployee)" class="rounded-lg px-3 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-500/10" type="button" @click="onDelete(selectedEmployee)">
              {{ t('employee.delete') }}
            </button>
            <button v-if="isPresetEmployee(selectedEmployee) && props.hasEmployeeOverride(selectedEmployee.id)" class="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:border-[var(--accent)]" type="button" @click="onResetPreset(selectedEmployee)">
              {{ t('employee.resetPreset') }}
            </button>
            <button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white" type="button" @click="emit('startChat', selectedEmployee.id)">{{ t('employee.start') }}</button>
          </div>
        </div>

        <p v-if="isPresetEmployee(selectedEmployee)" class="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--muted)]">
          {{ t('employee.presetLockedHelp') }}
        </p>

        <div class="mt-8 border-t border-[var(--border)] pt-6">
          <p class="text-[11px] font-extrabold tracking-[.12em] text-[var(--accent)]">{{ t('employee.runtimeSection') }}</p>
          <h3 class="mt-1 text-lg font-bold">{{ t('employee.runtimeTitle') }}</h3>
          <p class="mt-1 text-sm text-[var(--muted)]">{{ t('employee.runtimeHelp') }}</p>

          <div class="mt-5 grid gap-4 sm:grid-cols-2">
            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.defaultModel') }}</span>
              <select v-model="draftModelId" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal">
                <option value="">{{ t('employee.modelInherit') }}</option>
                <option v-for="model in availableChatModels" :key="model.id" :value="model.id">{{ chatEndpointLabel(model) }}</option>
              </select>
              <span class="font-normal text-[11px]">{{ t('employee.modelInheritHelp') }}</span>
            </label>

            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.searchMode') }}</span>
              <select v-model="draftSearchMode" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal">
                <option v-for="option in searchModeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
              <span class="font-normal text-[11px]">{{ t('employee.searchModeHelp') }}</span>
            </label>

            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.engine') }}</span>
              <select v-model="draftEngine" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal">
                <option v-for="option in engineOptions" :key="option.value || 'inherit'" :value="option.value">{{ option.label }}</option>
              </select>
              <span class="font-normal text-[11px]">{{ t('employee.engineHelp') }}</span>
            </label>

            <label class="flex items-center justify-between gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 sm:col-span-2">
              <span><strong class="block text-sm text-[var(--text)]">使用应用模型</strong><span class="mt-1 block text-[11px] font-normal leading-relaxed text-[var(--muted)]">开启后，自动向该智能体提供已配置的图片、语音、向量、视觉和其他专业模型；由智能体按任务需要调用。</span></span>
              <input v-model="draftUseApplicationModels" class="h-5 w-5 shrink-0" type="checkbox" />
            </label>

            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)] sm:col-span-2">
              <span>{{ t('employee.maxSteps') }}</span>
              <div class="flex flex-wrap items-center gap-3">
                <input
                  v-model.number="draftMaxSteps"
                  class="w-28 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal"
                  type="number"
                  :min="MIN_MAX_STEPS"
                  :max="MAX_MAX_STEPS"
                />
                <span class="font-normal text-[11px]">{{ t('employee.maxStepsHelp', { def: DEFAULT_MAX_STEPS, min: MIN_MAX_STEPS, max: MAX_MAX_STEPS }) }}</span>
              </div>
            </label>

            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.runTimeout') }}</span>
              <div class="flex flex-wrap items-center gap-3">
                <input
                  v-model.number="draftRunTimeoutSec"
                  class="w-28 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal"
                  type="number"
                  :min="Math.round(MIN_RUN_TIMEOUT_MS / 1000)"
                  :max="Math.round(MAX_RUN_TIMEOUT_MS / 1000)"
                  step="30"
                />
                <span class="font-normal text-[11px]">{{ t('employee.runTimeoutHelp', { def: Math.round(DEFAULT_RUN_TIMEOUT_MS / 1000), min: Math.round(MIN_RUN_TIMEOUT_MS / 1000), max: Math.round(MAX_RUN_TIMEOUT_MS / 1000) }) }}</span>
              </div>
            </label>

            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.mcpToolTimeout') }}</span>
              <div class="flex flex-wrap items-center gap-3">
                <input
                  v-model.number="draftMcpToolTimeoutSec"
                  class="w-28 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal"
                  type="number"
                  :min="Math.round(MIN_MCP_TOOL_TIMEOUT_MS / 1000)"
                  :max="Math.round(MAX_MCP_TOOL_TIMEOUT_MS / 1000)"
                  step="5"
                />
                <span class="font-normal text-[11px]">{{ t('employee.mcpToolTimeoutHelp', { def: Math.round(DEFAULT_MCP_TOOL_TIMEOUT_MS / 1000), min: Math.round(MIN_MCP_TOOL_TIMEOUT_MS / 1000), max: Math.round(MAX_MCP_TOOL_TIMEOUT_MS / 1000) }) }}</span>
              </div>
            </label>

            <EmployeeDataObjects v-if="selected" :key="selected" :employee-id="selected" :engine="draftEngine" />
            <div class="grid gap-1.5 text-xs font-semibold text-[var(--muted)] sm:col-span-2">
              <span>{{ t('employee.mcpTitle') }}</span>
              <p class="font-normal text-[11px]">{{ t('employee.mcpHelp') }}</p>
              <p class="font-normal text-[11px] text-[var(--muted)]">{{ t('employee.mcpScopeHelp') }}</p>
              <p v-if="!availableMcps.length" class="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 font-normal text-[var(--muted)]">
                {{ t('employee.mcpEmpty') }}
              </p>
              <template v-else-if="!useMcpModal">
                <div class="grid gap-2 sm:grid-cols-2">
                  <button
                    v-for="item in availableMcps"
                    :key="item.id"
                    type="button"
                    :class="[
                      'rounded-xl border px-3 py-3 text-left text-xs font-semibold transition',
                      draftMcpIds.includes(item.id)
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--muted)] hover:border-[var(--accent)]/40',
                    ]"
                    @click="toggleMcp(item.id)"
                  >
                    <span class="block">{{ item.name }}</span>
                    <span class="mt-0.5 block truncate font-mono text-[10px] opacity-70">{{ mcpSummaryLine(item) }}</span>
                  </button>
                </div>
              </template>
              <template v-else>
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white"
                    type="button"
                    @click="openMcpPicker"
                  >
                    {{ t('employee.mcpPick') }}
                  </button>
                  <span class="font-normal text-[11px] text-[var(--muted)]">
                    {{ t('employee.mcpSelectedCount', { n: selectedMcpItems.length }) }}
                  </span>
                </div>
                <div v-if="selectedMcpItems.length" class="mt-2 flex flex-wrap gap-2">
                  <span
                    v-for="item in selectedMcpItems"
                    :key="item.id"
                    class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--accent)]"
                  >
                    {{ item.name }}
                    <button class="text-sm leading-none opacity-70 hover:opacity-100" type="button" @click="removeSelectedMcp(item.id)">×</button>
                  </span>
                </div>
              </template>
            </div>

            <div class="grid gap-1.5 text-xs font-semibold text-[var(--muted)] sm:col-span-2">
              <span>{{ t('employee.kbTitle') }}</span>
              <p class="font-normal text-[11px]">{{ t('employee.kbHelp') }}</p>
              <label class="mt-1 grid gap-1.5 font-semibold">
                <span>{{ t('employee.kbProvider') }}</span>
                <select
                  v-model="draftKnowledgeProvider"
                  class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal"
                  @change="onKnowledgeProviderChange"
                >
                  <option v-for="option in knowledgeProviderOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <span class="font-normal text-[11px]">{{ t('employee.kbProviderHelp') }}</span>
              </label>
              <template v-if="draftKnowledgeProvider !== 'off'">
                <p class="mt-2 font-semibold">{{ t('employee.kbPick') }}</p>
                <p v-if="!availableKnowledgeBases.length" class="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 font-normal text-[var(--muted)]">
                  {{ t('employee.kbEmptyForProvider', { provider: knowledgeProviderMeta[draftKnowledgeProvider].label }) }}
                </p>
                <div v-else class="flex flex-wrap gap-2">
                  <button
                    v-for="item in availableKnowledgeBases"
                    :key="item.id"
                    type="button"
                    :class="[
                      'rounded-lg border px-3 py-2 text-left text-xs font-semibold transition',
                      draftKnowledgeBaseIds.includes(item.id)
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--muted)] hover:border-[var(--accent)]/40',
                    ]"
                    @click="toggleKnowledgeBase(item.id)"
                  >
                    <span class="block">{{ item.name }}</span>
                    <span class="mt-0.5 block truncate text-[10px] opacity-70">{{ item.description || item.id }}</span>
                  </button>
                </div>
              </template>
            </div>
          </div>

          <div class="mt-4 flex flex-wrap gap-2">
            <button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" :disabled="savingRuntime" @click="saveRuntime">
              {{ savingRuntime ? t('employee.saving') : t('employee.saveRuntime') }}
            </button>
            <button class="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold" type="button" :disabled="savingRuntime" @click="resetRuntime">
              {{ t('employee.resetRuntime') }}
            </button>
          </div>
        </div>

        <div class="mt-8 border-t border-[var(--border)] pt-6">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="text-[11px] font-extrabold tracking-[.12em] text-[var(--accent)]">{{ t('employee.skillPolicy') }}</p>
              <h3 class="mt-1 text-lg font-bold">{{ t('employee.capabilityTitle') }}</h3>
              <p class="mt-1 text-sm text-[var(--muted)]">{{ t('employee.skillPolicyHelp') }}</p>
              <p class="mt-1 text-[11px] text-[var(--muted)]">{{ t('employee.skillPolicyScopeHelp') }}</p>
            </div>
            <button
              class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
              type="button"
              :disabled="!associableSkills.length"
              @click="openSkillPicker"
            >
              {{ t('employee.skillPick') }}
            </button>
          </div>

          <p v-if="!linkedSkills.length" class="mt-4 rounded-xl border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--muted)]">
            {{ t('employee.skillLinkedEmpty') }}
          </p>
          <div v-else class="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            <article
              v-for="skill in linkedSkills"
              :key="skill.id"
              class="flex flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 transition hover:border-[var(--accent)]/25"
            >
              <div class="flex items-start justify-between gap-2">
                <h4 class="min-w-0 flex-1 truncate text-sm font-bold">{{ skill.name }}</h4>
                <button
                  class="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-[var(--muted)] hover:bg-rose-500/10 hover:text-rose-600"
                  type="button"
                  :disabled="savingSkillId === skill.id"
                  :title="t('employee.skillUnlink')"
                  @click="unlinkSkill(skill.id)"
                >×</button>
              </div>
              <p class="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--muted)]">{{ skill.description }}</p>
              <div class="mt-2 flex flex-wrap items-center gap-1 text-[10px]">
                <span :class="['rounded-md px-1.5 py-0.5 font-semibold', skillRiskTone(skill.risk)]">{{ skillRiskLabel(skill.risk) }}</span>
                <span class="rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-[var(--muted)]">{{ skillSourceLabel(skill) }}</span>
                <span v-for="tag in (skill.tags || []).slice(0, 2)" :key="tag" class="rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-[var(--muted)]">{{ tag }}</span>
              </div>
              <select
                class="mt-3 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-1.5 text-[11px]"
                :value="mode(skill.id)"
                :disabled="savingSkillId === skill.id || Boolean(skill.systemOnly && selectedEmployee.id !== 'administrator')"
                @change="update(skill.id, $event)"
              >
                <option value="available">{{ t('employee.skillAvailable') }}</option>
                <option value="default">{{ t('employee.skillDefault') }}</option>
                <option value="disabled">{{ t('employee.skillUnlink') }}</option>
              </select>
            </article>
          </div>
          <p class="mt-3 text-[11px] text-[var(--muted)]">{{ t('employee.skillLinkedCount', { n: linkedSkills.length }) }}</p>
        </div>
      </section>
    </template>

    <div v-if="formOpen" class="fixed inset-0 z-40 grid place-items-center bg-slate-950/40 p-5" @click.self="closeForm">
      <article class="flex max-h-[min(86vh,720px)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header class="flex items-start justify-between gap-3 border-b border-[var(--border)] px-6 py-4">
          <div>
            <p class="text-[10px] font-extrabold tracking-[.14em] text-[var(--accent)]">EMPLOYEE · PROFILE</p>
            <h2 class="mt-1 text-xl font-bold tracking-[-.02em]">{{ editingId ? t('employee.edit') : t('employee.create') }}</h2>
            <p class="mt-1 text-xs leading-relaxed text-[var(--muted)]">{{ t('employee.formHelp') }}</p>
          </div>
          <button class="grid h-8 w-8 place-items-center rounded-lg text-xl text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" @click="closeForm">×</button>
        </header>

        <form id="employee-profile-form" class="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5" @submit.prevent="saveProfile">
          <div class="space-y-4">
            <label class="block text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.formName') }}</span>
              <input
                v-model.trim="draft.name"
                class="mt-1.5 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3.5 py-2.5 text-sm font-normal outline-none transition focus:border-[var(--accent)]"
                required
                maxlength="48"
              />
            </label>
            <label class="block text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.formDescription') }}</span>
              <textarea
                v-model.trim="draft.description"
                rows="3"
                class="mt-1.5 w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--background)] px-3.5 py-2.5 text-sm font-normal outline-none transition focus:border-[var(--accent)]"
                required
                maxlength="240"
              />
            </label>
            <label class="block text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.formInstructions') }}</span>
              <textarea
                v-model.trim="draft.instructions"
                rows="4"
                class="mt-1.5 w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--background)] px-3.5 py-2.5 text-sm font-normal outline-none transition focus:border-[var(--accent)]"
                :placeholder="t('employee.formInstructionsHint')"
                maxlength="1200"
              />
              <span class="mt-1.5 block text-[11px] font-normal leading-4 text-[var(--muted)]">{{ t('employee.formInstructionsHelp') }}</span>
            </label>
          </div>

          <div class="grid gap-4 sm:grid-cols-[150px_1fr]">
            <label class="block text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.formInitials') }}</span>
              <input
                v-model.trim="draft.initials"
                class="mt-1.5 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3.5 py-2.5 text-center text-sm font-semibold uppercase outline-none transition focus:border-[var(--accent)]"
                maxlength="4"
              />
            </label>
            <div class="text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.formColor') }}</span>
              <div class="mt-2 flex flex-wrap gap-2.5">
                <button
                  v-for="color in EMPLOYEE_COLOR_PRESETS"
                  :key="color"
                  type="button"
                  :aria-label="color"
                  :class="[
                    'grid h-9 w-9 place-items-center rounded-full text-xs font-bold text-white transition',
                    draft.color === color ? 'scale-110 ring-2 ring-[var(--foreground)] ring-offset-2 ring-offset-[var(--surface)]' : 'ring-1 ring-transparent hover:ring-[var(--border)]',
                  ]"
                  :style="{ background: color }"
                  @click="draft.color = color"
                >{{ draft.color === color ? '✓' : '' }}</button>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)]/50 px-4 py-3.5">
            <span class="grid h-12 w-12 shrink-0 place-items-center rounded-2xl text-sm font-extrabold text-white" :style="{ background: draft.color }">{{ (draft.initials || draft.name || 'AI').slice(0, 4) }}</span>
            <div class="min-w-0">
              <strong class="block truncate text-sm font-semibold">{{ draft.name || t('employee.formName') }}</strong>
              <p class="mt-0.5 truncate text-xs text-[var(--muted)]">{{ draft.description || t('employee.formDescription') }}</p>
            </div>
            <span class="ml-auto shrink-0 rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] font-semibold text-[var(--muted)]">{{ editingId ? t('employee.edit') : t('employee.new') }}</span>
          </div>
        </form>

        <footer class="flex items-center justify-end gap-2 border-t border-[var(--border)] px-6 py-4">
          <button class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" @click="closeForm">{{ t('common.cancel') }}</button>
          <button class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50" type="submit" form="employee-profile-form" :disabled="savingProfile">
            {{ savingProfile ? t('employee.saving') : t('employee.saveProfile') }}
          </button>
        </footer>
      </article>
    </div>

    <div v-if="mcpPickerOpen" class="fixed inset-0 z-40 grid place-items-center bg-slate-950/40 p-5" @click.self="mcpPickerOpen = false">
      <article class="flex max-h-[min(85vh,640px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header class="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 class="text-lg font-bold">{{ t('employee.mcpPickTitle') }}</h2>
            <p class="mt-1 text-xs text-[var(--muted)]">{{ t('employee.mcpPickHelp') }}</p>
          </div>
          <button class="text-xl text-[var(--muted)]" type="button" @click="mcpPickerOpen = false">×</button>
        </header>
        <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          <button
            v-for="item in availableMcps"
            :key="item.id"
            type="button"
            :class="[
              'flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition',
              mcpPickerDraft.includes(item.id)
                ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                : 'border-[var(--border)] hover:border-[var(--accent)]/40',
            ]"
            @click="toggleMcpPickerDraft(item.id)"
          >
            <span
              class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border text-[11px] font-bold"
              :class="mcpPickerDraft.includes(item.id) ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--border)] text-transparent'"
            >✓</span>
            <span class="min-w-0 flex-1">
              <strong class="block text-sm">{{ item.name }}</strong>
              <span class="mt-0.5 block truncate font-mono text-[11px] text-[var(--muted)]">{{ mcpSummaryLine(item) }}</span>
            </span>
          </button>
        </div>
        <footer class="flex items-center justify-between gap-3 border-t border-[var(--border)] bg-[var(--surface-muted)]/50 px-5 py-3">
          <span class="text-[11px] text-[var(--muted)]">{{ t('employee.mcpSelectedCount', { n: mcpPickerDraft.length }) }}</span>
          <div class="flex gap-2">
            <button class="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold" type="button" @click="mcpPickerOpen = false">{{ t('common.cancel') }}</button>
            <button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white" type="button" @click="confirmMcpPicker">{{ t('employee.mcpPickConfirm') }}</button>
          </div>
        </footer>
      </article>
    </div>

    <div v-if="skillPickerOpen" class="fixed inset-0 z-40 grid place-items-center bg-slate-950/40 p-5" @click.self="skillPickerOpen = false">
      <article class="flex max-h-[min(88vh,720px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header class="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 class="text-lg font-bold">{{ t('employee.skillPickTitle') }}</h2>
            <p class="mt-1 text-xs text-[var(--muted)]">{{ t('employee.skillPickHelp') }}</p>
          </div>
          <button class="text-xl text-[var(--muted)]" type="button" @click="skillPickerOpen = false">×</button>
        </header>
        <div class="border-b border-[var(--border)] px-5 py-3">
          <input
            v-model="skillPickerQuery"
            class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm"
            :placeholder="t('employee.skillPickSearch')"
          />
        </div>
        <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          <p v-if="!pickerSkills.length" class="rounded-xl border border-dashed border-[var(--border)] px-4 py-10 text-center text-sm text-[var(--muted)]">
            {{ t('employee.skillPickEmpty') }}
          </p>
          <button
            v-for="skill in pickerSkills"
            :key="skill.id"
            type="button"
            :class="[
              'flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition',
              skillPickerDraft.includes(skill.id)
                ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                : 'border-[var(--border)] hover:border-[var(--accent)]/40',
            ]"
            @click="toggleSkillPickerDraft(skill.id)"
          >
            <span
              class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border text-[11px] font-bold"
              :class="skillPickerDraft.includes(skill.id) ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--border)] text-transparent'"
            >✓</span>
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center gap-1.5">
                <strong class="text-sm">{{ skill.name }}</strong>
                <span :class="['rounded-md px-1.5 py-0.5 text-[10px] font-semibold', skillRiskTone(skill.risk)]">{{ skillRiskLabel(skill.risk) }}</span>
                <span class="rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">{{ skillSourceLabel(skill) }}</span>
              </span>
              <span class="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-[var(--muted)]">{{ skill.description }}</span>
              <span v-if="(skill.tags || []).length" class="mt-1.5 flex flex-wrap gap-1">
                <span v-for="tag in skill.tags.slice(0, 4)" :key="tag" class="rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">{{ tag }}</span>
              </span>
            </span>
          </button>
        </div>
        <footer class="flex items-center justify-between gap-3 border-t border-[var(--border)] bg-[var(--surface-muted)]/50 px-5 py-3">
          <span class="text-[11px] text-[var(--muted)]">{{ t('employee.skillSelectedCount', { n: skillPickerDraft.length }) }}</span>
          <div class="flex gap-2">
            <button class="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold" type="button" @click="skillPickerOpen = false">{{ t('common.cancel') }}</button>
            <button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" :disabled="savingSkills" @click="confirmSkillPicker">
              {{ savingSkills ? t('employee.saving') : t('employee.skillPickConfirm') }}
            </button>
          </div>
        </footer>
      </article>
    </div>
  </section>
</template>
