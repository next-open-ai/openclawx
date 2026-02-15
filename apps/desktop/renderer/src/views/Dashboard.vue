<template>
  <div class="dashboard">
    <!-- Welcome Header -->
    <div class="welcome-header">
      <div class="welcome-content">
        <h2 class="welcome-title">{{ t('dashboard.welcome') }}</h2>
        <p class="welcome-text">{{ t('dashboard.welcomeDesc') }}</p>
      </div>
      <div class="quick-stats-row">
        <div class="stat-item">
          <span class="stat-val">{{ activeSessions }}</span>
          <span class="stat-lbl">{{ t('dashboard.activeSessions') }}</span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-val">{{ totalSkills }}</span>
          <span class="stat-lbl">{{ t('dashboard.totalSkills') }}</span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-val">{{ formatTokens(totalTokens) }}</span>
          <span class="stat-lbl">{{ t('dashboard.tokensUsed') }}</span>
        </div>
      </div>
    </div>

    <div class="dashboard-grid">
      <!-- Main Column -->
      <div class="main-column">
        <!-- Quick Actions -->
        <div class="section-card card-glass">
          <h3 class="section-title">{{ t('dashboard.quickActions') }}</h3>
          <div class="actions-grid">
            <button @click="createNewSession" class="action-card btn-glass">
              <span class="action-icon">➕</span>
              <div class="action-details">
                <span class="action-name">{{ t('chat.newSession') }}</span>
                <span class="action-desc">{{ t('dashboard.newSessionDesc') }}</span>
              </div>
            </button>
            <router-link to="/skills" class="action-card btn-glass">
              <span class="action-icon">🎯</span>
              <div class="action-details">
                <span class="action-name">{{ t('nav.skills') }}</span>
                <span class="action-desc">{{ t('dashboard.browseSkillsDesc') }}</span>
              </div>
            </router-link>
            <router-link to="/agents" class="action-card btn-glass">
              <span class="action-icon">⚙️</span>
              <div class="action-details">
                <span class="action-name">{{ t('settings.agentConfig') }}</span>
                <span class="action-desc">{{ t('dashboard.configureAgentDesc') }}</span>
              </div>
            </router-link>
          </div>
        </div>

        <!-- Recent Activity -->
        <div class="section-card card-glass">
          <div class="section-header">
            <h3 class="section-title">{{ t('dashboard.recentSessions') }}</h3>
            <router-link to="/sessions" class="more-link">{{ t('common.viewAll') }} →</router-link>
          </div>
          
          <div v-if="recentSessions.length === 0" class="empty-state">
            <p class="text-muted">{{ t('dashboard.noSessions') }}</p>
          </div>
          <div v-else class="sessions-list">
            <div
              v-for="session in recentSessions"
              :key="session.id"
              class="session-row"
              @click="openSession(session.id)"
            >
              <div class="session-icon">💬</div>
              <div class="session-info">
                <span class="session-id">{{ session.title || session.id.substring(0, 8) }}</span>
                <span class="session-date">{{ formatDate(session.createdAt) }}</span>
              </div>
              <span class="badge" :class="`badge-${session.status}`">
                {{ session.status }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Side Column -->
      <div class="side-column">
        <!-- Token Usage -->
        <div class="section-card card-glass">
          <h3 class="section-title">{{ t('dashboard.tokenUsage') }}</h3>
          <div class="token-chart">
            <!-- Mock Chart Visualization -->
            <div class="chart-bars">
              <div class="chart-bar" style="height: 40%"></div>
              <div class="chart-bar" style="height: 65%"></div>
              <div class="chart-bar" style="height: 30%"></div>
              <div class="chart-bar active" style="height: 85%"></div>
              <div class="chart-bar" style="height: 50%"></div>
              <div class="chart-bar" style="height: 60%"></div>
              <div class="chart-bar" style="height: 45%"></div>
            </div>
            <div class="token-stats">
              <div class="token-stat">
                <span class="token-label">{{ t('dashboard.totalTokens') }}</span>
                <span class="token-value">{{ formatTokens(totalTokens) }}</span>
              </div>
              <div class="token-stat">
                <span class="token-label">{{ t('dashboard.cost') }}</span>
                <span class="token-value">—</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Followed Info / News -->
        <div class="section-card card-glass">
          <h3 class="section-title">{{ t('dashboard.followedInfo') }}</h3>
          <div class="info-list">
            <div class="info-item">
              <span class="info-tag badge-info">Update</span>
              <span class="info-text">OpenBot v1.2 is now available with new skills.</span>
            </div>
             <div class="info-item">
              <span class="info-tag badge-success">Tip</span>
              <span class="info-text">Try using 'Research' skill for better results.</span>
            </div>
             <div class="info-item">
              <span class="info-tag badge-warning">Alert</span>
              <span class="info-text">High traffic on DeepSeek API today.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from '@/composables/useI18n';
import { useAgentStore } from '@/store/modules/agent';
import { useSkillStore } from '@/store/modules/skill';

export default {
  name: 'Dashboard',
  setup() {
    const router = useRouter();
    const agentStore = useAgentStore();
    const skillStore = useSkillStore();
    const { t } = useI18n();

    const totalTokens = computed(() => agentStore.totalTokens);

    const sessions = computed(() => agentStore.sessions);
    const activeSessions = computed(() => agentStore.activeSessions.length);
    const totalSkills = computed(() => skillStore.skills.length);
    const recentSessions = computed(() => sessions.value.slice(0, 5));

    const formatDate = (timestamp) => {
      return new Date(timestamp).toLocaleString();
    };

    const formatTokens = (n) => {
      if (n == null || n === 0) return '0';
      return Number(n).toLocaleString();
    };

    // 与对话页「新建对话」一致：只跳转到空白对话页，不预先创建 session；用户发首条消息时由 sendMessage 懒创建
    const createNewSession = () => {
      router.push('/chat');
    };

    const openSession = (sessionId) => {
      router.push(`/chat/${sessionId}`);
    };

    onMounted(() => {
      skillStore.fetchSkills();
      agentStore.fetchUsageTotal();
    });

    return {
      sessions,
      activeSessions,
      totalSkills,
      recentSessions,
      totalTokens,
      formatDate,
      formatTokens,
      createNewSession,
      openSession,
      t,
    };
  },
};
</script>

<style scoped>
.dashboard {
  max-width: 1400px;
  margin: 0 auto;
  padding-bottom: var(--spacing-xl);
}

.welcome-header {
  margin-bottom: var(--spacing-xl);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-xl);
  background: var(--gradient-primary);
  border-radius: var(--radius-xl);
  color: white;
  box-shadow: var(--shadow-lg);
}

.welcome-content {
  flex: 1;
}

.welcome-title {
  font-size: var(--font-size-3xl);
  font-weight: 700;
  margin-bottom: var(--spacing-xs);
}

.welcome-text {
  font-size: var(--font-size-lg);
  opacity: 0.9;
}

.quick-stats-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-xl);
  padding-left: var(--spacing-xl);
  border-left: 1px solid rgba(255, 255, 255, 0.2);
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.stat-val {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  line-height: 1.2;
}

.stat-lbl {
  font-size: var(--font-size-sm);
  opacity: 0.8;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.stat-divider {
  width: 1px;
  height: 40px;
  background: rgba(255, 255, 255, 0.2);
}

/* Grid Layout */
.dashboard-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: var(--spacing-lg);
}

.main-column,
.side-column {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}

.section-card {
  padding: var(--spacing-lg);
  border-radius: var(--radius-lg);
  height: 100%;
}

.section-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  margin-bottom: var(--spacing-lg);
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.more-link {
  font-size: var(--font-size-sm);
  color: var(--color-accent-primary);
  opacity: 0.8;
  transition: opacity var(--transition-fast);
}

.more-link:hover {
  opacity: 1;
}

/* Quick Actions */
.actions-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--spacing-md);
}

.action-card {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
  background: var(--color-bg-secondary);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-base);
  text-align: left;
  text-decoration: none;
  color: inherit;
}

.action-card:hover {
  background: var(--color-bg-elevated);
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
  border-color: var(--color-accent-primary);
}

.action-icon {
  font-size: 2rem;
  background: var(--color-bg-tertiary);
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
}

.action-details {
  display: flex;
  flex-direction: column;
}

.action-name {
  font-weight: 600;
  color: var(--color-text-primary);
  margin-bottom: 2px;
}

.action-desc {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

/* Sessions List */
.sessions-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.session-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.session-row:hover {
  background: var(--color-bg-elevated);
}

.session-icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-secondary);
  border-radius: 50%;
  font-size: 1.2rem;
}

.session-info {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.session-id {
  font-weight: 500;
  color: var(--color-text-primary);
}

.session-date {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

/* Token Chart (Mock) */
.token-chart {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.chart-bars {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  height: 100px;
  padding-bottom: var(--spacing-xs);
  border-bottom: 1px solid var(--glass-border);
}

.chart-bar {
  width: 12%;
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  transition: height 0.5s ease;
}

.chart-bar.active {
  background: var(--color-accent-primary);
}

.token-stats {
  display: flex;
  justify-content: space-between;
}

.token-stat {
  display: flex;
  flex-direction: column;
}

.token-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.token-value {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text-primary);
}

/* Info List */
.info-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.info-item {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-sm);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.info-tag {
  flex-shrink: 0;
  padding: 2px 6px;
  font-size: 10px;
  border-radius: 4px;
}

@media (max-width: 1024px) {
  .dashboard-grid {
    grid-template-columns: 1fr;
  }
}
</style>
