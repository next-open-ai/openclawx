<template>
  <div class="skill-card card-glass" @click="$emit('click')">
    <div class="card-content">
      <div class="skill-icon">
        <span v-if="skill.icon">{{ skill.icon }}</span>
        <span v-else>🎯</span>
      </div>
      <div class="skill-info">
        <h3 class="skill-name">{{ skill.name }}</h3>
        <p class="skill-summary">{{ truncate(skill.description, 60) }}</p>
      </div>
    </div>
    <div class="card-footer">
      <span class="view-details">{{ t('common.details') }} →</span>
    </div>
  </div>
</template>

<script>
import { useI18n } from '@/composables/useI18n';

export default {
  name: 'SkillCard',
  props: {
    skill: {
      type: Object,
      required: true,
    },
  },
  emits: ['click'],
  setup() {
    const { t } = useI18n();

    const truncate = (text, length) => {
      if (!text) return '';
      return text.length > length ? text.substring(0, length) + '...' : text;
    };

    return { t, truncate };
  },
};
</script>

<style scoped>
.skill-card {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: var(--spacing-lg);
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
  height: 100%;
  border: 1px solid var(--glass-border);
  background: var(--color-bg-secondary);
}

.skill-card:hover {
  transform: translateY(-4px);
  background: var(--color-bg-tertiary);
  border-color: var(--color-accent-primary);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

.skill-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.05) 0%, transparent 100%);
  opacity: 0;
  transition: opacity 0.3s ease;
}

.skill-card:hover::before {
  opacity: 1;
}

.card-content {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-md);
}

.skill-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.5rem;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
}

.skill-info {
  flex: 1;
  min-width: 0;
}

.skill-name {
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--color-text-primary);
  margin-bottom: var(--spacing-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.skill-summary {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-top: auto;
}

.view-details {
  font-size: var(--font-size-xs);
  color: var(--color-accent-primary);
  font-weight: 500;
  opacity: 0;
  transform: translateX(-10px);
  transition: all 0.3s ease;
}

.skill-card:hover .view-details {
  opacity: 1;
  transform: translateX(0);
}
</style>
