<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { markdownToHtml, type PreviewKind } from '../../app/project-files';
import { qrDataUrl } from '../../app/qr-data-url.js';

const props = defineProps<{
  title: string;
  storageLabel: string;
  metaLines?: string[];
  loading?: boolean;
  error?: string;
  kind: PreviewKind;
  desktopShell?: boolean;
  /** Show destructive delete action (archive mode). */
  canDelete?: boolean;
  deleting?: boolean;
  /** SITE bundle or project website: show local LAN deploy controls. */
  canDeploy?: boolean;
  deploying?: boolean;
  stoppingDeploy?: boolean;
  deployed?: boolean;
  deployUrl?: string;
  /** Spreadsheet asset/file: import into data workbench. */
  canImportData?: boolean;
  importingData?: boolean;
  /** Full URL for HTML/PDF iframe (openclawx-preview://… or blob:). */
  htmlUrl?: string;
  /** Raw text for md/code. */
  text?: string;
  /** data: URL or blob for images (incl. SVG). */
  imageUrl?: string;
}>();

const emit = defineEmits<{
  refresh: [];
  reveal: [];
  download: [];
  openBrowser: [];
  delete: [];
  deploy: [];
  stopDeploy: [];
  openDeployUrl: [];
  importData: [];
}>();

const deployQrSrc = ref('');
watch(
  () => props.deployUrl,
  async (url) => {
    const target = String(url || '').trim();
    if (!target) {
      deployQrSrc.value = '';
      return;
    }
    try {
      deployQrSrc.value = await qrDataUrl(target, 112);
    } catch {
      deployQrSrc.value = '';
    }
  },
  { immediate: true },
);

const mdHtml = computed(() => (props.kind === 'markdown' && props.text ? markdownToHtml(props.text) : ''));
const showActions = computed(() => Boolean(props.title) || Boolean(props.canDeploy) || Boolean(props.canImportData));
const iframeUrl = computed(() => ((props.kind === 'html' || props.kind === 'pdf') && props.htmlUrl ? props.htmlUrl : ''));
const openLabel = computed(() => (props.desktopShell ? '用系统应用打开' : '在新标签页打开'));
const revealLabel = computed(() => (props.desktopShell ? '在 Finder 中显示' : '复制文件链接'));
const unsupportedHint = computed(() => (props.desktopShell ? '此格式暂不支持内嵌预览，可点「用系统应用打开」或下载后查看。' : '此格式暂不支持内嵌预览，可在新标签页打开或下载后查看。'));
</script>

<template>
  <aside class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
    <header class="flex shrink-0 flex-col gap-3 border-b border-[var(--border)] px-4 py-3">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--accent)]">{{ storageLabel }}</span>
            <span v-if="kind !== 'unsupported' && title" class="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] font-bold uppercase text-[var(--muted)]">{{ kind }}</span>
            <span v-if="canDeploy && deployed" class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-700">已部署</span>
          </div>
          <h2 class="mt-1 truncate text-sm font-bold">{{ title || (canDeploy ? '网站预览' : '选择文件以预览') }}</h2>
          <p v-for="(line, index) in metaLines || []" :key="index" class="mt-0.5 truncate text-[11px] text-[var(--muted)]">{{ line }}</p>
        </div>
        <div v-if="showActions" class="flex shrink-0 flex-wrap justify-end gap-2">
          <template v-if="title">
            <button class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="emit('refresh')">刷新预览</button>
            <button class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="emit('openBrowser')">{{ openLabel }}</button>
            <button class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="emit('reveal')">{{ revealLabel }}</button>
          </template>
          <button
            v-if="canImportData && title"
            class="rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-500/15 disabled:opacity-40"
            type="button"
            :disabled="importingData"
            @click="emit('importData')"
          >{{ importingData ? '导入中…' : '导入数据工作台' }}</button>
          <button
            v-if="canDeploy"
            class="rounded-lg border border-[var(--accent)]/40 bg-[var(--accent-soft)] px-2.5 py-1.5 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]/80 disabled:opacity-40"
            type="button"
            :disabled="deploying || stoppingDeploy"
            @click="emit('deploy')"
          >{{ deploying ? '部署中…' : '本地部署' }}</button>
          <button
            v-if="canDeploy"
            class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--surface-muted)] disabled:opacity-40"
            type="button"
            :disabled="stoppingDeploy || deploying || !deployed"
            @click="emit('stopDeploy')"
          >{{ stoppingDeploy ? '关闭中…' : '关闭部署' }}</button>
          <button v-if="title" class="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-xs font-semibold text-white" type="button" @click="emit('download')">下载</button>
          <button
            v-if="canDelete && title"
            class="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-500/15 disabled:opacity-40"
            type="button"
            :disabled="deleting"
            @click="emit('delete')"
          >{{ deleting ? '删除中…' : '删除' }}</button>
        </div>
      </div>

      <div
        v-if="canDeploy && deployUrl"
        class="flex w-fit max-w-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/70 px-3 py-2.5"
      >
        <img
          v-if="deployQrSrc"
          :src="deployQrSrc"
          alt="部署地址二维码"
          class="h-16 w-16 shrink-0 rounded-lg bg-white p-1 shadow-sm ring-1 ring-[var(--border)]"
          :title="deployUrl"
        />
        <div class="min-w-0 max-w-[280px] sm:max-w-[360px]">
          <p class="text-[10px] font-bold tracking-wide text-[var(--muted)]">局域网访问</p>
          <button
            class="mt-0.5 block max-w-full truncate text-left text-[12px] font-semibold text-[var(--accent)] hover:underline"
            type="button"
            :title="deployUrl"
            @click="emit('openDeployUrl')"
          >{{ deployUrl }}</button>
          <p class="mt-1 text-[10px] leading-4 text-[var(--muted)]">手机扫码，同一局域网即可打开</p>
        </div>
      </div>
    </header>

    <div class="relative min-h-0 flex-1 bg-[var(--background)]">
      <div v-if="loading" class="grid h-full place-items-center text-sm text-[var(--muted)]">加载预览…</div>
      <div v-else-if="error" class="grid h-full place-items-center px-6 text-center text-sm text-rose-600">{{ error }}</div>
      <div v-else-if="!title" class="grid h-full place-items-center px-6 text-center">
        <div>
          <p class="text-sm font-medium">浏览器式预览</p>
          <p class="mt-1 text-xs text-[var(--muted)]">支持 HTML、PDF、Markdown、图片/SVG 与常见代码文本。</p>
        </div>
      </div>
      <iframe
        v-else-if="iframeUrl"
        class="h-full w-full border-0 bg-white"
        :src="iframeUrl"
        :sandbox="kind === 'html' ? 'allow-scripts allow-same-origin allow-forms allow-modals' : undefined"
        :title="kind === 'pdf' ? 'PDF preview' : 'HTML preview'"
      />
      <div
        v-else-if="kind === 'markdown'"
        class="asset-md h-full overflow-y-auto px-6 py-5 text-sm leading-7"
        v-html="mdHtml"
      />
      <div v-else-if="kind === 'image' && imageUrl" class="grid h-full place-items-center overflow-auto p-4">
        <img :src="imageUrl" :alt="title" class="max-h-full max-w-full rounded-lg object-contain shadow-sm" />
      </div>
      <pre
        v-else-if="(kind === 'code' || kind === 'text') && text != null"
        class="h-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-5 text-[var(--text)]"
      >{{ text }}</pre>
      <div v-else class="grid h-full place-items-center px-6 text-center text-sm text-[var(--muted)]">
        {{ unsupportedHint }}
      </div>
    </div>
  </aside>
</template>

<style scoped>
.asset-md :deep(h1) { font-size: 1.5rem; font-weight: 700; margin: 0.6em 0 0.4em; }
.asset-md :deep(h2) { font-size: 1.25rem; font-weight: 700; margin: 0.8em 0 0.35em; }
.asset-md :deep(h3) { font-size: 1.05rem; font-weight: 700; margin: 0.7em 0 0.3em; }
.asset-md :deep(p) { margin: 0.35em 0; }
.asset-md :deep(ul) { margin: 0.4em 0 0.4em 1.2em; list-style: disc; }
.asset-md :deep(code) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; background: var(--surface-muted); padding: 0.1em 0.35em; border-radius: 4px; }
.asset-md :deep(pre) { background: var(--surface-muted); padding: 12px 14px; border-radius: 10px; overflow: auto; margin: 0.6em 0; }
.asset-md :deep(a) { color: var(--accent); text-decoration: underline; }
.asset-md :deep(blockquote) { border-left: 3px solid var(--border); margin: 0.6em 0; padding-left: 0.8em; color: var(--muted); }
</style>
