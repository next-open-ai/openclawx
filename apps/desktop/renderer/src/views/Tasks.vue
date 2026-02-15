<template>
  <div class="tasks-view">
    <div class="tasks-header card-glass">
      <div class="header-left">
        <h1 class="view-title">{{ t('tasks.title') }}</h1>
        <p class="text-secondary">{{ t('tasks.subtitle') }}</p>
      </div>
      <button class="btn-primary" @click="openCreateModal">
        <span class="btn-icon">+</span>
        {{ t('tasks.addTask') }}
      </button>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>{{ t('common.loading') }}</p>
    </div>
    <div v-else-if="tasks.length === 0" class="empty-state">
      <div class="empty-icon">⏰</div>
      <p>{{ t('tasks.noTasks') }}</p>
      <p class="text-secondary">{{ t('tasks.noTasksHint') }}</p>
      <button class="btn-primary mt-4" @click="openCreateModal">
        {{ t('tasks.addTask') }}
      </button>
    </div>
    <div v-else class="tasks-list">
      <div
        v-for="task in tasks"
        :key="task.id"
        class="task-card card-glass"
        :class="{ disabled: !task.enabled }"
      >
        <div class="task-main">
          <span class="task-workspace">{{ task.workspace }}</span>
          <p class="task-message">{{ task.message.slice(0, 80) }}{{ task.message.length > 80 ? '…' : '' }}</p>
          <p class="task-schedule text-secondary">
            {{ scheduleLabel(task) }}
          </p>
          <p v-if="task.lastRunAt" class="task-meta text-secondary">
            {{ t('tasks.lastRun') }}: {{ formatTime(task.lastRunAt) }}
          </p>
        </div>
        <div class="task-actions">
          <button
            type="button"
            class="link-btn"
            :title="task.enabled ? t('tasks.enabled') : t('tasks.disabled')"
            @click="toggleEnabled(task)"
          >
            {{ task.enabled ? '✓' : '○' }}
          </button>
          <button type="button" class="link-btn" @click="openExecutions(task)">
            {{ t('tasks.executions') }}
          </button>
          <button type="button" class="link-btn" @click="openEditModal(task)">
            {{ t('tasks.edit') }}
          </button>
          <button type="button" class="link-btn danger" @click="confirmDelete(task)">
            {{ t('common.delete') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 新增/编辑任务弹窗 -->
    <transition name="fade">
      <div v-if="showModal" class="modal-backdrop" @click.self="closeModal">
        <div class="modal-content card-glass modal-wide">
          <div class="modal-header">
            <h2>{{ editingId ? t('tasks.editTask') : t('tasks.addTask') }}</h2>
            <button type="button" class="close-btn" @click="closeModal">✕</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>{{ t('tasks.workspace') }}</label>
              <select v-model="form.workspace" class="form-input" :disabled="!!editingId">
                <option v-for="a in agents" :key="a.id" :value="a.workspace">
                  {{ a.name }} ({{ a.workspace }})
                </option>
              </select>
            </div>
            <div class="form-group">
              <label>{{ t('tasks.message') }}</label>
              <textarea
                v-model="form.message"
                class="form-input"
                rows="3"
                :placeholder="t('tasks.messagePlaceholder')"
              />
            </div>
            <div class="form-group">
              <label>{{ t('tasks.scheduleType') }}</label>
              <select v-model="form.scheduleType" class="form-input">
                <option value="once">{{ t('tasks.once') }}</option>
                <option value="cron">{{ t('tasks.repeating') }}</option>
              </select>
            </div>
            <template v-if="form.scheduleType === 'once'">
              <div class="form-group">
                <label>{{ t('tasks.runAt') }}</label>
                <input v-model="form.runAtLocal" type="datetime-local" class="form-input" />
              </div>
            </template>
            <template v-else>
              <div class="form-group">
                <label>{{ t('tasks.repeatType') }}</label>
                <select v-model="form.repeatType" class="form-input">
                  <option value="daily">{{ t('tasks.daily') }}</option>
                  <option value="weekdays">{{ t('tasks.weekdays') }}</option>
                  <option value="weekends">{{ t('tasks.weekends') }}</option>
                  <option value="weekly">{{ t('tasks.weekly') }}</option>
                  <option value="monthly">{{ t('tasks.monthly') }}</option>
                </select>
              </div>
              <div class="form-group">
                <label>{{ t('tasks.time') }}</label>
                <input v-model="form.time" type="time" class="form-input" />
              </div>
              <div v-if="form.repeatType === 'weekly'" class="form-group">
                <label>{{ t('tasks.weekdaySelect') }}</label>
                <div class="weekdays-row">
                  <label v-for="d in weekDays" :key="d.value" class="weekday-check">
                    <input v-model="form.weeklyDays" type="checkbox" :value="d.value" />
                    {{ d.label }}
                  </label>
                </div>
              </div>
              <div v-if="form.repeatType === 'monthly'" class="form-group">
                <label>{{ t('tasks.dayOfMonth') }}</label>
                <input v-model.number="form.dayOfMonth" type="number" min="1" max="31" class="form-input" />
              </div>
            </template>
            <p v-if="formError" class="form-error">{{ formError }}</p>
            <div class="modal-footer-actions">
              <button type="button" class="btn-secondary" @click="closeModal">{{ t('common.close') }}</button>
              <button type="button" class="btn-primary" :disabled="saving" @click="submitTask">
                {{ saving ? t('common.loading') : (editingId ? t('tasks.save') : t('agents.create')) }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- 执行记录：列表 + 详情 -->
    <transition name="fade">
      <div v-if="executionsTask" class="modal-backdrop" @click.self="closeExecutions">
        <div class="modal-content card-glass modal-wide executions-modal">
          <div class="modal-header">
            <h2>{{ t('tasks.executions') }}: {{ executionsTask.message.slice(0, 30) }}{{ executionsTask.message.length > 30 ? '…' : '' }}</h2>
            <button type="button" class="close-btn" @click="closeExecutions">✕</button>
          </div>
          <div class="modal-body">
            <div v-if="!executionDetail" class="executions-list">
              <div v-if="executions.length > 0" class="executions-actions">
                <button type="button" class="link-btn danger" @click="clearExecutionsForTask">
                  {{ t('tasks.clearExecutions') }}
                </button>
              </div>
              <div v-if="executionsLoading" class="loading-state small">{{ t('common.loading') }}</div>
              <template v-else-if="executions.length === 0">
                <p class="text-secondary">{{ t('tasks.noExecutions') }}</p>
              </template>
              <template v-else>
                <div
                  v-for="ex in executions"
                  :key="ex.id"
                  class="execution-row"
                  @click="openExecutionDetail(ex)"
                >
                  <span class="execution-time">{{ formatTime(ex.ranAt) }}</span>
                  <span class="execution-status" :class="ex.status">{{ ex.status === 'success' ? t('tasks.statusSuccess') : t('tasks.statusFailed') }}</span>
                </div>
              </template>
            </div>
            <div v-else class="execution-detail">
              <button type="button" class="link-btn back-link" @click="executionDetail = null">← {{ t('tasks.backToList') }}</button>
              <button type="button" class="link-btn danger clear-executions-detail-btn" @click="clearExecutionsForTask">{{ t('tasks.clearExecutions') }}</button>
              <p class="detail-meta">
                <span>{{ formatTime(executionDetail.ranAt) }}</span>
                <span class="execution-status" :class="executionDetail.status">{{ executionDetail.status === 'success' ? t('tasks.statusSuccess') : t('tasks.statusFailed') }}</span>
                <span v-if="executionDetail.errorMessage" class="error-msg">{{ executionDetail.errorMessage }}</span>
              </p>
              <div class="conversation-log">
                <h4>{{ t('tasks.conversationLog') }}</h4>
                <div class="log-block user">
                  <span class="log-role">{{ t('tasks.userMessage') }}</span>
                  <pre class="log-content">{{ executionDetail.userMessage }}</pre>
                </div>
                <div v-if="executionDetail.assistantContent" class="log-block assistant">
                  <span class="log-role">{{ t('tasks.assistantReply') }}</span>
                  <pre class="log-content">{{ executionDetail.assistantContent }}</pre>
                </div>
                <div v-else-if="executionDetail.errorMessage" class="log-block assistant">
                  <span class="log-role">{{ t('tasks.assistantReply') }}</span>
                  <p class="text-secondary">{{ t('tasks.noReplyDueToError') }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- 删除确认 -->
    <transition name="fade">
      <div v-if="deleteTarget" class="modal-backdrop" @click.self="deleteTarget = null">
        <div class="modal-content card-glass delete-confirm-modal">
          <div class="modal-header">
            <h2>{{ t('common.delete') }}</h2>
            <button type="button" class="close-btn" @click="deleteTarget = null">✕</button>
          </div>
          <div class="modal-body">
            <p>{{ t('tasks.deleteConfirm') }}</p>
            <div class="modal-footer-actions">
              <button type="button" class="btn-secondary" @click="deleteTarget = null">{{ t('common.close') }}</button>
              <button type="button" class="btn-danger" @click="doDelete">{{ t('common.delete') }}</button>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from '@/composables/useI18n';
import { tasksAPI, agentConfigAPI } from '@/api';

const weekDays = [
  { value: 0, label: '日' },
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
];

/** 与后端一致的 repeatRule -> cron 表达式 */
function repeatRuleToCron(rule) {
  const [h, m] = (rule.time || '09:00').split(':').map(Number);
  const minute = m ?? 0;
  const hour = h ?? 9;
  switch (rule.type) {
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekends':
      return `${minute} ${hour} * * 0,6`;
    case 'weekly':
      if (rule.days?.length) {
        return `${minute} ${hour} * * ${[...rule.days].sort((a, b) => a - b).join(',')}`;
      }
      return `${minute} ${hour} * * *`;
    case 'monthly': {
      const day = Math.min(rule.dayOfMonth ?? 1, 31);
      return `${minute} ${hour} ${day} * *`;
    }
    default:
      return `${minute} ${hour} * * *`;
    }
}

function toDatetimeLocal(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${M}-${D}T${h}:${m}`;
}

export default {
  name: 'Tasks',
  setup() {
    const { t } = useI18n();
    const tasks = ref([]);
    const agents = ref([]);
    const loading = ref(true);
    const showModal = ref(false);
    const editingId = ref(null);
    const deleteTarget = ref(null);
    const executionsTask = ref(null);
    const executions = ref([]);
    const executionsLoading = ref(false);
    const executionDetail = ref(null);
    const saving = ref(false);
    const formError = ref('');
    const form = ref({
      workspace: 'default',
      message: '',
      scheduleType: 'once',
      runAtLocal: '',
      repeatType: 'daily',
      time: '09:00',
      weeklyDays: [1, 2, 3, 4, 5],
      dayOfMonth: 1,
    });

    function scheduleLabel(task) {
      if (task.scheduleType === 'once' && task.runAt) {
        return `${t('tasks.once')}: ${formatTime(task.runAt)}`;
      }
      if (task.cronExpr) return `${t('tasks.repeating')} (${task.cronExpr})`;
      return task.repeatRuleJson || t('tasks.repeating');
    }

    function formatTime(ms) {
      const d = new Date(ms);
      return d.toLocaleString();
    }

    async function loadTasks() {
      try {
        const res = await tasksAPI.list();
        tasks.value = res.data?.data ?? [];
      } catch (e) {
        console.error('Load tasks failed', e);
        tasks.value = [];
      }
    }

    async function loadAgents() {
      try {
        const res = await agentConfigAPI.listAgents();
        const list = res.data?.data ?? [];
        agents.value = list.length ? list : [{ id: 'default', name: '主智能体', workspace: 'default' }];
        if (agents.value.length && !form.value.workspace) form.value.workspace = agents.value[0].workspace;
      } catch (e) {
        agents.value = [{ id: 'default', name: '主智能体', workspace: 'default' }];
      }
    }

    function openCreateModal() {
      editingId.value = null;
      form.value = {
        workspace: agents.value[0]?.workspace ?? 'default',
        message: '',
        scheduleType: 'once',
        runAtLocal: '',
        repeatType: 'daily',
        time: '09:00',
        weeklyDays: [1, 2, 3, 4, 5],
        dayOfMonth: 1,
      };
      formError.value = '';
      showModal.value = true;
    }

    function openEditModal(task) {
      editingId.value = task.id;
      const rule = task.repeatRuleJson
        ? (() => {
            try {
              return JSON.parse(task.repeatRuleJson);
            } catch {
              return { type: 'daily', time: '09:00' };
            }
          })()
        : { type: 'daily', time: '09:00' };
      form.value = {
        workspace: task.workspace,
        message: task.message,
        scheduleType: task.scheduleType,
        runAtLocal: task.runAt ? toDatetimeLocal(task.runAt) : '',
        repeatType: rule.type || 'daily',
        time: rule.time || '09:00',
        weeklyDays: Array.isArray(rule.days) ? [...rule.days] : [1, 2, 3, 4, 5],
        dayOfMonth: Math.min(31, Math.max(1, rule.dayOfMonth ?? 1)),
      };
      formError.value = '';
      showModal.value = true;
    }

    function closeModal() {
      showModal.value = false;
    }

    function buildRepeatRule() {
      const r = form.value;
      const rule = { type: r.repeatType, time: r.time };
      if (r.repeatType === 'weekly') rule.days = [...(r.weeklyDays || [])];
      if (r.repeatType === 'monthly') rule.dayOfMonth = Math.min(31, Math.max(1, r.dayOfMonth || 1));
      return rule;
    }

    async function submitTask() {
      formError.value = '';
      const msg = (form.value.message || '').trim();
      if (!msg) {
        formError.value = '请填写消息内容';
        return;
      }
      if (form.value.scheduleType === 'once') {
        if (!form.value.runAtLocal) {
          formError.value = '请选择执行时间';
          return;
        }
      }
      saving.value = true;
      try {
        if (editingId.value) {
          const payload = { message: msg, scheduleType: form.value.scheduleType };
          if (form.value.scheduleType === 'once') {
            payload.runAt = new Date(form.value.runAtLocal).getTime();
          } else {
            const rule = buildRepeatRule();
            payload.repeatRuleJson = JSON.stringify(rule);
            payload.cronExpr = repeatRuleToCron(rule);
          }
          await tasksAPI.update(editingId.value, payload);
        } else {
          const payload = {
            workspace: form.value.workspace,
            message: msg,
            scheduleType: form.value.scheduleType,
          };
          if (form.value.scheduleType === 'once') {
            payload.runAt = new Date(form.value.runAtLocal).getTime();
          } else {
            payload.repeatRule = buildRepeatRule();
          }
          await tasksAPI.create(payload);
        }
        closeModal();
        await loadTasks();
      } catch (e) {
        formError.value = e.response?.data?.message || e.message || (editingId.value ? '保存失败' : '创建失败');
      } finally {
        saving.value = false;
      }
    }

    async function toggleEnabled(task) {
      try {
        await tasksAPI.update(task.id, { enabled: !task.enabled });
        await loadTasks();
      } catch (e) {
        console.error('Toggle task failed', e);
      }
    }

    async function openExecutions(task) {
      if (!task?.id) return;
      executionsTask.value = task;
      executionDetail.value = null;
      executions.value = [];
      executionsLoading.value = true;
      try {
        const res = await tasksAPI.listExecutions(task.id);
        const raw = res?.data?.data ?? res?.data;
        executions.value = Array.isArray(raw) ? raw : [];
      } catch (e) {
        console.error('Load executions failed', e);
        executions.value = [];
      } finally {
        executionsLoading.value = false;
      }
    }

    function closeExecutions() {
      executionsTask.value = null;
      executions.value = [];
      executionDetail.value = null;
    }

    function openExecutionDetail(ex) {
      executionDetail.value = ex;
    }

    async function clearExecutionsForTask() {
      if (!executionsTask.value?.id) return;
      if (!confirm(t('tasks.clearExecutionsConfirm'))) return;
      try {
        await tasksAPI.clearExecutions(executionsTask.value.id);
        executionDetail.value = null;
        const res = await tasksAPI.listExecutions(executionsTask.value.id);
        const raw = res?.data?.data ?? res?.data;
        executions.value = Array.isArray(raw) ? raw : [];
      } catch (e) {
        console.error('Clear executions failed', e);
      }
    }

    function confirmDelete(task) {
      deleteTarget.value = task;
    }

    async function doDelete() {
      if (!deleteTarget.value) return;
      try {
        await tasksAPI.delete(deleteTarget.value.id);
        deleteTarget.value = null;
        await loadTasks();
      } catch (e) {
        console.error('Delete task failed', e);
      }
    }

    onMounted(async () => {
      loading.value = true;
      await loadAgents();
      await loadTasks();
      loading.value = false;
    });

    return {
      t,
      tasks,
      agents,
      loading,
      showModal,
      editingId,
      form,
      formError,
      saving,
      deleteTarget,
      weekDays,
      scheduleLabel,
      formatTime,
      openCreateModal,
      closeModal,
      submitTask,
      toggleEnabled,
      openExecutions,
      closeExecutions,
      openExecutionDetail,
      clearExecutionsForTask,
      executionsTask,
      executions,
      executionsLoading,
      executionDetail,
      openEditModal,
      confirmDelete,
      doDelete,
    };
  },
};
</script>

<style scoped>
.tasks-view {
  width: 100%;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: var(--spacing-lg);
  overflow: hidden;
}

.tasks-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-lg);
  margin-bottom: var(--spacing-lg);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
}

.view-title {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  margin: 0 0 var(--spacing-xs) 0;
  color: var(--color-text-primary);
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-lg);
  background: var(--color-accent-primary);
  color: white;
  border: none;
  border-radius: var(--radius-md);
  font-weight: 500;
  cursor: pointer;
}

.btn-primary:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.btn-icon {
  font-size: 1.25rem;
}

.tasks-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
  overflow-y: auto;
}

.task-card {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: var(--spacing-lg);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
}

.task-card.disabled {
  opacity: 0.7;
}

.task-main {
  flex: 1;
  min-width: 0;
}

.task-workspace {
  font-size: var(--font-size-sm);
  color: var(--color-accent-primary);
  margin-bottom: var(--spacing-xs);
}

.task-message {
  margin: 0 0 var(--spacing-xs) 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
}

.task-schedule,
.task-meta {
  font-size: var(--font-size-sm);
  margin: 0;
}

.task-actions {
  display: flex;
  gap: var(--spacing-sm);
}

.link-btn {
  background: none;
  border: none;
  color: var(--color-accent-primary);
  cursor: pointer;
  font-size: var(--font-size-sm);
}

.link-btn.danger {
  color: var(--color-error);
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-2xl);
  color: var(--color-text-secondary);
}

.empty-icon {
  font-size: 3rem;
  margin-bottom: var(--spacing-md);
  opacity: 0.6;
}

.mt-4 {
  margin-top: var(--spacing-lg);
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--color-bg-elevated);
  border-top-color: var(--color-accent-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: var(--spacing-md);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-modal);
  padding: var(--spacing-lg);
}

.modal-content {
  background: var(--color-bg-primary);
  border-radius: var(--radius-xl);
  border: 1px solid var(--glass-border);
  max-width: 480px;
  width: 100%;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.modal-content.modal-wide {
  max-width: 520px;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-lg);
  border-bottom: 1px solid var(--glass-border);
}

.modal-header h2 {
  margin: 0;
  font-size: var(--font-size-xl);
  color: var(--color-text-primary);
}

.close-btn {
  background: none;
  border: none;
  font-size: 1.25rem;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.modal-body {
  padding: var(--spacing-lg);
  overflow-y: auto;
}

.form-group {
  margin-bottom: var(--spacing-lg);
}

.form-group label {
  display: block;
  margin-bottom: var(--spacing-xs);
  font-weight: 500;
  color: var(--color-text-primary);
}

.form-input {
  width: 100%;
  padding: var(--spacing-sm) var(--spacing-md);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
}

textarea.form-input {
  resize: vertical;
  min-height: 60px;
}

.weekdays-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-md);
}

.weekday-check {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  font-weight: normal;
  cursor: pointer;
}

.form-error {
  color: var(--color-error);
  font-size: var(--font-size-sm);
  margin-bottom: var(--spacing-md);
}

.modal-footer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-md);
  margin-top: var(--spacing-xl);
}

.btn-secondary {
  padding: var(--spacing-sm) var(--spacing-lg);
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.delete-confirm-modal {
  max-width: 400px;
}

.btn-danger {
  padding: var(--spacing-sm) var(--spacing-lg);
  background: var(--color-error);
  color: white;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.executions-modal {
  max-width: 560px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.executions-modal .modal-body {
  overflow-y: auto;
  min-height: 120px;
}

.executions-actions {
  margin-bottom: var(--spacing-md);
}

.execution-detail .clear-executions-detail-btn {
  margin-left: var(--spacing-md);
}

.executions-list .loading-state.small {
  padding: var(--spacing-md);
}

.execution-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-md);
  cursor: pointer;
  border: 1px solid transparent;
}

.execution-row:hover {
  background: var(--color-bg-secondary);
  border-color: var(--glass-border);
}

.execution-time {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.execution-status {
  font-size: var(--font-size-xs);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
}

.execution-status.success {
  background: rgba(34, 197, 94, 0.2);
  color: var(--color-success, #16a34a);
}

.execution-status.failed {
  background: rgba(239, 68, 68, 0.2);
  color: var(--color-error);
}

.execution-detail .back-link {
  margin-bottom: var(--spacing-md);
  font-size: var(--font-size-sm);
}

.detail-meta {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  flex-wrap: wrap;
  margin-bottom: var(--spacing-lg);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.detail-meta .error-msg {
  color: var(--color-error);
  max-width: 100%;
}

.conversation-log h4 {
  margin: 0 0 var(--spacing-md) 0;
  font-size: var(--font-size-base);
  color: var(--color-text-primary);
}

.log-block {
  margin-bottom: var(--spacing-lg);
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
  background: var(--color-bg-secondary);
}

.log-block.user {
  border-left: 3px solid var(--color-accent-primary);
}

.log-block.assistant {
  border-left: 3px solid var(--color-success, #16a34a);
}

.log-role {
  display: block;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-text-secondary);
  margin-bottom: var(--spacing-xs);
}

.log-content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}
</style>
