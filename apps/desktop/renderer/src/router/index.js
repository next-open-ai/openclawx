import { createRouter, createWebHistory } from 'vue-router';
import Dashboard from '@/views/Dashboard.vue';
import AgentChat from '@/views/AgentChat.vue';
import Sessions from '@/views/Sessions.vue';
import Workspace from '@/views/Workspace.vue';
import WorkResults from '@/views/WorkResults.vue';
import Agents from '@/views/Agents.vue';
import AgentDetail from '@/views/AgentDetail.vue';
import Tasks from '@/views/Tasks.vue';
import Settings from '@/views/Settings.vue';

const routes = [
    {
        path: '/',
        name: 'Root',
        component: AgentChat, // Default to Chat
    },
    {
        path: '/dashboard',
        name: 'Dashboard',
        component: Dashboard,
    },
    {
        path: '/chat/:sessionId?',
        name: 'AgentChat',
        component: AgentChat,
    },
    {
        path: '/sessions',
        name: 'Sessions',
        component: Sessions,
    },
    {
        path: '/skills',
        redirect: () => ({ path: '/settings', query: { tab: 'skills' } }),
    },
    {
        path: '/agents',
        name: 'Agents',
        component: Agents,
    },
    {
        path: '/agents/:id',
        name: 'AgentDetail',
        component: AgentDetail,
    },
    {
        path: '/tasks',
        name: 'Tasks',
        component: Tasks,
    },
    {
        path: '/workspace',
        name: 'Workspace',
        component: Workspace,
    },
    {
        path: '/work-results',
        name: 'WorkResults',
        component: WorkResults,
    },
    {
        path: '/settings',
        name: 'Settings',
        component: Settings,
    },
];

const router = createRouter({
    history: createWebHistory(),
    routes,
});

export default router;
