<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ChatScheduleState, Employee, EmployeeId, ScheduleTaskRun } from '../../app/workspace';
import { employeeDisplayName } from '../../app/employees';
import { useI18n } from '../../app/i18n';
import ProjectDagPreview from '../projects/ProjectDagPreview.vue';

const props = defineProps<{
  schedule: ChatScheduleState;
  employees: Employee[];
}>();

const emit = defineEmits<{
  selectTask: [taskId: string];
}>();

const { t } = useI18n();
const dagExpanded = ref(false);
const detailOpen = ref(false);

const isPlanning = computed(() => props.schedule.status === 'planning');
const isLive = computed(() => props.schedule.status === 'planning' || props.schedule.status === 'running');

const dagTasks = computed(() =>
  props.schedule.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    subtitle: employeeName(task.employeeId),
    status: task.status,
    dependsOn: task.dependsOn,
  })),
);

const selectedTask = computed(() =>
  props.schedule.tasks.find((task) => task.id === props.schedule.selectedTaskId) ?? null,
);

const runningCount = computed(() => props.schedule.tasks.filter((task) => task.status === 'running').length);
const completedCount = computed(() => props.schedule.tasks.filter((task) => task.status === 'completed').length);

const statusLabel = computed(() => {
  const map: Record<ChatScheduleState['status'], string> = {
    planning: t('chat.autoSchedulePlanning'),
    running: t('chat.autoScheduleRunning'),
    completed: t('chat.autoScheduleCompleted'),
    failed: t('chat.autoScheduleFailed'),
    cancelled: t('chat.autoScheduleCancelled'),
  };
  return map[props.schedule.status];
});

const planningHints = computed(() => [
  t('chat.autoSchedulePlanHint1'),
  t('chat.autoSchedulePlanHint2'),
  t('chat.autoSchedulePlanHint3'),
]);

watch(
  () => props.schedule.status,
  (status) => {
    // New planning round: keep the rail, do not reopen agent detail overlay.
    if (status === 'planning') detailOpen.value = false;
  },
);

function employeeName(id: EmployeeId) {
  const employee = props.employees.find((item) => item.id === id);
  return employee ? employeeDisplayName(employee, t) : id;
}

function employeeColor(id: EmployeeId) {
  return props.employees.find((item) => item.id === id)?.color || 'var(--accent)';
}

function employeeInitials(id: EmployeeId) {
  const raw = props.employees.find((item) => item.id === id)?.initials || id.slice(0, 2);
  return String(raw).slice(0, 2).toUpperCase();
}

/** Repair summaries corrupted by per-chunk newlines (vertical CJK columns). */
function formatScheduleSummary(raw: string) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  const lines = text.split('\n');
  const shortLines = lines.filter((line) => line.trim().length > 0 && line.trim().length <= 12).length;
  const nonEmpty = lines.filter((line) => line.trim().length > 0).length;
  // If most lines are tiny fragments, rejoin into readable paragraphs.
  if (nonEmpty >= 4 && shortLines / nonEmpty >= 0.6) {
    return lines
      .map((line) => line.trim())
      .filter(Boolean)
      .join('')
      .replace(/([。！？；!?;])\s*/g, '$1\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return text.replace(/\n{3,}/g, '\n\n');
}

const detailSummary = computed(() => formatScheduleSummary(selectedTask.value?.summary || ''));

function taskStateLabel(task: ScheduleTaskRun) {
  return ({
    queued: '排队',
    running: '执行中',
    completed: '完成',
    failed: '失败',
    cancelled: '取消',
  } as const)[task.status];
}

function statusDotClass(status: ScheduleTaskRun['status']) {
  return ({
    queued: 'bg-[var(--muted)]',
    running: 'bg-[var(--accent)] schedule-dot-live',
    completed: 'bg-emerald-500',
    failed: 'bg-rose-500',
    cancelled: 'bg-amber-500',
  } as const)[status];
}

function statusClass(status: ScheduleTaskRun['status']) {
  return ({
    queued: 'bg-[var(--surface-muted)] text-[var(--muted)]',
    running: 'bg-[var(--accent-soft)] text-[var(--accent)]',
    completed: 'bg-emerald-500/10 text-emerald-700',
    failed: 'bg-rose-500/10 text-rose-700',
    cancelled: 'bg-amber-500/10 text-amber-700',
  } as const)[status];
}

function tileClass(task: ScheduleTaskRun) {
  // Highlight running agents on the rail; detail overlay only opens on explicit click.
  if (selectedTask.value?.id === task.id && detailOpen.value) {
    return 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm';
  }
  if (task.status === 'running') {
    return 'border-[var(--accent)]/55 bg-[var(--accent-soft)]/50 schedule-tile-running';
  }
  if (task.status === 'completed') {
    return 'border-emerald-400/35 bg-emerald-500/5';
  }
  if (task.status === 'failed') {
    return 'border-rose-400/40 bg-rose-500/5';
  }
  return 'border-[var(--border)] bg-[var(--surface-muted)]/45 hover:border-[var(--accent)]/40 hover:bg-[var(--accent-soft)]/35';
}

function selectTask(taskId: string) {
  emit('selectTask', taskId);
  detailOpen.value = true;
}

function closeDetail() {
  detailOpen.value = false;
}
</script>

<template>
  <aside class="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
    <header class="shrink-0 border-b border-[var(--border)] px-3.5 py-3">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <p class="text-[10px] font-bold tracking-[0.14em] text-[var(--accent)]">AUTO SCHEDULE</p>
          <p class="mt-0.5 truncate text-sm font-semibold">{{ statusLabel }}</p>
        </div>
        <span
          :class="[
            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold',
            isLive ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-[var(--surface-muted)] text-[var(--muted)]',
          ]"
        >
          <template v-if="isPlanning">{{ t('chat.autoSchedulePlanningBadge') }}</template>
          <template v-else>{{ schedule.tasks.length }} {{ t('chat.autoScheduleTasks') }}</template>
        </span>
      </div>
      <div v-if="!isPlanning && schedule.tasks.length" class="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-muted)]">
        <div
          class="h-full rounded-full bg-gradient-to-r from-sky-500 via-indigo-500 to-emerald-400 transition-all duration-500"
          :style="{ width: `${Math.max(6, Math.round((completedCount / schedule.tasks.length) * 100))}%` }"
        />
      </div>
      <p v-if="!isPlanning && schedule.tasks.length" class="mt-1.5 text-[10px] text-[var(--muted)]">
        {{ completedCount }}/{{ schedule.tasks.length }}
        <span v-if="runningCount"> · {{ runningCount }} {{ t('chat.autoScheduleRunningNow') }}</span>
      </p>
    </header>

    <!-- Planning theater -->
    <div v-if="isPlanning" class="schedule-plan flex min-h-0 flex-1 flex-col overflow-hidden">
      <div class="relative flex flex-1 flex-col items-center justify-center px-4 py-6">
        <div class="schedule-plan-orb" aria-hidden="true">
          <i class="schedule-plan-ring schedule-plan-ring-a" />
          <i class="schedule-plan-ring schedule-plan-ring-b" />
          <i class="schedule-plan-ring schedule-plan-ring-c" />
          <span class="schedule-plan-core">
            <span class="schedule-plan-core-glow" />
            DAG
          </span>
          <i class="schedule-plan-sat schedule-plan-sat-1" />
          <i class="schedule-plan-sat schedule-plan-sat-2" />
          <i class="schedule-plan-sat schedule-plan-sat-3" />
        </div>
        <p class="mt-5 text-center text-sm font-bold tracking-wide">{{ t('chat.autoSchedulePlanningTitle') }}</p>
        <p class="mt-1.5 max-w-[220px] text-center text-[11px] leading-5 text-[var(--muted)]">
          {{ t('chat.autoSchedulePlanningDesc') }}
        </p>
        <div class="mt-5 w-full max-w-[220px] space-y-2">
          <div
            v-for="(hint, index) in planningHints"
            :key="hint"
            class="schedule-plan-hint"
            :style="{ animationDelay: `${index * 0.35}s` }"
          >
            <span class="schedule-plan-hint-dot" />
            <span>{{ hint }}</span>
          </div>
        </div>
        <div class="schedule-plan-scan" aria-hidden="true" />
      </div>
      <div class="shrink-0 border-t border-[var(--border)] px-3.5 py-3">
        <div class="flex items-center gap-2">
          <span class="schedule-plan-bars" aria-hidden="true">
            <i /><i /><i /><i /><i />
          </span>
          <p class="text-[11px] font-semibold text-[var(--accent)]">{{ t('chat.autoSchedulePlanningPulse') }}</p>
        </div>
      </div>
    </div>

    <template v-else>
      <div class="shrink-0 border-b border-[var(--border)] p-3">
        <div class="mb-2 flex items-center justify-between gap-2">
          <p class="text-[10px] font-bold tracking-wide text-[var(--muted)]">{{ t('chat.autoScheduleDag') }}</p>
          <button
            class="rounded-md border border-[var(--border)] px-2 py-0.5 text-[10px] font-semibold hover:border-[var(--accent)] hover:text-[var(--accent)]"
            type="button"
            @click="dagExpanded = true"
          >{{ t('chat.autoScheduleExpandDag') }}</button>
        </div>
        <button
          class="block w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)] text-left shadow-sm transition hover:border-[var(--accent)]/35"
          type="button"
          @click="dagExpanded = true"
        >
          <ProjectDagPreview :tasks="dagTasks" mini bare :live="isLive" />
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-3">
        <p class="mb-2 text-[10px] font-bold tracking-wide text-[var(--muted)]">{{ t('chat.autoScheduleAgents') }}</p>
        <div class="grid grid-cols-2 gap-2">
          <button
            v-for="task in schedule.tasks"
            :key="task.id"
            type="button"
            :title="`${employeeName(task.employeeId)} · ${task.title} · ${taskStateLabel(task)}`"
            :class="['group relative flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center transition', tileClass(task)]"
            @click="selectTask(task.id)"
          >
            <span
              class="relative grid h-12 w-12 place-items-center rounded-xl text-[12px] font-extrabold text-white shadow-sm"
              :style="{ background: employeeColor(task.employeeId) }"
            >
              <svg
                v-if="task.status === 'running'"
                class="schedule-progress absolute inset-[-4px]"
                viewBox="0 0 48 48"
                aria-hidden="true"
              >
                <circle cx="24" cy="24" r="21" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="3" />
                <circle
                  class="schedule-progress-arc"
                  cx="24"
                  cy="24"
                  r="21"
                  fill="none"
                  stroke="rgba(255,255,255,0.95)"
                  stroke-width="3"
                  stroke-linecap="round"
                  stroke-dasharray="40 92"
                />
              </svg>
              <i v-if="task.status === 'running'" class="openclawx-run-spin" />
              <i v-if="task.status === 'running'" class="openclawx-run-pulse" />
              <i v-if="task.status === 'completed'" class="schedule-check" />
              {{ employeeInitials(task.employeeId) }}
              <span :class="['absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white', statusDotClass(task.status)]" />
            </span>
            <span class="w-full truncate text-[11px] font-semibold leading-4">{{ employeeName(task.employeeId) }}</span>
            <span :class="['rounded-full px-1.5 py-0.5 text-[9px] font-bold', statusClass(task.status)]">{{ taskStateLabel(task) }}</span>
          </button>
        </div>
      </div>
    </template>

    <!-- Right drawer for agent detail -->
    <div
      v-if="detailOpen && selectedTask"
      class="fixed inset-0 z-40 flex justify-end bg-black/25"
      @click.self="closeDetail"
    >
      <aside class="flex h-full w-full max-w-md flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header class="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3.5">
          <div class="min-w-0">
            <p class="text-[10px] font-bold tracking-[0.12em] text-[var(--accent)]">AGENT DETAIL</p>
            <div class="mt-2 flex items-center gap-2.5">
              <span
                class="relative grid h-10 w-10 place-items-center rounded-xl text-[11px] font-extrabold text-white"
                :style="{ background: employeeColor(selectedTask.employeeId) }"
              >
                <i v-if="selectedTask.status === 'running'" class="openclawx-run-spin" />
                {{ employeeInitials(selectedTask.employeeId) }}
                <span :class="['absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-white', statusDotClass(selectedTask.status)]" />
              </span>
              <div class="min-w-0">
                <h2 class="truncate text-base font-bold">{{ employeeName(selectedTask.employeeId) }}</h2>
                <span :class="['mt-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold', statusClass(selectedTask.status)]">
                  <i :class="['h-1.5 w-1.5 rounded-full', statusDotClass(selectedTask.status)]" />
                  {{ taskStateLabel(selectedTask) }}
                </span>
              </div>
            </div>
          </div>
          <button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold" type="button" @click="closeDetail">
            {{ t('chat.autoScheduleClose') }}
          </button>
        </header>
        <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <article class="rounded-2xl border border-[var(--border)] p-4">
            <h3 class="text-sm font-bold">{{ selectedTask.title }}</h3>
            <div class="mt-2 rounded-xl border border-[var(--border)]/80 bg-[var(--surface-muted)]/40 px-3 py-2">
              <p class="text-[10px] font-bold tracking-wide text-[var(--muted)]">任务目标</p>
              <p class="mt-1 text-xs leading-5 text-[var(--text)]">{{ selectedTask.objective }}</p>
            </div>
            <p v-if="selectedTask.error" class="mt-3 rounded-lg bg-rose-500/10 px-2.5 py-2 text-xs text-rose-700">{{ selectedTask.error }}</p>
            <div v-if="detailSummary" class="mt-3 min-w-0">
              <p class="text-[10px] font-bold tracking-wide text-[var(--muted)]">执行进展</p>
              <div
                class="mt-1.5 max-h-[42vh] w-full min-w-0 overflow-y-auto break-words rounded-xl bg-[var(--surface-muted)] p-3 text-xs leading-6 text-[var(--text)] whitespace-pre-wrap [overflow-wrap:anywhere]"
              >{{ detailSummary }}</div>
            </div>
            <p v-else class="mt-3 text-xs text-[var(--muted)]">{{ t('chat.autoScheduleNoOutput') }}</p>
            <div v-if="selectedTask.activities?.length" class="mt-3 space-y-1">
              <p class="text-[10px] font-bold tracking-wide text-[var(--muted)]">工具活动 · {{ selectedTask.activities.length }}</p>
              <p
                v-for="(activity, index) in selectedTask.activities"
                :key="`${activity.toolName}-${index}`"
                class="rounded-lg bg-[var(--surface-muted)] px-2 py-1.5 text-[11px]"
              >
                <strong>{{ activity.toolName }}</strong> · {{ activity.status }}
                <span v-if="activity.summary" class="text-[var(--muted)]"> · {{ activity.summary }}</span>
              </p>
            </div>
            <div v-if="selectedTask.assets?.length" class="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/40 p-3 text-xs">
              <p class="font-bold">交付资产 · {{ selectedTask.assets.length }}</p>
              <ul class="mt-1.5 space-y-1 text-[var(--muted)]">
                <li v-for="asset in selectedTask.assets" :key="asset.id" class="truncate">{{ asset.name }}</li>
              </ul>
            </div>
            <p
              v-else-if="selectedTask.status === 'running'"
              class="mt-3 rounded-lg border border-dashed border-[var(--border)] px-2.5 py-2 text-[11px] leading-5 text-[var(--muted)]"
            >
              任务仍在执行中。成品需写入 <code class="rounded bg-[var(--surface-muted)] px-1">output/</code>，通常在本节点结束后才会归档到对话资产区。
            </p>
          </article>
        </div>
      </aside>
    </div>

    <div v-if="dagExpanded" class="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4" @click.self="dagExpanded = false">
      <div class="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <div class="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div>
            <p class="text-[10px] font-bold tracking-[0.12em] text-[var(--accent)]">DAG FLOW</p>
            <p class="text-sm font-bold">{{ t('chat.autoScheduleDag') }}</p>
          </div>
          <button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold" type="button" @click="dagExpanded = false">{{ t('chat.autoScheduleClose') }}</button>
        </div>
        <div class="p-3">
          <ProjectDagPreview :tasks="dagTasks" compact :live="isLive || schedule.status === 'completed'" />
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.openclawx-run-spin,
.openclawx-run-pulse {
  pointer-events: none;
  position: absolute;
  inset: -3px;
  border-radius: 10px;
}
.openclawx-run-spin {
  border: 1.5px solid transparent;
  border-top-color: rgba(255, 255, 255, 0.95);
  border-right-color: rgba(255, 255, 255, 0.35);
  animation: schedule-spin 0.9s linear infinite;
}
.openclawx-run-pulse {
  box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.45);
  animation: schedule-pulse 1.4s ease-out infinite;
}

.schedule-progress {
  transform: rotate(-90deg);
  pointer-events: none;
}
.schedule-progress-arc {
  animation: schedule-arc 1.1s linear infinite;
}
.schedule-check {
  position: absolute;
  inset: auto -2px -2px auto;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: rgb(16 185 129);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.9);
}
.schedule-check::after {
  content: "";
  position: absolute;
  left: 4px;
  top: 2.5px;
  width: 4px;
  height: 7px;
  border: solid white;
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}
.schedule-tile-running {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent), 0 8px 20px rgba(59, 130, 246, 0.12);
}
.schedule-dot-live {
  animation: schedule-dot 1s ease-in-out infinite;
}

.schedule-plan {
  position: relative;
  background:
    radial-gradient(circle at 50% 28%, rgba(59, 130, 246, 0.14), transparent 42%),
    radial-gradient(circle at 70% 70%, rgba(16, 185, 129, 0.08), transparent 40%),
    linear-gradient(180deg, color-mix(in srgb, var(--surface) 92%, rgb(59 130 246 / 8%)), var(--surface));
}
.schedule-plan-orb {
  position: relative;
  width: 132px;
  height: 132px;
  display: grid;
  place-items: center;
}
.schedule-plan-ring {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  border: 1.5px solid transparent;
  border-top-color: rgba(59, 130, 246, 0.85);
  border-right-color: rgba(99, 102, 241, 0.35);
}
.schedule-plan-ring-a { animation: schedule-spin 2.2s linear infinite; }
.schedule-plan-ring-b {
  inset: 12px;
  border-top-color: rgba(45, 212, 191, 0.8);
  border-right-color: rgba(59, 130, 246, 0.25);
  animation: schedule-spin 3.2s linear infinite reverse;
}
.schedule-plan-ring-c {
  inset: 24px;
  border-top-color: rgba(129, 140, 248, 0.7);
  border-left-color: rgba(16, 185, 129, 0.25);
  animation: schedule-spin 1.6s linear infinite;
}
.schedule-plan-core {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  border-radius: 16px;
  background: linear-gradient(145deg, rgb(59 130 246), rgb(79 70 229));
  color: white;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.08em;
  box-shadow: 0 10px 28px rgba(59, 130, 246, 0.35);
}
.schedule-plan-core-glow {
  position: absolute;
  inset: -8px;
  border-radius: 20px;
  background: radial-gradient(circle, rgba(96, 165, 250, 0.45), transparent 70%);
  animation: schedule-pulse 1.8s ease-out infinite;
}
.schedule-plan-sat {
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: rgb(96 165 250);
  box-shadow: 0 0 10px rgba(59, 130, 246, 0.7);
}
.schedule-plan-sat-1 {
  top: 8px;
  left: 50%;
  margin-left: -5px;
  animation: schedule-orbit-a 3s linear infinite;
}
.schedule-plan-sat-2 {
  bottom: 14px;
  right: 18px;
  background: rgb(45 212 191);
  animation: schedule-orbit-b 4s linear infinite;
}
.schedule-plan-sat-3 {
  left: 16px;
  top: 48%;
  background: rgb(129 140 248);
  animation: schedule-orbit-c 2.6s linear infinite;
}
.schedule-plan-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--border) 80%, rgb(59 130 246 / 25%));
  background: color-mix(in srgb, var(--surface) 88%, white);
  padding: 8px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text);
  opacity: 0;
  transform: translateY(6px);
  animation: schedule-hint-in 0.7s ease forwards;
}
.schedule-plan-hint-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
  animation: schedule-dot 1.2s ease-in-out infinite;
}
.schedule-plan-scan {
  pointer-events: none;
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, transparent, rgba(59, 130, 246, 0.08), transparent);
  background-size: 100% 40%;
  animation: schedule-scan 2.4s ease-in-out infinite;
}
.schedule-plan-bars {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 14px;
}
.schedule-plan-bars i {
  display: block;
  width: 2.5px;
  border-radius: 999px;
  background: var(--accent);
  animation: schedule-bar 0.9s ease-in-out infinite;
}
.schedule-plan-bars i:nth-child(1) { height: 5px; animation-delay: 0s; }
.schedule-plan-bars i:nth-child(2) { height: 9px; animation-delay: 0.1s; }
.schedule-plan-bars i:nth-child(3) { height: 13px; animation-delay: 0.2s; }
.schedule-plan-bars i:nth-child(4) { height: 8px; animation-delay: 0.3s; }
.schedule-plan-bars i:nth-child(5) { height: 6px; animation-delay: 0.4s; }

@keyframes schedule-spin {
  to { transform: rotate(360deg); }
}
@keyframes schedule-pulse {
  0% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.45); opacity: 0.9; }
  100% { box-shadow: 0 0 0 10px rgba(255, 255, 255, 0); opacity: 0; }
}
@keyframes schedule-arc {
  to { stroke-dashoffset: -132; }
}
@keyframes schedule-dot {
  0%, 100% { opacity: 0.45; transform: scale(0.92); }
  50% { opacity: 1; transform: scale(1.08); }
}
@keyframes schedule-hint-in {
  to { opacity: 1; transform: translateY(0); }
}
@keyframes schedule-scan {
  0% { background-position: 0 -40%; }
  100% { background-position: 0 140%; }
}
@keyframes schedule-bar {
  0%, 100% { transform: scaleY(0.55); opacity: 0.55; }
  50% { transform: scaleY(1); opacity: 1; }
}
@keyframes schedule-orbit-a {
  from { transform: rotate(0deg) translateY(-58px) rotate(0deg); }
  to { transform: rotate(360deg) translateY(-58px) rotate(-360deg); }
}
@keyframes schedule-orbit-b {
  from { transform: rotate(120deg) translateY(-50px) rotate(-120deg); }
  to { transform: rotate(480deg) translateY(-50px) rotate(-480deg); }
}
@keyframes schedule-orbit-c {
  from { transform: rotate(240deg) translateY(-46px) rotate(-240deg); }
  to { transform: rotate(600deg) translateY(-46px) rotate(-600deg); }
}
</style>
