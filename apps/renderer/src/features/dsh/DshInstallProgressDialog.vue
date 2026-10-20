<script setup lang="ts">
import { computed, ref } from 'vue';
import { environmentState } from '../../services/environment';
import {
  dshInstallPhaseLabel,
  dshInstallState,
  installDshRuntimeWithProgress,
} from './install-progress';
import { restoreDemotedEmployeesToDsh } from './engine-fallback';
import { writeStored } from '../../app/storage';

const emit = defineEmits<{
  close: [];
  accepted: [];
  declined: [];
  installed: [];
}>();

const mode = ref<'prompt' | 'progress'>('prompt');
const starting = ref(false);

const title = computed(() => {
  if (mode.value === 'prompt') return '启用 dsh 专业编码引擎？';
  if (dshInstallState.phase.value === 'error') return 'dsh 安装失败';
  if (dshInstallState.phase.value === 'done') return 'dsh 安装完成';
  if (dshInstallState.phase.value === 'skipped') return 'dsh 已就绪';
  return '正在安装 dsh 编码引擎';
});

const canClose = computed(() => mode.value === 'prompt' || !dshInstallState.busy.value);

const benefits = [
  {
    title: '专业编码能力',
    body: '面向仓库级改动与多步实现，比通用对话更擅长写代码、改代码、查问题。',
  },
  {
    title: '编程助理默认引擎',
    body: '安装成功后，预装「编程助理」会自动切回 dsh；未安装时会先用 pi 保底，不影响日常对话。',
  },
  {
    title: '按需本机安装',
    body: '不内置进安装包。首次约下载 200MB 到 ~/.openclawx/dsh-runtime，需联网与本机 npm。',
  },
] as const;

async function acceptInstall() {
  if (starting.value || dshInstallState.busy.value) return;
  starting.value = true;
  mode.value = 'progress';
  emit('accepted');
  try {
    const result = await installDshRuntimeWithProgress({ reinstall: false, source: 'startup' });
    if (result.report) {
      environmentState.report.value = result.report;
      environmentState.progressRows.value = result.report.checks.map((item) => ({
        id: item.id,
        name: item.name,
        required: item.required,
        state: 'done' as const,
        status: item.status,
        found: item.found,
      }));
    }
    if (result.ok && !dshInstallState.error.value) {
      await restoreDemotedEmployeesToDsh().catch(() => undefined);
      emit('installed');
      if (result.skipped) {
        emit('close');
      }
    }
  } catch {
    /* keep dialog open with error */
  } finally {
    starting.value = false;
  }
}

async function declineInstall() {
  await writeStored('dsh.install-prompt.declined-at', String(Date.now()));
  emit('declined');
  emit('close');
}

function finish() {
  emit('close');
}
</script>

<template>
  <div class="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
    <div class="w-full max-w-lg overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
      <header class="border-b border-[var(--border)] px-5 py-4">
        <p class="text-[10px] font-bold tracking-[0.14em] text-[var(--accent)]">DSH RUNTIME</p>
        <h2 class="mt-1 text-lg font-bold">{{ title }}</h2>
        <p v-if="mode === 'prompt'" class="mt-1 text-xs leading-5 text-[var(--muted)]">
          检测到尚未安装 dsh。你可以现在安装以解锁专业编码能力，也可以稍后在「环境检查」中再装。
        </p>
        <p v-else class="mt-1 text-xs text-[var(--muted)]">
          将创建目录并安装 JSON-RPC 依赖（约 200MB）。可在后台继续，但建议等待完成。
        </p>
      </header>

      <div v-if="mode === 'prompt'" class="space-y-3 px-5 py-4">
        <ul class="grid gap-2.5">
          <li
            v-for="item in benefits"
            :key="item.title"
            class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/45 px-3.5 py-3"
          >
            <p class="text-sm font-semibold">{{ item.title }}</p>
            <p class="mt-1 text-xs leading-5 text-[var(--muted)]">{{ item.body }}</p>
          </li>
        </ul>
        <p class="text-[11px] leading-5 text-[var(--muted)]">
          若暂不安装：编码相关员工会先使用 pi 引擎，应用可正常使用；需要时再一键安装即可。
        </p>
      </div>

      <div v-else class="space-y-3 px-5 py-4">
        <div class="flex items-center justify-between gap-2 text-sm">
          <span>当前阶段：<strong>{{ dshInstallPhaseLabel }}</strong></span>
          <span class="font-semibold text-[var(--accent)]">{{ dshInstallState.percent.value }}%</span>
        </div>
        <div class="h-2.5 overflow-hidden rounded-full bg-[var(--surface-muted)]">
          <div
            class="h-full rounded-full transition-all duration-300"
            :class="dshInstallState.phase.value === 'error'
              ? 'bg-rose-500'
              : 'bg-[linear-gradient(90deg,#0ea5e9,#14b8a6,#10b981)]'"
            :style="{ width: `${Math.max(4, dshInstallState.percent.value)}%` }"
          />
        </div>
        <p class="text-sm leading-6">{{ dshInstallState.message.value }}</p>
        <p v-if="dshInstallState.error.value" class="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-600">
          {{ dshInstallState.error.value }}
        </p>
        <details open class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/50 p-3">
          <summary class="cursor-pointer text-xs font-semibold text-[var(--accent)]">安装日志</summary>
          <pre class="mt-2 max-h-48 overflow-auto rounded-lg bg-[#0f172a] p-3 text-[11px] leading-relaxed text-slate-100"><code>{{ dshInstallState.logs.value.join('\n') || '等待输出…' }}</code></pre>
        </details>
      </div>

      <footer class="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
        <template v-if="mode === 'prompt'">
          <button
            class="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--surface-muted)]"
            type="button"
            @click="declineInstall"
          >
            稍后安装
          </button>
          <button
            class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            type="button"
            @click="acceptInstall"
          >
            立即安装
          </button>
        </template>
        <template v-else>
          <button
            v-if="dshInstallState.phase.value === 'error'"
            class="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--surface-muted)]"
            type="button"
            :disabled="!canClose"
            @click="mode = 'prompt'"
          >
            返回选择
          </button>
          <button
            class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            type="button"
            :disabled="!canClose"
            @click="finish"
          >
            {{ dshInstallState.busy.value || starting ? '安装中…' : '完成' }}
          </button>
        </template>
      </footer>
    </div>
  </div>
</template>
