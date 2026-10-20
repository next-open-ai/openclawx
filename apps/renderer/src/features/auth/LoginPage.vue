<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ needsSetup: boolean; orgId: string; busy?: boolean }>();
const emit = defineEmits<{
  login: [payload: { username: string; password: string }];
  bootstrap: [payload: { orgId: string; username: string; displayName: string; password: string }];
}>();

const loginForm = ref({ username: '', password: '' });
const setupForm = ref({ orgId: props.orgId || 'local-org', username: '', displayName: '', password: '' });
</script>

<template>
  <main class="grid min-h-screen place-items-center bg-[var(--background)] px-6 py-16 text-[var(--text)]">
    <section class="w-full max-w-md rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
      <p class="text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">OpenClawX / AUTH</p>
      <h1 class="mt-3 text-3xl font-bold tracking-[-.04em]">{{ needsSetup ? '初始化本地管理员' : '登录 OpenClawX' }}</h1>
      <p class="mt-2 text-sm leading-relaxed text-[var(--muted)]">
        {{ needsSetup ? '先创建一个本地管理员账号。后续可在应用内继续维护本地用户 CRUD，并为未来远程用户系统保留 orgId 基础。' : '当前阶段采用本地用户登录，会话与前端本地状态会按用户隔离。' }}
      </p>

      <form
        v-if="needsSetup"
        class="mt-6 space-y-3"
        @submit.prevent="emit('bootstrap', { orgId: setupForm.orgId, username: setupForm.username, displayName: setupForm.displayName, password: setupForm.password })"
      >
        <input v-model="setupForm.orgId" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm" placeholder="orgId，例如 local-org" />
        <input v-model="setupForm.displayName" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm" placeholder="显示名称" />
        <input v-model="setupForm.username" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm" placeholder="用户名" />
        <input v-model="setupForm.password" type="password" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm" placeholder="密码（至少 6 位）" />
        <button class="w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60" :disabled="busy" type="submit">
          {{ busy ? '处理中…' : '创建管理员并进入 OpenClawX' }}
        </button>
      </form>

      <form
        v-else
        class="mt-6 space-y-3"
        @submit.prevent="emit('login', { username: loginForm.username, password: loginForm.password })"
      >
        <input v-model="loginForm.username" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm" placeholder="用户名" />
        <input v-model="loginForm.password" type="password" class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm" placeholder="密码" />
        <button class="w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60" :disabled="busy" type="submit">
          {{ busy ? '登录中…' : '登录' }}
        </button>
      </form>
    </section>
  </main>
</template>
