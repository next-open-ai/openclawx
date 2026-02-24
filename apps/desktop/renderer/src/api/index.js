import axios from 'axios';

const API_BASE_URL = '/server-api'; // Relative path to use the same origin (Gateway proxy)

const apiClient = axios.create({
    baseURL: API_BASE_URL,
    headers: {
        'Content-Type': 'application/json',
    },
});

// Agent API
export const agentAPI = {
    createSession: (options) => apiClient.post('/agents/sessions', options),
    getSessions: () => apiClient.get('/agents/sessions'),
    getSession: (id) => apiClient.get(`/agents/sessions/${id}`),
    updateSessionAgentId: (id, agentId) => apiClient.patch(`/agents/sessions/${id}`, { agentId }),
    deleteSession: (id) => apiClient.delete(`/agents/sessions/${id}`),
    getHistory: (id) => apiClient.get(`/agents/sessions/${id}/history`),
    clearSessionMessages: (id) => apiClient.delete(`/agents/sessions/${id}/messages`),
    appendMessage: (id, role, content, options = {}) =>
        apiClient.post(`/agents/sessions/${id}/messages`, { role, content, ...options }),
};

// Agent config (智能体配置) API
export const agentConfigAPI = {
    listAgents: () => apiClient.get('/agent-config'),
    getAgent: (id) => apiClient.get(`/agent-config/${id}`),
    createAgent: (body) => apiClient.post('/agent-config', body),
    updateAgent: (id, body) => apiClient.put(`/agent-config/${id}`, body),
    /** deleteWorkspaceDir: true 时同时删除工作区磁盘目录；默认仅删数据库中的工作区相关数据 */
    deleteAgent: (id, params) => apiClient.delete(`/agent-config/${id}`, { params: params || {} }),
};

// Skills API
export const skillsAPI = {
    getSkills: (workspace, scope) =>
        apiClient.get('/skills', { params: scope ? { scope } : workspace ? { workspace } : {} }),
    getSkill: (name) => apiClient.get(`/skills/${name}`),
    getSkillContent: (name, workspace) =>
        apiClient.get(`/skills/${name}/content`, workspace ? { params: { workspace } } : {}),
    addSkill: (body) => apiClient.post('/skills', body),
    deleteSkill: (workspace, name, scope) =>
        apiClient.delete(`/skills/${encodeURIComponent(name)}`, {
            params: scope ? { scope } : { workspace },
        }),
    installSkill: (url, options) =>
        apiClient.post('/skills/install', {
            url,
            scope: options?.scope,
            workspace: options?.workspace,
        }),
    /** 从本地目录安装技能。path 为本地绝对路径（桌面端通过目录选择器获得） */
    installSkillFromPath: (path, options) =>
        apiClient.post('/skills/install-from-path', {
            path,
            scope: options?.scope,
            workspace: options?.workspace,
        }),
    /** 从上传的 zip 安装技能（浏览器端使用）。file 为 File 对象 */
    installSkillFromUpload: (file, options) => {
        const form = new FormData();
        form.append('file', file);
        form.append('scope', options?.scope ?? 'global');
        form.append('workspace', options?.workspace ?? 'default');
        return apiClient.post('/skills/install-from-upload', form, {
            headers: { 'Content-Type': undefined },
        });
    },
};

// Config API（先配 supported providers，再配模型；数据来自 provider-support + config）
export const configAPI = {
    getConfig: () => apiClient.get('/config'),
    updateConfig: (updates) => apiClient.put('/config', updates),
    getProviders: () => apiClient.get('/config/providers'),
    getProviderSupport: () => apiClient.get('/config/provider-support'),
    getModels: (provider, type) => apiClient.get(`/config/providers/${encodeURIComponent(provider)}/models`, { params: type ? { type } : {} }),
    /** OpenCode 免费/推荐模型列表，供代理配置界面下拉选择 */
    getOpencodeFreeModels: () => apiClient.get('/config/opencode-free-models'),
};

// Auth API（登录）
export const authAPI = {
    login: (username, password) => apiClient.post('/auth/login', { username, password }),
};

// Users API（用户管理）
export const usersAPI = {
    list: () => apiClient.get('/users'),
    create: (username, password) => apiClient.post('/users', { username, password }),
    update: (id, updates) => apiClient.put(`/users/${id}`, updates),
    delete: (id) => apiClient.delete(`/users/${id}`),
};

// Tasks API (定时任务)
export const tasksAPI = {
    list: () => apiClient.get('/tasks'),
    get: (id) => apiClient.get(`/tasks/${id}`),
    create: (body) => apiClient.post('/tasks', body),
    update: (id, body) => apiClient.put(`/tasks/${id}`, body),
    delete: (id) => apiClient.delete(`/tasks/${id}`),
    listExecutions: (taskId) => apiClient.get(`/tasks/${taskId}/executions`),
    getExecution: (eid) => apiClient.get(`/tasks/executions/${eid}`),
    clearExecutions: (taskId) => apiClient.delete(`/tasks/${taskId}/executions`),
};

// Usage API (token 统计)
export const usageAPI = {
    getTotal: () => apiClient.get('/usage/total'),
    record: (dto) => apiClient.post('/usage', dto),
};

// Tags API（收藏标签，供 URL 收藏技能使用）
export const tagsAPI = {
    list: () => apiClient.get('/tags'),
    get: (id) => apiClient.get(`/tags/${id}`),
    create: (body) => apiClient.post('/tags', body),
    update: (id, body) => apiClient.put(`/tags/${id}`, body),
    delete: (id) => apiClient.delete(`/tags/${id}`),
};

// Saved items API（URL 收藏）
export const savedItemsAPI = {
    list: (params) => apiClient.get('/saved-items', { params: params || {} }),
    get: (id) => apiClient.get(`/saved-items/${id}`),
    create: (body) => apiClient.post('/saved-items', body),
    delete: (id) => apiClient.delete(`/saved-items/${id}`),
    /** 将收藏的 URL 下载到当前工作空间的 .favorite 目录 */
    downloadToWorkspace: (id, body = {}) =>
        apiClient.post(`/saved-items/${id}/download-to-workspace`, body),
};

// Workspace API
export const workspaceAPI = {
    listWorkspaces: () => apiClient.get('/workspace'),
    getCurrentWorkspace: () => apiClient.get('/workspace/current'),
    listDocuments: (workspace, path = '') =>
        apiClient.get('/workspace/documents', { params: { workspace, path } }),
    fileServeUrl: (workspace, path, download = false) => {
        const base = apiClient.defaults.baseURL || '/server-api';
        const params = new URLSearchParams({ workspace, path });
        if (download) params.set('download', '1');
        return `${base}/workspace/files/serve?${params.toString()}`;
    },
    deleteDocument: (workspace, path) =>
        apiClient.delete('/workspace/files', { params: { workspace, path } }),
};

export default apiClient;
