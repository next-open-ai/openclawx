import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import pinia from './store';
import socketService from './api/socket';
import { useAgentStore } from './store/modules/agent';
import './assets/styles/main.css';

const app = createApp(App);

app.use(router);
app.use(pinia);

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
socketService.on('conversation_end', (data) => {
  agentStore.handleConversationEnd(data);
});

app.mount('#app');
