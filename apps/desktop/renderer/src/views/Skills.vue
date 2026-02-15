<template>
  <div class="skills-view">
    <!-- Sidebar -->
    <div class="skills-sidebar card-glass">
      <div class="sidebar-header">
        <h2>{{ t('nav.skills') }}</h2>
      </div>
      
      <div class="skills-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="tab-btn"
          :class="{ active: activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          <span class="tab-icon">{{ tab.icon }}</span>
          <span class="tab-label">{{ tab.label }}</span>
          <span class="tab-count" v-if="getSkillCount(tab.id)">{{ getSkillCount(tab.id) }}</span>
        </button>
      </div>
    </div>

    <!-- Content Area -->
    <div class="skills-content-wrapper">
      <div class="content-header">
        <div class="header-left">
          <h1 class="view-title">{{ activeTabLabel }}</h1>
          <p class="text-secondary">{{ getTabDescription(activeTab) }}</p>
        </div>
        
        <!-- Install Button (Hidden for System) -->
        <div class="header-right" v-if="activeTab !== 'system'">
          <button class="btn-primary" @click="handleInstall" :title="t('skills.installHint')">
            <span class="icon">+</span>
            {{ t('skills.install') }}
          </button>
        </div>
      </div>

      <!-- Loading State -->
      <div v-if="loading && !skills.length" class="loading-state">
        <div class="spinner"></div>
        <p>{{ t('common.loading') }}</p>
      </div>

      <!-- Empty State -->
      <div v-else-if="filteredSkills.length === 0" class="empty-state">
        <div class="empty-icon">📦</div>
        <h3>{{ t('skills.noSkills') }}</h3>
        <p class="text-secondary">{{ t('skills.noSkillsHint') }}</p>
        <button v-if="activeTab !== 'system'" class="btn-secondary mt-4" @click="handleInstall">
          {{ t('skills.install') }}
        </button>
      </div>

      <!-- Skills Grid -->
      <div v-else class="skills-grid-container">
        <!-- Group by category if needed, or just flat grid -->
        <div class="skills-grid">
          <SkillCard
            v-for="skill in filteredSkills"
            :key="skill.name"
            :skill="skill"
            @click="selectSkill(skill.name)"
          />
        </div>
      </div>
    </div>

    <!-- Skill Detail Modal -->
    <transition name="fade">
      <div v-if="selectedSkill" class="skill-modal-backdrop" @click.self="closeSkill">
        <div class="modal-content card-glass">
          <div class="modal-header">
            <div class="modal-title-group">
              <div class="skill-icon-large">
                <span v-if="selectedSkill.icon">{{ selectedSkill.icon }}</span>
                <span v-else>🎯</span>
              </div>
              <div>
                <h2>{{ selectedSkill.name }}</h2>
                <div class="modal-badges">
                  <span class="badge badge-info">{{ selectedSkill.category || 'Uncategorized' }}</span>
                  <span class="badge badge-secondary">{{ t(`skills.sources.${selectedSkill.source || 'system'}`) }}</span>
                </div>
              </div>
            </div>
            <button @click="closeSkill" class="close-btn btn-ghost" :title="t('common.close')">✕</button>
          </div>
          
          <div class="modal-body">
            <div v-if="loadingContent" class="loading-content">
              <div class="spinner"></div>
            </div>
            <div v-else-if="skillContent" class="skill-documentation markdown-body" v-html="renderedContent"></div>
            <div v-else class="no-content">
              <p>{{ t('skills.noDocumentation') }}</p>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import { computed, onMounted, ref } from 'vue';
import { useSkillStore } from '@/store/modules/skill';
import { marked } from 'marked';
import { useI18n } from '@/composables/useI18n';
import SkillCard from '@/components/SkillCard.vue';

export default {
  name: 'Skills',
  components: {
    SkillCard,
  },
  setup() {
    const skillStore = useSkillStore();
    const { t } = useI18n();
    const loadingContent = ref(false);
    const activeTab = ref('system');

    const skills = computed(() => skillStore.skills);
    const selectedSkill = computed(() => skillStore.selectedSkill);
    const skillContent = computed(() => skillStore.skillContent);
    const loading = computed(() => skillStore.loading);

    const tabs = computed(() => [
      { id: 'system', label: t('skills.sources.system'), icon: '🔒' },
      { id: 'global', label: t('skills.sources.global'), icon: '🌍' },
      { id: 'workspace', label: t('skills.sources.workspace'), icon: '💼' },
    ]);

    const activeTabLabel = computed(() => {
      const tab = tabs.value.find(t => t.id === activeTab.value);
      return tab ? tab.label : '';
    });

    const getTabDescription = (tabId) => {
      if (tabId === 'system') return t('skills.sources.systemDesc');
      if (tabId === 'global') return t('skills.sources.globalDesc');
      return t('skills.sources.workspaceDesc');
    };

    const getSkillCount = (source) => {
      return skills.value.filter(s => (s.source || 'system') === source).length;
    };

    const filteredSkills = computed(() => {
      return skills.value.filter(s => (s.source || 'system') === activeTab.value);
    });

    const renderedContent = computed(() => {
      if (skillContent.value) {
        return marked(skillContent.value);
      }
      return '';
    });

    const selectSkill = async (name) => {
      loadingContent.value = true;
      await skillStore.selectSkill(name);
      loadingContent.value = false;
    };

    const closeSkill = () => {
      skillStore.clearSelection();
    };

    const handleInstall = () => {
      alert(t('skills.installHint'));
    };

    onMounted(() => {
      skillStore.fetchSkills();
    });

    return {
      t,
      skills,
      filteredSkills,
      selectedSkill,
      skillContent,
      loading,
      loadingContent,
      renderedContent,
      selectSkill,
      closeSkill,
      activeTab,
      tabs,
      activeTabLabel,
      getSkillCount,
      getTabDescription,
      handleInstall,
    };
  },
};
</script>

<style scoped>
.skills-view {
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  display: flex;
  gap: var(--spacing-xl);
  padding: var(--spacing-lg);
  overflow: hidden;
}

/* Sidebar */
.skills-sidebar {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: var(--spacing-lg);
  border-radius: var(--radius-lg);
  background: var(--color-bg-secondary);
  border: 1px solid var(--glass-border);
  min-height: 0;
  align-self: stretch;
}

.sidebar-header {
  margin-bottom: var(--spacing-xl);
  padding-bottom: var(--spacing-md);
  border-bottom: 1px solid var(--glass-border);
}

.sidebar-header h2 {
  font-size: var(--font-size-lg);
  font-weight: 700;
  margin: 0;
}

.skills-tabs {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  text-align: left;
  transition: all var(--transition-fast);
  border: 1px solid transparent;
  background: transparent;
  width: 100%;
}

.tab-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.tab-btn.active {
  background: var(--color-bg-elevated);
  color: var(--color-accent-primary);
  border-color: var(--glass-border);
  box-shadow: var(--shadow-sm);
  font-weight: 600;
}

.tab-icon {
  font-size: 1.2rem;
}

.tab-count {
  margin-left: auto;
  font-size: var(--font-size-xs);
  background: var(--color-bg-tertiary);
  padding: 2px 8px;
  border-radius: 10px;
  color: var(--color-text-tertiary);
}

.tab-btn.active .tab-count {
  background: var(--color-accent-primary);
  color: white;
}

/* Content Area - fills remaining space */
.skills-content-wrapper {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.content-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: var(--spacing-lg);
  flex-shrink: 0;
}

.view-title {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  color: var(--color-text-primary);
  margin: 0 0 var(--spacing-xs) 0;
}

.btn-primary {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-lg);
  background: var(--color-accent-primary);
  color: white;
  border-radius: var(--radius-md);
  font-weight: 600;
  transition: all var(--transition-fast);
}

.btn-primary:hover {
  filter: brightness(1.1);
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

/* Grid & States - operating area fills available height */
.skills-grid-container {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  padding-right: var(--spacing-xs);
  padding-bottom: var(--spacing-xl);
}

.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--spacing-lg);
  padding-bottom: var(--spacing-md);
}

.loading-state,
.empty-state {
  flex: 1 1 0;
  min-height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: var(--spacing-2xl);
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--color-bg-elevated);
  border-top-color: var(--color-accent-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: var(--spacing-lg);
}

.empty-icon {
  font-size: 4rem;
  margin-bottom: var(--spacing-lg);
  opacity: 0.5;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Modal - mostly unchanged but scoped */
.skill-modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-modal);
  padding: var(--spacing-lg);
}

.modal-content {
  width: 100%;
  max-width: 900px;
  height: 85vh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-primary);
  box-shadow: var(--shadow-2xl);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-xl);
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: var(--spacing-xl);
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--glass-border);
}

.modal-title-group {
  display: flex;
  gap: var(--spacing-lg);
}

.skill-icon-large {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 2.5rem;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
}

.modal-header h2 {
  font-size: var(--font-size-2xl);
  margin: 0 0 var(--spacing-xs) 0;
  color: var(--color-text-primary);
}

.modal-badges {
  display: flex;
  gap: var(--spacing-sm);
}

.close-btn {
  font-size: 1.5rem;
  padding: var(--spacing-xs) var(--spacing-sm);
  color: var(--color-text-secondary);
  border-radius: var(--radius-md);
  transition: all var(--transition-fast);
}

.close-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-xl) var(--spacing-2xl);
}

.loading-content {
  display: flex;
  justify-content: center;
  padding: var(--spacing-2xl);
}

.skill-documentation {
  color: var(--color-text-primary);
  line-height: 1.6;
}

/* Markdown Styles */
.skill-documentation :deep(h1) { font-size: 2em; border-bottom: 1px solid var(--glass-border); padding-bottom: 0.3em; margin: 0 0 1em 0; }
.skill-documentation :deep(h2) { font-size: 1.5em; margin: 1.5em 0 1em 0; }
.skill-documentation :deep(p) { margin-bottom: 1em; }
.skill-documentation :deep(ul), .skill-documentation :deep(ol) { padding-left: 2em; margin-bottom: 1em; }
.skill-documentation :deep(code) { background: var(--color-bg-tertiary); padding: 0.2em 0.4em; border-radius: var(--radius-sm); font-family: var(--font-family-mono); font-size: 0.9em; }
.skill-documentation :deep(pre) { background: var(--color-bg-tertiary); padding: var(--spacing-md); border-radius: var(--radius-md); overflow-x: auto; margin: 1.5em 0; }
.skill-documentation :deep(pre code) { background: transparent; padding: 0; font-size: 0.9em; }
</style>
