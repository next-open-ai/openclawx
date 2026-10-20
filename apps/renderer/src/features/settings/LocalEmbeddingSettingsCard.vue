<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useLocalEmbedding } from '../../app/local-embedding';
import { useModelConfig } from '../../app/model-config';
import { useNotify } from '../../app/notify';

const { status, loading, supported, load, refresh, setEnabled, saveSettings, restart } = useLocalEmbedding();
const { registerLocalEmbeddingProvider } = useModelConfig();
const notify = useNotify();
const busy = ref(false);
const backendDraft = ref({
  backendUrl: '',
  backendModel: '',
  backendApiKey: '',
});

onMounted(() => {
  void load();
});

watch(status, (value) => {
  backendDraft.value = {
    backendUrl: value?.settings.backendUrl || '',
    backendModel: value?.settings.backendModel || '',
    backendApiKey: value?.settings.backendApiKey || '',
  };
}, { immediate: true });

const statusBadge = computed(() => {
  const state = status.value?.state;
  if (!state) return { text: '未初始化', className: 'bg-[var(--surface)] text-[var(--muted)]' };
  if (state.serviceStatus === 'failed') return { text: '启动失败', className: 'bg-red-50 text-red-700' };
  if (state.serviceStatus === 'running') return { text: '运行中', className: 'bg-emerald-50 text-emerald-700' };
  if (state.downloadStatus !== 'ready') return { text: '未下载', className: 'bg-amber-50 text-amber-700' };
  if (state.serviceStatus === 'degraded') return { text: 'Bootstrap 已启动', className: 'bg-amber-50 text-amber-700' };
  return { text: '已就绪', className: 'bg-emerald-50 text-emerald-700' };
});

const sizeLabel = computed(() => {
  const bytes = status.value?.manifest.sizeBytes ?? 0;
  if (!bytes) return '-';
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
});

async function handleToggle() {
  busy.value = true;
  try {
    await setEnabled(!status.value?.enabled);
    notify.success('notify.saved', status.value?.enabled ? '已启用本地 Embedding 运行时' : '已关闭本地 Embedding 运行时');
  } catch (cause) {
    notify.error(cause, '本地 Embedding 状态更新失败');
  } finally {
    busy.value = false;
  }
}

async function handleRefresh() {
  busy.value = true;
  try {
    await refresh();
  } catch (cause) {
    notify.error(cause, '本地 Embedding 状态刷新失败');
  } finally {
    busy.value = false;
  }
}

async function handleAutoRestartChange(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  busy.value = true;
  try {
    await saveSettings({ autoRestart: checked });
    notify.success('notify.saved', checked ? '已开启自动重启' : '已关闭自动重启');
  } catch (cause) {
    notify.error(cause, '自动重启设置保存失败');
  } finally {
    busy.value = false;
  }
}

async function handleSaveBackend() {
  busy.value = true;
  try {
    await saveSettings({
      backendUrl: backendDraft.value.backendUrl.trim(),
      backendModel: backendDraft.value.backendModel.trim(),
      backendApiKey: backendDraft.value.backendApiKey,
    });
    await restart();
    await refresh();
    notify.success('notify.saved', '本地 Embedding backend 配置已保存并已尝试重启');
  } catch (cause) {
    notify.error(cause, '本地 Embedding backend 配置保存失败');
  } finally {
    busy.value = false;
  }
}

async function handleRestart() {
  busy.value = true;
  try {
    const next = await restart();
    if (next.state.lastError) notify.info('本地 Embedding', next.state.lastError);
  } catch (cause) {
    notify.error(cause, '本地 Embedding 重启失败');
  } finally {
    busy.value = false;
  }
}

async function handleRegister() {
  if (!status.value?.providerDraft.baseUrl || status.value.state.serviceStatus !== 'running') {
    notify.info('本地 Embedding', '当前 sidecar 还没有进入可注册的运行态，请先完成真实推理后端接入。');
    return;
  }
  busy.value = true;
  try {
    await registerLocalEmbeddingProvider({
      suggestedProviderName: status.value.providerDraft.suggestedProviderName,
      providerType: status.value.providerDraft.providerType,
      baseUrl: status.value.providerDraft.baseUrl,
      embeddingModel: status.value.providerDraft.embeddingModel,
      meta: {
        dimension: status.value.providerDraft.meta.dimension,
        normalize: status.value.providerDraft.meta.normalize,
      },
    });
    notify.success('notify.saved', '已写入模型配置，并设为默认 embedding 模型');
  } catch (cause) {
    notify.error(cause, '本地 Embedding 注册到模型配置失败');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-[16px] font-bold">本地 Embedding Runtime</h3>
        <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--muted)]">
          这里管理轻量 sidecar 的本地嵌入运行时。当前先接入状态骨架，后续会继续补真实下载、健康检查和 provider 自动注册。
        </p>
      </div>
      <span :class="['rounded-full px-3 py-1 text-xs font-semibold', statusBadge.className]">{{ statusBadge.text }}</span>
    </div>

    <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <div class="rounded-xl bg-[var(--surface)] p-3 text-sm">
        <div class="text-xs text-[var(--muted)]">平台支持</div>
        <div class="mt-1 font-semibold">{{ supported ? '支持' : '当前运行环境不可用' }}</div>
      </div>
      <div class="rounded-xl bg-[var(--surface)] p-3 text-sm">
        <div class="text-xs text-[var(--muted)]">向量维度</div>
        <div class="mt-1 font-semibold">{{ status?.manifest.dimension ?? '-' }}</div>
      </div>
      <div class="rounded-xl bg-[var(--surface)] p-3 text-sm">
        <div class="text-xs text-[var(--muted)]">预计模型体积</div>
        <div class="mt-1 font-semibold">{{ sizeLabel }}</div>
      </div>
      <div class="rounded-xl bg-[var(--surface)] p-3 text-sm">
        <div class="text-xs text-[var(--muted)]">建议接入协议</div>
        <div class="mt-1 font-semibold">{{ status?.providerDraft.providerType ?? 'openai-compatible' }}</div>
      </div>
      <div class="rounded-xl bg-[var(--surface)] p-3 text-sm">
        <div class="text-xs text-[var(--muted)]">真实后端</div>
        <div class="mt-1 font-semibold">{{ status?.state.backendConfigured ? '已接入' : '未接入' }}</div>
      </div>
    </div>

    <div class="mt-4 grid gap-3 md:grid-cols-[1fr_1fr]">
      <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
        <div class="text-xs text-[var(--muted)]">推荐 Provider 草稿</div>
        <div class="mt-2 break-all font-medium">{{ status?.providerDraft.suggestedProviderName || '-' }}</div>
        <div class="mt-1 break-all text-[var(--muted)]">model: {{ status?.providerDraft.embeddingModel || '-' }}</div>
        <div class="mt-1 break-all text-[var(--muted)]">baseUrl: {{ status?.providerDraft.baseUrl || '待 sidecar 实际启动后生成' }}</div>
      </div>
      <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
        <div class="text-xs text-[var(--muted)]">运行时状态</div>
        <div class="mt-2 break-all text-[var(--muted)]">enabled: {{ status?.enabled ? 'true' : 'false' }}</div>
        <div class="mt-1 break-all text-[var(--muted)]">download: {{ status?.state.downloadStatus || '-' }}</div>
        <div class="mt-1 break-all text-[var(--muted)]">service: {{ status?.state.serviceStatus || '-' }}</div>
        <div class="mt-1 break-all text-[var(--muted)]">endpoint: {{ status?.state.endpoint || '-' }}</div>
        <div class="mt-1 break-all text-[var(--muted)]">pid: {{ status?.state.pid || '-' }} / port: {{ status?.state.port || '-' }}</div>
        <div class="mt-1 break-all text-[var(--muted)]">backend: {{ status?.state.backendUrl || '-' }}</div>
        <div class="mt-1 break-all text-[var(--muted)]">backendModel: {{ status?.state.backendModel || '-' }}</div>
      </div>
    </div>

    <div v-if="status?.state.lastError" class="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      {{ status.state.lastError }}
    </div>
    <p class="mt-3 text-xs leading-relaxed text-[var(--muted)]">
      也可通过环境变量配置真实后端：`OPENCLAWX_LOCAL_EMBEDDING_BACKEND_URL`、`OPENCLAWX_LOCAL_EMBEDDING_BACKEND_MODEL`、`OPENCLAWX_LOCAL_EMBEDDING_BACKEND_API_KEY`。若设置页已保存值，则优先使用设置页配置。
    </p>
    <label class="mt-4 flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm">
      <input
        type="checkbox"
        class="mt-0.5 h-4 w-4"
        :checked="Boolean(status?.settings.autoRestart)"
        :disabled="busy || loading"
        @change="handleAutoRestartChange"
      />
      <span>
        <strong class="block">启动时自动重启 sidecar</strong>
        <span class="mt-0.5 block text-xs leading-relaxed text-[var(--muted)]">
          仅当本地 embedding runtime 处于启用状态时，应用启动后才会按此配置自动尝试恢复 sidecar。
        </span>
      </span>
    </label>
    <div class="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="text-sm font-semibold">Proxy Backend 配置</p>
          <p class="mt-1 text-xs leading-relaxed text-[var(--muted)]">
            保存后会立即尝试重启 sidecar。这里建议填写一个标准 OpenAI-compatible embeddings 服务地址。
          </p>
        </div>
        <button
          class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          type="button"
          :disabled="busy || loading"
          @click="handleSaveBackend"
        >
          保存并重启
        </button>
      </div>
      <div class="mt-4 grid gap-3">
        <label class="grid gap-1 text-xs font-semibold text-[var(--muted)]">
          Backend URL
          <input v-model="backendDraft.backendUrl" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal text-[var(--text)]" placeholder="http://127.0.0.1:11434/v1" />
        </label>
        <label class="grid gap-1 text-xs font-semibold text-[var(--muted)]">
          Backend Model
          <input v-model="backendDraft.backendModel" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal text-[var(--text)]" placeholder="bge-m3" />
        </label>
        <label class="grid gap-1 text-xs font-semibold text-[var(--muted)]">
          Backend API Key
          <input v-model="backendDraft.backendApiKey" type="password" autocomplete="off" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal text-[var(--text)]" placeholder="可选，局域网本地服务可留空" />
        </label>
      </div>
    </div>

    <div class="mt-4 flex flex-wrap items-center gap-3">
      <button
        class="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        type="button"
        :disabled="busy || loading || !supported"
        @click="handleToggle"
      >
        {{ busy || loading ? '处理中…' : status?.enabled ? '关闭 Runtime' : '启用 Runtime' }}
      </button>
      <button
        class="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
        type="button"
        :disabled="busy || loading"
        @click="handleRestart"
      >
        重启 / 试启动
      </button>
      <button
        class="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
        type="button"
        :disabled="busy || loading"
        @click="handleRefresh"
      >
        刷新状态
      </button>
      <button
        class="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
        type="button"
        :disabled="busy || loading || status?.state.serviceStatus !== 'running'"
        @click="handleRegister"
      >
        注册到模型配置
      </button>
      <span class="text-xs text-[var(--muted)]">目录：{{ status?.runtime.root || '-' }}</span>
    </div>
  </div>
</template>
