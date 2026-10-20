<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getHealth } from '../../services/api';

const status = ref('正在连接本地服务…');
onMounted(async () => {
  try { status.value = `${(await getHealth()).service} 已就绪`; }
  catch { status.value = '本地服务暂未就绪'; }
});
</script>

<template>
  <main class="home-screen">
    <p class="eyebrow">OpenClawX / FOUNDATION READY</p>
    <h1>你的本地 AI 工作台</h1>
    <p class="description">Electron、独立 Vue 界面、Fastify API 与 Agent Core 已完成基础连接。</p>
    <p class="status" role="status">{{ status }}</p>
  </main>
</template>
