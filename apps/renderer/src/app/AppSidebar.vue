<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Conversation, View } from './workspace';
import type { AuthUser } from '../services/auth.js';
import { useI18n } from './i18n';
import { useTheme, themeIconNames } from './theme';
import { isViewAvailable } from './platform';
import SidebarIcon from './SidebarIcon.vue';
import BrandLogo from './BrandLogo.vue';

const props = defineProps<{ collapsed: boolean; view: View; conversations: Conversation[]; activeConversationId: string | null; serviceReady: boolean; currentUser?: AuthUser | null }>();
const emit = defineEmits<{ toggle: []; navigate: [view: View]; newChat: []; selectConversation: [id: string]; deleteConversation: [id: string]; logout: []; openApplications: [] }>();
const { t } = useI18n();
const { preference, cycleTheme } = useTheme();
const accountMenuOpen = ref(false);
const accountMenuRoot = ref<HTMLElement | null>(null);

type NavItem = { id: View; labelKey: string; icon: 'chat' | 'employees' | 'capabilities' | 'knowledge' | 'automations' | 'assets' | 'data' | 'projects' | 'remote' | 'docs' };

const navItems: NavItem[] = [
  { id: 'chat', labelKey: 'nav.workspace', icon: 'chat' },
  { id: 'employees', labelKey: 'nav.employees', icon: 'employees' },
  { id: 'projects', labelKey: 'nav.projects', icon: 'projects' },
  { id: 'workflows', labelKey: 'nav.workflows', icon: 'automations' },
  { id: 'capabilities', labelKey: 'nav.capabilities', icon: 'capabilities' },
  { id: 'knowledge', labelKey: 'nav.knowledge', icon: 'knowledge' },
  { id: 'automations', labelKey: 'nav.automations', icon: 'automations' },
  { id: 'assets', labelKey: 'nav.assets', icon: 'assets' },
  { id: 'data', labelKey: '数据工作台', icon: 'data' },
  { id: 'remote', labelKey: 'nav.remote', icon: 'remote' },
  { id: 'docs', labelKey: 'nav.docs', icon: 'docs' },
];
const visibleNavItems = computed(() => navItems.filter((item) => isViewAvailable(item.id)));

const themeIcon = computed(() => themeIconNames[preference.value] as 'theme-system' | 'theme-light' | 'theme-dark' | 'theme-midnight' | 'theme-aurora');
const themeAriaLabel = computed(() => `${t('theme.cycle')}，${t(`theme.${preference.value}`)}`);

function removeConversation(conversation: Conversation) {
  if (window.confirm(`删除对话“${conversation.title}”？此操作无法恢复。`)) emit('deleteConversation', conversation.id);
}

function themeButtonTitle() {
  const status = props.serviceReady ? t('common.statusReady') : t('common.statusOffline');
  return `${t('theme.cycle')} · ${t(`theme.${preference.value}`)} · ${status}`;
}
function serviceStatusLabel() {
  return props.serviceReady ? t('common.statusReady') : t('common.statusOffline');
}

function navActive(view: View) {
  return props.view === view;
}

function itemClass(active: boolean) {
  return [
    'group flex w-full items-center rounded-[10px] text-sm font-medium transition-colors',
    props.collapsed ? 'h-10 justify-center px-0' : 'gap-3 px-3 py-2.5',
    active ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]',
  ];
}

function iconWrapClass(active: boolean) {
  return [
    'grid shrink-0 place-items-center',
    props.collapsed ? 'h-10 w-10' : 'h-5 w-5',
    !props.collapsed && active ? 'text-[var(--accent)]' : '',
  ];
}

const currentUserLabel = computed(() => props.currentUser?.displayName || '未登录');
const currentUserMeta = computed(() => props.currentUser ? `@${props.currentUser.username}` : '本地会话');
const currentUserInitial = computed(() => {
  const source = props.currentUser?.displayName?.trim() || props.currentUser?.username?.trim() || 'U';
  return source.slice(0, 1).toUpperCase();
});

function closeAccountMenu(event: MouseEvent) {
  if (!accountMenuRoot.value?.contains(event.target as Node)) accountMenuOpen.value = false;
}
function handleAccountKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') accountMenuOpen.value = false;
}
function navigateFromAccount(view: View) {
  accountMenuOpen.value = false;
  emit('navigate', view);
}
function logoutFromAccount() {
  accountMenuOpen.value = false;
  emit('logout');
}
onMounted(() => {
  document.addEventListener('click', closeAccountMenu);
  document.addEventListener('keydown', handleAccountKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', closeAccountMenu);
  document.removeEventListener('keydown', handleAccountKeydown);
});
</script>

<template>
  <aside :class="['flex shrink-0 flex-col border-r border-[var(--border)] bg-[var(--sidebar)] transition-[width] duration-200', collapsed ? 'w-[72px] px-2 py-3' : 'w-[248px] p-3']">
    <div :class="['mb-5 flex items-center', collapsed ? 'justify-center' : 'justify-between px-1']">
      <button type="button" data-app-gallery-entry class="flex items-center gap-2.5 rounded-lg outline-offset-4 hover:opacity-80" title="打开应用大厅" aria-label="打开应用大厅" @click="emit('openApplications')">
        <BrandLogo />
        <span v-if="!collapsed" class="text-sm font-extrabold tracking-[.06em]">OpenClawX</span>
      </button>
      <button v-if="!collapsed" class="grid h-8 w-8 place-items-center rounded-[10px] text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]" type="button" title="收起侧栏" @click="emit('toggle')">
        <SidebarIcon name="chevron-left" />
      </button>
    </div>

    <button
      :class="[
        'mb-4 flex items-center rounded-[10px] bg-[var(--text)] font-semibold text-[var(--surface)] shadow-sm transition hover:opacity-90',
        collapsed ? 'mx-auto h-10 w-10 justify-center' : 'gap-2.5 px-3 py-2.5 text-sm',
      ]"
      type="button"
      :title="t('nav.newConversation')"
      @click="emit('newChat')"
    >
      <SidebarIcon name="plus" class="!h-[18px] !w-[18px]" />
      <span v-if="!collapsed">{{ t('nav.newConversation') }}</span>
    </button>

    <nav class="grid max-h-[62vh] shrink-0 gap-0.5 overflow-y-auto" :aria-label="t('nav.workspace')">
      <button
        v-for="item in visibleNavItems"
        :key="item.id"
        :class="itemClass(navActive(item.id))"
        type="button"
        :title="t(item.labelKey)"
        @click="emit('navigate', item.id)"
      >
        <span :class="iconWrapClass(navActive(item.id))">
          <SidebarIcon :name="item.icon" />
        </span>
        <span v-if="!collapsed" class="truncate">{{ t(item.labelKey) }}</span>
      </button>
    </nav>

    <section v-if="!collapsed" class="mt-4 flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto">
      <p class="mx-3 mb-1 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--muted)]">{{ t('nav.recent') }}</p>
      <div
        v-for="conversation in conversations.slice(0, 8)"
        :key="conversation.id"
        :class="['group flex items-center rounded-[8px] pr-1 transition-colors hover:bg-[var(--surface-muted)]', { 'bg-[var(--surface-muted)]': activeConversationId === conversation.id }]"
      >
        <button class="min-w-0 flex-1 truncate px-3 py-2 text-left text-[13px] text-[var(--muted)]" type="button" @click="emit('selectConversation', conversation.id)">{{ conversation.title }}</button>
        <button class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--muted)] opacity-0 transition-opacity hover:bg-rose-500/10 hover:text-rose-600 focus:opacity-100 group-hover:opacity-100" type="button" :title="`删除对话：${conversation.title}`" aria-label="删除对话" @click.stop="removeConversation(conversation)">×</button>
      </div>
      <span v-if="conversations.length === 0" class="px-3 py-2 text-xs text-[var(--muted)]">{{ t('recent.empty') }}</span>
    </section>

    <div ref="accountMenuRoot" class="relative mt-auto pt-2">
      <div
        v-if="currentUser && accountMenuOpen"
        :class="[
          'absolute z-40 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-[0_18px_50px_rgba(15,23,42,0.18)]',
          collapsed ? 'bottom-0 left-[52px] w-[224px]' : 'bottom-[58px] left-0 right-0',
        ]"
        role="menu"
        aria-label="账户与配置"
      >
        <div class="border-b border-[var(--border)] px-2.5 pb-2.5 pt-1.5">
          <div class="flex items-center gap-2">
            <p class="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text)]">{{ currentUserLabel }}</p>
            <span class="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent)]">{{ currentUser.role }}</span>
          </div>
          <p class="mt-1 truncate text-xs text-[var(--muted)]">{{ currentUserMeta }} · {{ currentUser.orgId }}</p>
        </div>
        <button class="mt-1 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-xs font-medium text-[var(--muted)] transition hover:bg-[var(--surface-muted)] hover:text-[var(--text)]" type="button" role="menuitem" :title="themeButtonTitle()" :aria-label="themeAriaLabel" @click="cycleTheme">
          <SidebarIcon :name="themeIcon" class="!h-4 !w-4" />
          <span class="flex-1">外观</span><span class="text-[11px]">{{ t(`theme.${preference}`) }}</span>
        </button>
        <button class="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-xs font-medium text-[var(--muted)] transition hover:bg-[var(--surface-muted)] hover:text-[var(--text)]" type="button" role="menuitem" @click="navigateFromAccount('settings')">
          <SidebarIcon name="settings" class="!h-4 !w-4" />
          <span>{{ t('nav.settings') }}</span>
        </button>
        <button class="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-xs font-medium text-[var(--muted)] transition hover:bg-rose-500/10 hover:text-rose-600" type="button" role="menuitem" @click="logoutFromAccount">
          <span class="grid h-4 w-4 place-items-center text-sm font-bold" aria-hidden="true">↪</span>
          <span>退出登录</span>
        </button>
      </div>

      <button
        v-if="currentUser"
        :class="[
          'group flex items-center border border-transparent text-left transition hover:border-[var(--border)] hover:bg-[var(--surface)] hover:shadow-sm',
          collapsed ? 'mx-auto h-11 w-11 justify-center rounded-2xl' : 'w-full gap-2.5 rounded-xl px-2 py-1.5',
          accountMenuOpen ? 'border-[var(--border)] bg-[var(--surface)] shadow-sm' : '',
        ]"
        type="button"
        aria-haspopup="menu"
        :aria-expanded="accountMenuOpen"
        aria-label="打开账户与设置菜单"
        title="账户与配置"
        @click.stop="accountMenuOpen = !accountMenuOpen"
      >
        <span class="relative grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--accent)] text-xs font-extrabold text-white shadow-sm">
          {{ currentUserInitial }}
          <span class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--sidebar)]" :class="serviceReady ? 'bg-emerald-500' : 'bg-slate-400'" :title="serviceStatusLabel()" aria-hidden="true" />
        </span>
        <span v-if="!collapsed" class="min-w-0 flex-1">
          <span class="block truncate text-[13px] font-semibold text-[var(--text)]">{{ currentUserLabel }}</span>
          <span class="mt-0.5 block truncate text-[10px] text-[var(--muted)]">账户与设置</span>
        </span>
        <span
          v-if="!collapsed"
          :class="[
            'grid h-7 w-7 shrink-0 place-items-center rounded-lg transition',
            accountMenuOpen
              ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
              : 'text-[var(--muted)] group-hover:bg-[var(--surface-muted)] group-hover:text-[var(--text)]',
          ]"
          aria-hidden="true"
        >
          <SidebarIcon name="settings" class="!h-4 !w-4 transition-transform duration-200" :class="accountMenuOpen ? 'rotate-45' : ''" />
        </span>
      </button>

      <div :class="['flex gap-1', collapsed ? 'mt-1 flex-col items-center' : 'items-center']">
      <button
        v-if="collapsed"
        class="grid h-10 w-10 place-items-center rounded-[10px] text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]"
        type="button"
        title="展开侧栏"
        @click="emit('toggle')"
      >
        <SidebarIcon name="chevron-right" />
      </button>
      <button
        v-if="collapsed && !currentUser"
        class="grid h-10 w-10 place-items-center rounded-[10px] text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]"
        type="button"
        :title="themeButtonTitle()"
        :aria-label="themeAriaLabel"
        @click="cycleTheme"
      >
        <span class="relative grid h-10 w-10 place-items-center rounded-[10px]">
          <SidebarIcon :name="themeIcon" />
          <span
            class="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full ring-2 ring-[var(--sidebar)]"
            :class="serviceReady ? 'bg-emerald-500' : 'bg-slate-400'"
            aria-hidden="true"
          />
        </span>
      </button>
      <button
        v-if="collapsed && !currentUser"
        :class="itemClass(navActive('settings'))"
        type="button"
        :title="t('nav.settings')"
        @click="emit('navigate', 'settings')"
      >
        <span :class="iconWrapClass(navActive('settings'))">
          <SidebarIcon name="settings" />
        </span>
      </button>
      <button
        v-if="!currentUser && !collapsed"
        :class="itemClass(false)"
        type="button"
        :title="themeButtonTitle()"
        :aria-label="themeAriaLabel"
        @click="cycleTheme"
      >
        <span class="relative grid h-10 w-10 shrink-0 place-items-center rounded-[10px]">
          <SidebarIcon :name="themeIcon" />
          <span
            class="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full ring-2 ring-[var(--sidebar)]"
            :class="serviceReady ? 'bg-emerald-500' : 'bg-slate-400'"
            aria-hidden="true"
          />
        </span>
        <span v-if="!collapsed" class="truncate text-left">{{ t(`theme.${preference}`) }}</span>
      </button>
      <button v-if="!currentUser && !collapsed" :class="[itemClass(navActive('settings')), 'flex-1']" type="button" :title="t('nav.settings')" @click="emit('navigate', 'settings')">
        <span :class="iconWrapClass(navActive('settings'))">
          <SidebarIcon name="settings" />
        </span>
        <span v-if="!collapsed" class="truncate">{{ t('nav.settings') }}</span>
      </button>
      </div>
    </div>
  </aside>
</template>
