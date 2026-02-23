<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="assistant-avatar-svg"
    aria-hidden="true"
  >
    <!-- 机器人/智能体头像：圆头 + 天线 + 双眼 + 微笑弧，简洁专业 -->
    <circle cx="12" cy="11" r="6" />
    <path d="M10 5v-2M14 5v-2" />
    <circle cx="9.5" cy="10" r="1" fill="currentColor" />
    <circle cx="14.5" cy="10" r="1" fill="currentColor" />
    <path d="M9.5 13c0 0 1.2 1 2.5 1s2.5-1 2.5-1" />
  </svg>
</template>

<script>
export default { name: 'IconAssistantAvatar' };
</script>

<style scoped>
.assistant-avatar-svg {
  display: block;
  width: 1.5rem;
  height: 1.5rem;
  color: #fff;
}
</style>
