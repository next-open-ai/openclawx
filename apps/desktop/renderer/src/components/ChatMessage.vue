<template>
  <div class="chat-message" :class="[`message-${role}`, { 'message-error': isError }]">
    <div class="message-avatar">
      <span class="avatar-icon">
        <IconAssistantAvatar v-if="role !== 'user'" />
        <span v-else>👤</span>
      </span>
    </div>
    <div class="message-content">
      <div class="message-header">
        <span class="message-role">{{ roleLabel }}</span>
        <span v-if="isError" class="message-error-badge">{{ errorLabel }}</span>
        <span class="message-time">{{ formatTime(timestamp) }}</span>
      </div>
      
      <!-- Grouped Content rendering -->
      <div v-if="contentParts && contentParts.length > 0" class="message-body has-steps">
        <div v-for="(step, index) in groupedParts" :key="index" class="message-step">
          <!-- Text/Thought Part: Only show if text is not empty string/whitespace -->
          <div v-if="step.text && step.text.trim().length > 0" class="step-thought" v-html="renderMarkdown(step.text)"></div>
          
          <!-- Tools Part -->
          <div v-if="step.tools.length > 0" class="step-tools">
            <ToolExecutionCard
              v-for="toolId in step.tools"
              :key="toolId"
              :tool="getTool(toolId)"
            />
          </div>
        </div>
      </div>

      <!-- 错误消息：纯文本展示，不解析 markdown -->
      <div v-else-if="isError && content" class="message-body message-body-error">
        <p class="message-error-text">{{ content }}</p>
      </div>
      <!-- Legacy/Fallback rendering -- only if content exists -->
      <div v-else-if="renderedContent && renderedContent.trim() !== ''" class="message-body">
        <div v-html="renderedContent"></div>
        <div v-if="toolCalls && toolCalls.length > 0" class="tool-calls">
          <ToolExecutionCard
            v-for="tool in toolCalls"
            :key="tool.id"
            :tool="tool"
          />
        </div>
      </div>

    </div>
  </div>
</template>

<script>
import { computed } from 'vue';
import { marked } from 'marked';
import { useI18n } from '@/composables/useI18n';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import ToolExecutionCard from './ToolExecutionCard.vue';
import IconAssistantAvatar from './icons/IconAssistantAvatar.vue';

// Configure marked
marked.setOptions({
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
});

export default {
  name: 'ChatMessage',
  components: {
    ToolExecutionCard,
    IconAssistantAvatar,
  },
  props: {
    role: {
      type: String,
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    timestamp: {
      type: Number,
      required: true,
    },
    toolCalls: {
      type: Array,
      default: () => [],
    },
    contentParts: {
      type: Array,
      default: () => null,
    },
    isError: {
      type: Boolean,
      default: false,
    },
  },
  setup(props) {
    const { t } = useI18n();
    const roleLabel = computed(() =>
      props.role === 'user' ? t('chat.you') : t('chat.assistant')
    );
    const errorLabel = computed(() => t('chat.replyFailed'));
    const renderedContent = computed(() => {
      try {
        return marked.parse(props.content || '');
      } catch (e) {
        console.error('Render markdown error', e);
        return props.content || '';
      }
    });

    const renderMarkdown = (text) => {
      try {
        return marked.parse(text || '');
      } catch (e) {
        console.error('Render markdown error', e);
        return text || '';
      }
    };

    const getTool = (toolId) => {
      if (!props.toolCalls) return null;
      return props.toolCalls.find(t => t.id === toolId);
    };

    const formatTime = (timestamp) => {
      const date = new Date(timestamp);
      return date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
      });
    };

    const groupedParts = computed(() => {
      if (!props.contentParts) return [];
      
      const steps = [];
      let currentStep = { text: '', tools: [] };
      let hasContent = false;

      props.contentParts.forEach(part => {
        if (part.type === 'text') {
            if (currentStep.tools.length > 0) {
                 steps.push(currentStep);
                 currentStep = { text: '', tools: [] };
            }
            currentStep.text += part.content;
            hasContent = true;
        } else if (part.type === 'tool') {
            currentStep.tools.push(part.toolId);
            hasContent = true;
        }
      });

      if (hasContent) {
        steps.push(currentStep);
      }

      // 渐进式显示：若某步只有一段文字+多个工具，拆成多步（每步文字+一个工具，后续步仅工具）
      const expanded = [];
      for (const step of steps) {
        if (step.tools.length <= 1) {
          expanded.push(step);
          continue;
        }
        // 多工具：第一步保留文字+第一个工具，后续每步一个工具
        expanded.push({
          text: step.text,
          tools: [step.tools[0]],
        });
        for (let i = 1; i < step.tools.length; i++) {
          expanded.push({ text: '', tools: [step.tools[i]] });
        }
      }
      return expanded;
    });

    return {
      roleLabel,
      errorLabel,
      renderedContent,
      renderMarkdown,
      getTool,
      formatTime,
      groupedParts,
    };
  },
};
</script>

<style scoped>
.chat-message {
  display: flex;
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
  animation: slideInUp 0.3s ease-out;
}

.message-user {
  flex-direction: row-reverse;
}

.message-avatar {
  flex-shrink: 0;
}

.avatar-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--gradient-primary);
  font-size: 1.25rem;
  color: #fff;
}

.message-user .avatar-icon {
  background: var(--gradient-secondary);
}

.message-content {
  flex: 1;
  max-width: 80%;
  padding-left: var(--spacing-sm);
  min-width: 0;
}

.message-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-sm);
}

.message-role {
  font-weight: 600;
  color: var(--color-text-primary);
}

.message-time {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.message-body {
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-lg);
  color: var(--color-text-primary);
  line-height: 1.6;
}

.message-user .message-body {
  background: var(--gradient-primary);
  color: #ffffff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
}
.message-user .message-body,
.message-user .message-body :deep(*),
.message-user .message-body :deep(p),
.message-user .message-body :deep(span),
.message-user .message-body :deep(li) {
  color: #ffffff;
}
.message-user .message-body :deep(a) {
  color: #e0e7ff;
  text-decoration: underline;
}

/* If using steps (Assistant structured response), we remove inner padding/bg the message body 
   as each step has its own card-like styling. */
.message-body.has-steps {
  padding: 0;
  background: transparent;
}

/* 回复失败等错误消息样式 */
.chat-message.message-error .message-content .message-header .message-error-badge {
  margin-left: var(--spacing-sm);
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-error, #dc2626);
}
.message-body-error {
  border-left: 3px solid var(--color-error, #dc2626);
  background: rgba(220, 38, 38, 0.06) !important;
}
.message-body-error .message-error-text {
  margin: 0;
  color: var(--color-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Deep selections for markdown content - 对话内统一为正文字号，避免 reasoning/--- 等被解析成标题导致字体过大 */
.message-body :deep(h1),
.message-body :deep(h2),
.message-body :deep(h3),
.message-body :deep(h4),
.message-body :deep(h5),
.message-body :deep(h6) {
  font-size: var(--font-size-base);
  font-weight: 600;
  line-height: 1.5;
  margin: 0.5em 0 0.25em 0;
}

.message-body :deep(p) {
  margin-bottom: var(--spacing-sm);
}

.message-body :deep(ul),
.message-body :deep(ol) {
  padding-left: 1.5em;
}

.message-body :deep(pre) {
  background: var(--color-bg-primary);
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
  overflow-x: auto;
  margin: var(--spacing-sm) 0;
}

/* Grouped Step Styles */
.message-step {
  margin-bottom: var(--spacing-md);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  padding: var(--spacing-lg);
  overflow: hidden;
  transition: all 0.3s ease;
}

.message-step:last-child {
  margin-bottom: 0;
}

.message-step:hover {
  border-color: var(--color-accent-primary);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.step-thought {
  margin-bottom: var(--spacing-md);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
}
.step-thought :deep(h1),
.step-thought :deep(h2),
.step-thought :deep(h3),
.step-thought :deep(h4),
.step-thought :deep(h5),
.step-thought :deep(h6) {
  font-size: var(--font-size-sm);
  font-weight: 600;
  margin: 0.5em 0 0.25em 0;
}
.step-thought :deep(ul),
.step-thought :deep(ol) {
  padding-left: 1.5em;
}

.step-tools {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}
</style>
