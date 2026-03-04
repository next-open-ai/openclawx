import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import pinia from './store';
import socketService from './api/socket';
import apiClient from './api';
import { useAgentStore } from './store/modules/agent';
import './assets/styles/main.css';

const app = createApp(App);

app.use(router);
app.use(pinia);

/** 桌面内嵌 Gateway 实际端口（端口被占时可能非 38080），供 API/WS 使用 */
async function initGatewayPort() {
    if (typeof window.electronAPI?.getGatewayPort !== 'function') return;
    try {
        const port = await window.electronAPI.getGatewayPort();
        const p = typeof port === 'number' ? port : parseInt(port, 10);
        if (Number.isInteger(p) && p > 0) {
            window.__GATEWAY_PORT__ = p;
            apiClient.defaults.baseURL = `http://127.0.0.1:${p}/server-api`;
        }
    } catch (_) {}
}

(async () => {
    await initGatewayPort();
    // Connect to WebSocket 并只注册一次事件（避免在组件里重复注册导致同一事件被处理多次）
    socketService.connect();
    const agentStore = useAgentStore();
    socketService.on('agent_chunk', (data) => {
        agentStore.handleAgentChunk(data);
    });
    socketService.on('agent_tool', (data) => {
        agentStore.handleToolExecution(data);
    });
    socketService.on('message_complete', (data) => {
        agentStore.handleMessageComplete(data);
    });
    socketService.on('agent_end', (data) => {
        agentStore.handleConversationEnd(data);
    });
    socketService.on('conversation_end', (data) => {
        agentStore.handleConversationEnd(data);
    });
    socketService.on('system_message', (data) => {
        agentStore.handleSystemMessage(data);
    });
    app.mount('#app');
})();
