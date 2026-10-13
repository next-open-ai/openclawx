<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';
import type { Project } from '../../app/projects.js';
import type { AuthUser } from '../../services/auth.js';
import * as orch from '../../services/orchestration.js';

const props = defineProps<{ project: Project; users: AuthUser[]; currentUserId?: string }>();
const titleId = `project-sharing-${useId()}`;
const dialog = ref<HTMLDialogElement>();
const saving = ref(false);
const error = ref('');
const scope = ref<'private' | 'org-shared' | 'delegated'>('private');
const permissions = ref<Record<string, 'read' | 'write'>>({});
const label = computed(() => props.project.accessScope === 'org-shared' ? '组织共享' : props.project.accessScope === 'delegated' ? '指定用户' : '仅自己');
const users = computed(() => props.users.filter(user => user.id !== (props.project.ownerUserId ?? props.currentUserId ?? '')));
const valid = computed(() => scope.value !== 'delegated' || Object.keys(permissions.value).length > 0);

async function open() {
  scope.value = props.project.accessScope ?? 'private';
  permissions.value = Object.fromEntries((props.project.accessGrants ?? []).filter(grant => grant.subjectType === 'user' && grant.subjectId).map(grant => [grant.subjectId, grant.permissions.includes('write') ? 'write' : 'read']));
  error.value = '';
  await nextTick();
  dialog.value?.showModal();
}
function close() { if (!saving.value) dialog.value?.close(); }
function toggle(userId: string, event: Event) {
  if ((event.target as HTMLInputElement).checked) permissions.value[userId] = 'write';
  else delete permissions.value[userId];
}
async function save() {
  if (saving.value || !valid.value || !props.project.managedServer) return;
  saving.value = true; error.value = '';
  try {
    const updated = await orch.updateProjectAccess(props.project.id, {
      accessScope: scope.value,
      accessGrants: scope.value === 'delegated' ? Object.entries(permissions.value).map(([subjectId, permission]) => ({ subjectType: 'user' as const, subjectId, permissions: permission === 'write' ? ['read', 'write'] : ['read'], createdAt: Date.now() })) : [],
    });
    props.project.accessScope = updated.accessScope ?? 'private';
    props.project.accessGrants = updated.accessGrants ?? [];
    dialog.value?.close();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '共享设置保存失败，请重试。';
  } finally { saving.value = false; }
}
</script>

<template>
  <button v-if="project.managedServer" type="button" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold hover:border-[var(--accent)] hover:text-[var(--accent)]" aria-haspopup="dialog" @click="open">共享 · {{ label }}</button>
  <Teleport to="body">
    <dialog ref="dialog" :aria-labelledby="titleId" class="sharing-dialog m-auto w-[min(480px,calc(100vw-32px))] max-h-[85dvh] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text)] shadow-2xl" @cancel="saving && $event.preventDefault()">
      <form class="p-6" @submit.prevent="save">
        <div class="mb-5 flex items-start justify-between gap-4">
          <div class="min-w-0"><h2 :id="titleId" class="text-lg font-bold">项目共享</h2><p class="mt-1 truncate text-sm text-[var(--muted)]">{{ project.name }}</p></div>
          <button type="button" aria-label="关闭共享设置" :disabled="saving" class="rounded-lg px-2 py-1 text-[var(--muted)] hover:bg-[var(--surface-muted)] disabled:opacity-40" @click="close">✕</button>
        </div>
        <fieldset :disabled="saving" class="space-y-3">
          <legend class="mb-2 text-xs text-[var(--muted)]">选择谁可以访问此项目</legend>
          <label v-for="option in [{id:'private',name:'仅自己',description:'个人草稿与私有项目。'},{id:'org-shared',name:'组织共享',description:'同组织成员可读，项目所有者与管理员可编辑。'},{id:'delegated',name:'指定用户',description:'仅向所选用户授权，可分别设置访问权限。'}]" :key="option.id" :class="['flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3',scope === option.id ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)]']">
            <input v-model="scope" type="radio" name="project-share-scope" :value="option.id" class="mt-1 accent-[var(--accent)]" />
            <span><strong class="block text-sm">{{ option.name }}</strong><span class="mt-1 block text-xs leading-5 text-[var(--muted)]">{{ option.description }}</span></span>
          </label>
          <div v-if="scope === 'delegated'" class="space-y-2 rounded-xl bg-[var(--surface-muted)] p-3">
            <div v-for="user in users" :key="user.id" class="flex items-center gap-3">
              <label class="flex min-w-0 flex-1 items-center gap-2 py-1"><input type="checkbox" :checked="Boolean(permissions[user.id])" @change="toggle(user.id,$event)" /><span class="truncate text-sm">{{ user.displayName }}</span></label>
              <select v-if="permissions[user.id]" v-model="permissions[user.id]" :aria-label="`${user.displayName}的访问权限`" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"><option value="read">只读</option><option value="write">可编辑</option></select>
            </div>
            <p v-if="!users.length" class="text-xs text-[var(--muted)]">当前没有可委托的其他本地用户。</p>
            <p v-if="!valid" class="text-xs text-[var(--muted)]">请选择至少一位用户。</p>
          </div>
        </fieldset>
        <p v-if="error" role="alert" class="mt-4 text-sm text-rose-600">{{ error }}</p>
        <div class="mt-6 flex justify-end gap-2">
          <button type="button" :disabled="saving" class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm disabled:opacity-40" @click="close">取消</button>
          <button type="submit" :disabled="saving || !valid" class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{{ saving ? '保存中…' : '保存共享设置' }}</button>
        </div>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.sharing-dialog::backdrop { background: rgb(15 23 42 / 35%); backdrop-filter: blur(3px); }
</style>
