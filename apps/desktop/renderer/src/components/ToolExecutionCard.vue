<template>
  <div class="tool-execution-card" :class="`status-${tool.status}`">
    <div class="tool-header" @click="toggleExpanded">
      <div class="tool-info">
        <span class="tool-icon">🔧</span>
        <span class="tool-name">{{ tool.name }}</span>
        <span class="badge" :class="`badge-${tool.status}`">
          {{ tool.status }}
        </span>
      </div>
      <div class="tool-actions">
        <span v-if="tool.endTime" class="tool-duration">
          {{ duration }}ms
        </span>
        <span class="expand-icon">{{ isExpanded ? '▼' : '▶' }}</span>
      </div>
    </div>
    <!-- 状态动画进度条：running 流动，completed/error 从 0 填充到 100% -->
    <div class="progress-track" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100">
      <div
        class="progress-fill"
        :class="{
          'progress-indeterminate': tool.status === 'running',
          'progress-complete': tool.status === 'completed' || tool.status === 'error'
        }"
        :style="progressStyle"
      />
    </div>

    <div v-if="isExpanded" class="tool-body">
      <div v-if="tool.args" class="tool-section">
        <div class="section-label">Arguments:</div>
        <pre class="code-block">{{ formatJSON(tool.args) }}</pre>
      </div>
      
      <div v-if="tool.result" class="tool-section">
        <div class="section-label">Result:</div>
        <pre class="code-block">{{ formatResult(tool.result) }}</pre>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, computed } from 'vue';

export default {
  name: 'ToolExecutionCard',
  props: {
    tool: {
      type: Object,
      required: true,
    },
  },
  setup(props) {
    const isExpanded = ref(false);

    const duration = computed(() => {
      if (props.tool.endTime && props.tool.startTime) {
        return props.tool.endTime - props.tool.startTime;
      }
      return 0;
    });

    const progressPercent = computed(() => {
      if (props.tool.status === 'completed' || props.tool.status === 'error') return 100;
      if (props.tool.status === 'running') return 0;
      return 0;
    });

    const progressStyle = computed(() => {
      if (props.tool.status === 'running') return {};
      if (props.tool.status === 'completed' || props.tool.status === 'error') {
        return { width: '0%' }; /* 由 .progress-complete 动画填充到 100% */
      }
      return { width: '0%' };
    });

    const toggleExpanded = () => {
      isExpanded.value = !isExpanded.value;
    };

    const formatJSON = (obj) => {
      return JSON.stringify(obj, null, 2);
    };

    const formatResult = (result) => {
      if (typeof result === 'string') {
        return result;
      }
      return JSON.stringify(result, null, 2);
    };

    return {
      isExpanded,
      duration,
      progressPercent,
      progressStyle,
      toggleExpanded,
      formatJSON,
      formatResult,
    };
  },
};
</script>

<style scoped>
.tool-execution-card {
  background: var(--color-bg-secondary);
  border-left: 3px solid var(--color-info);
  border-radius: var(--radius-md);
  overflow: hidden;
  transition: all var(--transition-base);
}

.status-running {
  border-left-color: var(--color-status-active);
}

.status-completed {
  border-left-color: var(--color-success);
}

.status-error {
  border-left-color: var(--color-error);
}

.tool-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-md);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.tool-header:hover {
  background: var(--color-bg-tertiary);
}

.tool-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.tool-icon {
  font-size: 1.25rem;
}

.tool-name {
  font-family: var(--font-family-mono);
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-primary);
}

.tool-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
}

.tool-duration {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-family: var(--font-family-mono);
}

.expand-icon {
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.tool-body {
  padding: var(--spacing-md);
  border-top: 1px solid var(--glass-border);
  background: var(--color-bg-primary);
}

.tool-section {
  margin-bottom: var(--spacing-md);
}

.tool-section:last-child {
  margin-bottom: 0;
}

.section-label {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-secondary);
  margin-bottom: var(--spacing-xs);
}

.code-block {
  font-family: var(--font-family-mono);
  font-size: var(--font-size-sm);
  background: var(--color-bg-tertiary);
  padding: var(--spacing-sm);
  border-radius: var(--radius-sm);
  overflow-x: auto;
  color: var(--color-text-primary);
  margin: 0;
}

.badge-running {
  background: var(--color-status-active);
  color: var(--color-bg-primary);
  animation: pulse 2s ease-in-out infinite;
}

.badge-completed {
  background: var(--color-success);
  color: var(--color-bg-primary);
}

.badge-error {
  background: var(--color-error);
  color: white;
}

/* 状态动画进度条 */
.progress-track {
  height: 3px;
  background: var(--color-bg-tertiary);
  overflow: hidden;
  border-radius: 0 0 var(--radius-md) var(--radius-md);
}

.progress-fill {
  height: 100%;
  border-radius: 0 2px 2px 0;
  transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.status-running .progress-fill {
  background: linear-gradient(
    90deg,
    var(--color-status-active) 0%,
    var(--color-info) 50%,
    var(--color-status-active) 100%
  );
  background-size: 200% 100%;
}

.status-running .progress-fill.progress-indeterminate {
  width: 40% !important;
  animation: progress-shimmer 1.5s ease-in-out infinite;
}

.status-completed .progress-fill.progress-complete {
  background: linear-gradient(90deg, var(--color-info), var(--color-success));
  animation: progress-fill-up 0.45s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

.status-error .progress-fill.progress-complete {
  background: linear-gradient(90deg, var(--color-warning), var(--color-error));
  animation: progress-fill-up 0.45s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

@keyframes progress-fill-up {
  to {
    width: 100% !important;
  }
}

@keyframes progress-shimmer {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(350%);
  }
}
</style>
