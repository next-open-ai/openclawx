<template>
  <div class="channels-view">
    <div class="channels-header card-glass">
      <h1 class="view-title">{{ t('settings.channelsPageTitle') }}</h1>
      <p class="view-desc text-secondary">{{ t('settings.channelsPageDesc') }}</p>
    </div>

    <div v-if="loading" class="channels-loading">
      <div class="spinner"></div>
      <p>{{ t('common.loading') }}</p>
    </div>

    <div v-else class="channels-grid">
      <div
        v-for="channel in channelList"
        :key="channel.id"
        class="channel-card card-glass"
      >
        <div class="channel-card-header">
          <span class="channel-icon" :aria-hidden="true">{{ channel.icon }}</span>
          <span class="channel-name">{{ channel.name }}</span>
          <span
            class="channel-status-badge"
            :class="channel.enabled ? 'status-enabled' : 'status-disabled'"
          >
            {{ channel.enabled ? t('settings.channelStatusEnabled') : t('settings.channelStatusDisabled') }}
          </span>
          <span
            v-if="channel.id === 'wechat' && channel.enabled && wechatStatus"
            class="channel-status-extra"
          >
            {{ wechatStatusText }}
          </span>
        </div>
        <p class="channel-card-desc">{{ channel.brief }}</p>
        <div class="channel-card-actions">
          <button type="button" class="btn-configure" @click="openChannelConfig(channel.id)">
            {{ t('settings.channelConfigure') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 单通道配置弹窗 -->
    <transition name="fade">
      <div v-if="channelConfigId" class="modal-backdrop" @click.self="closeChannelConfig">
        <div class="modal-content card-glass channel-config-modal">
          <div class="modal-header">
            <h2>{{ modalTitle }}</h2>
            <button type="button" class="close-btn" @click="closeChannelConfig">✕</button>
          </div>
          <div class="modal-body">
            <template v-if="channelConfigId === 'feishu'">
              <div class="form-group">
                <label class="checkbox-label">
                  <input v-model="channelForm.feishu.enabled" type="checkbox" />
                  {{ t('settings.channelFeishuEnabled') }}
                </label>
              </div>
              <div class="form-group">
                <label>{{ t('settings.channelFeishuAppId') }}</label>
                <input v-model="channelForm.feishu.appId" type="text" class="form-input" :placeholder="t('settings.channelFeishuAppIdPlaceholder')" autocomplete="off" />
              </div>
              <div class="form-group">
                <label>{{ t('settings.channelFeishuAppSecret') }}</label>
                <input v-model="channelForm.feishu.appSecret" type="password" class="form-input" :placeholder="t('settings.channelFeishuAppSecretPlaceholder')" autocomplete="off" />
              </div>
              <div class="form-group">
                <label>{{ t('settings.channelDefaultAgentId') }}</label>
                <select v-model="channelForm.feishu.defaultAgentId" class="form-input">
                  <option v-for="a in agentOptions" :key="a.id" :value="a.id">{{ a.name || a.id }}</option>
                </select>
              </div>
              <p class="form-hint">{{ t('settings.channelFeishuHint') }}</p>
            </template>

            <template v-else-if="channelConfigId === 'dingtalk'">
              <div class="form-group">
                <label class="checkbox-label">
                  <input v-model="channelForm.dingtalk.enabled" type="checkbox" />
                  {{ t('settings.channelDingtalkEnabled') }}
                </label>
              </div>
              <div class="form-group">
                <label>{{ t('settings.channelDingtalkClientId') }}</label>
                <input v-model="channelForm.dingtalk.clientId" type="text" class="form-input" :placeholder="t('settings.channelDingtalkClientIdPlaceholder')" autocomplete="off" />
              </div>
              <div class="form-group">
                <label>{{ t('settings.channelDingtalkClientSecret') }}</label>
                <input v-model="channelForm.dingtalk.clientSecret" type="password" class="form-input" :placeholder="t('settings.channelDingtalkClientSecretPlaceholder')" autocomplete="off" />
              </div>
              <div class="form-group">
                <label>{{ t('settings.channelDefaultAgentId') }}</label>
                <select v-model="channelForm.dingtalk.defaultAgentId" class="form-input">
                  <option v-for="a in agentOptions" :key="a.id" :value="a.id">{{ a.name || a.id }}</option>
                </select>
              </div>
              <p class="form-hint">{{ t('settings.channelDingtalkHint') }}</p>
            </template>

            <template v-else-if="channelConfigId === 'telegram'">
              <div class="form-group">
                <label class="checkbox-label">
                  <input v-model="channelForm.telegram.enabled" type="checkbox" />
                  {{ t('settings.channelTelegramEnabled') }}
                </label>
              </div>
              <div class="form-group">
                <label>{{ t('settings.channelTelegramBotToken') }}</label>
                <input v-model="channelForm.telegram.botToken" type="password" class="form-input" :placeholder="t('settings.channelTelegramBotTokenPlaceholder')" autocomplete="off" />
              </div>
              <div class="form-group">
                <label>{{ t('settings.channelDefaultAgentId') }}</label>
                <select v-model="channelForm.telegram.defaultAgentId" class="form-input">
                  <option v-for="a in agentOptions" :key="a.id" :value="a.id">{{ a.name || a.id }}</option>
                </select>
              </div>
              <p class="form-hint">{{ t('settings.channelTelegramHint') }}</p>
            </template>

            <template v-else-if="channelConfigId === 'wechat'">
              <div class="form-group">
                <label class="checkbox-label">
                  <input v-model="channelForm.wechat.enabled" type="checkbox" />
                  {{ t('settings.channelWechatEnabled') }}
                </label>
              </div>
              <div class="form-group">
                <label>{{ t('settings.channelDefaultAgentId') }}</label>
                <select v-model="channelForm.wechat.defaultAgentId" class="form-input">
                  <option v-for="a in agentOptions" :key="a.id" :value="a.id">{{ a.name || a.id }}</option>
                </select>
              </div>
              <div v-if="channelForm.wechat.enabled" class="form-group wechat-qrcode-section">
                <div class="wechat-status-row">
                  <span class="wechat-status-dot" :class="wechatModalStatusClass"></span>
                  <span>{{ wechatModalStatusText }}</span>
                  <span v-if="wechatModalUserName" class="wechat-username">（{{ wechatModalUserName }}）</span>
                </div>
                <button
                  v-if="wechatModalStatus !== 'logged_in'"
                  type="button"
                  class="btn-secondary"
                  :disabled="wechatQrLoading"
                  @click="fetchWechatQrCodeModal"
                >
                  {{ wechatQrCodeModal ? t('settings.channelWechatRefreshQrCode') : t('settings.channelWechatGetQrCode') }}
                </button>
                <div v-if="wechatQrCodeModal && wechatModalStatus !== 'logged_in'" class="wechat-qrcode-wrap">
                  <p class="form-hint">{{ t('settings.channelWechatQrCodeHint') }}</p>
                  <img :src="wechatQrCodeModal" alt="WeChat QR Code" class="wechat-qrcode-img" />
                </div>
              </div>
              <p class="form-hint">{{ t('settings.channelWechatHint') }}</p>
            </template>
          </div>
          <div class="modal-footer-actions">
            <button type="button" class="btn-secondary" @click="closeChannelConfig">{{ t('common.cancel') }}</button>
            <button type="button" class="btn-primary" :disabled="channelSaveLoading" @click="saveChannelConfig">
              {{ channelSaveLoading ? t('common.loading') : t('common.save') }}
            </button>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from '@/composables/useI18n';
import { configAPI } from '@/api';
import { agentConfigAPI } from '@/api';
import { useSettingsStore } from '@/store/modules/settings';

const CHANNEL_IDS = ['feishu', 'dingtalk', 'telegram', 'wechat'];

const defaultChannelForm = () => ({
  feishu: { enabled: false, appId: '', appSecret: '', defaultAgentId: 'default' },
  dingtalk: { enabled: false, clientId: '', clientSecret: '', defaultAgentId: 'default' },
  telegram: { enabled: false, botToken: '', defaultAgentId: 'default' },
  wechat: { enabled: false, puppet: '', defaultAgentId: 'default' },
});

export default {
  name: 'Channels',
  setup() {
    const { t } = useI18n();
    const settingsStore = useSettingsStore();
    const config = ref(null);
    const loading = ref(true);
    const wechatStatus = ref(null);
    const channelConfigId = ref(null);
    const channelForm = ref(defaultChannelForm());
    const agentList = ref([]);
    const channelSaveLoading = ref(false);
    const wechatQrCodeModal = ref(null);
    const wechatModalStatus = ref('logged_out');
    const wechatModalUserName = ref(null);
    const wechatQrLoading = ref(false);
    let wechatPollTimerModal = null;

    const channelList = computed(() => {
      const ch = config.value?.channels || {};
      return CHANNEL_IDS.map((id) => {
        const data = ch[id] || {};
        const enabled = !!data.enabled;
        let name = id;
        let brief = '';
        if (id === 'feishu') {
          name = t('settings.feishu');
          brief = t('settings.channelBriefFeishu');
        } else if (id === 'dingtalk') {
          name = t('settings.dingtalk');
          brief = t('settings.channelBriefDingtalk');
        } else if (id === 'telegram') {
          name = t('settings.telegram');
          brief = t('settings.channelBriefTelegram');
        } else if (id === 'wechat') {
          name = t('settings.wechat');
          brief = t('settings.channelBriefWechat');
        }
        return {
          id,
          name,
          brief,
          enabled,
          icon: { feishu: '📋', dingtalk: '🔔', telegram: '✈️', wechat: '💬' }[id],
        };
      });
    });

    const modalTitle = computed(() => {
      if (!channelConfigId.value) return '';
      const ch = channelList.value.find((c) => c.id === channelConfigId.value);
      return ch ? t('settings.channelConfigure') + ' - ' + ch.name : t('settings.channelConfigure');
    });

    const agentOptions = computed(() => {
      const list = agentList.value || [];
      const hasDefault = list.some((a) => (a.id || a.workspace) === 'default');
      const opts = hasDefault ? [] : [{ id: 'default', name: 'default' }];
      return [...opts, ...list.map((a) => ({ id: a.id || a.workspace, name: a.name || a.workspace || a.id }))];
    });

    const wechatStatusText = computed(() => {
      if (!wechatStatus.value) return '';
      const s = wechatStatus.value.status || '';
      if (s === 'logged_in') return t('settings.channelWechatLoggedIn');
      if (s === 'scanning') return t('settings.channelWechatScanning');
      return t('settings.channelWechatLoggedOut');
    });

    const wechatModalStatusClass = computed(() => ({
      'status-scanning': wechatModalStatus.value === 'scanning',
      'status-logged-in': wechatModalStatus.value === 'logged_in',
      'status-logged-out': wechatModalStatus.value === 'logged_out',
    }));
    const wechatModalStatusText = computed(() => {
      if (wechatModalStatus.value === 'scanning') return t('settings.channelWechatScanning');
      if (wechatModalStatus.value === 'logged_in') return t('settings.channelWechatLoggedIn');
      return t('settings.channelWechatLoggedOut');
    });

    async function loadConfig() {
      loading.value = true;
      try {
        const res = await configAPI.getConfig();
        config.value = res?.data?.data ?? res?.data ?? null;
      } catch (e) {
        console.error('[Channels] loadConfig failed', e);
        config.value = null;
      } finally {
        loading.value = false;
      }
    }

    async function loadAgentList() {
      try {
        const res = await agentConfigAPI.listAgents();
        const data = res?.data?.data ?? [];
        agentList.value = Array.isArray(data) ? data : [];
      } catch (_) {
        agentList.value = [];
      }
    }

    async function fetchWechatStatus() {
      try {
        const res = await fetch('/server-api/wechat/qrcode');
        const data = await res.json().catch(() => ({}));
        wechatStatus.value = data;
      } catch (_) {
        wechatStatus.value = null;
      }
    }

    function getWechatBaseUrl() {
      const raw = config.value?.gatewayUrl || '';
      if (!raw) return '';
      return raw.replace(/^ws(s?):\/\//, 'http$1://');
    }

    function wechatApiUrl(path) {
      const base = getWechatBaseUrl();
      return base ? `${base}/server-api${path}` : `/server-api${path}`;
    }

    async function fetchWechatQrCodeModal() {
      wechatQrLoading.value = true;
      try {
        let res = await fetch(wechatApiUrl('/wechat/qrcode'));
        let data = await res.json().catch(() => ({}));
        if (!data.qrcode && data.status !== 'logged_in') {
          res = await fetch(wechatApiUrl('/wechat/qrcode/refresh'), { method: 'POST' });
          data = await res.json().catch(() => ({}));
        }
        wechatQrCodeModal.value = data.qrcode || null;
        wechatModalStatus.value = data.status || 'logged_out';
        wechatModalUserName.value = data.userName || null;
        if (data.status === 'scanning' && !wechatPollTimerModal) {
          wechatPollTimerModal = setInterval(pollWechatModal, 3000);
        }
      } catch (e) {
        console.error('[Channels] wechat qrcode failed', e);
      } finally {
        wechatQrLoading.value = false;
      }
    }

    async function pollWechatModal() {
      try {
        const res = await fetch(wechatApiUrl('/wechat/qrcode'));
        const data = await res.json().catch(() => ({}));
        wechatQrCodeModal.value = data.qrcode || null;
        wechatModalStatus.value = data.status || 'logged_out';
        wechatModalUserName.value = data.userName || null;
        if (data.status === 'logged_in' || data.status === 'logged_out') {
          clearInterval(wechatPollTimerModal);
          wechatPollTimerModal = null;
        }
      } catch (_) {}
    }

    function openChannelConfig(id) {
      channelConfigId.value = id;
      const ch = config.value?.channels || {};
      const cur = ch[id] || {};
      if (id === 'feishu') {
        channelForm.value.feishu = {
          enabled: !!cur.enabled,
          appId: typeof cur.appId === 'string' ? cur.appId : '',
          appSecret: typeof cur.appSecret === 'string' ? cur.appSecret : '',
          defaultAgentId: (cur.defaultAgentId || 'default').trim(),
        };
      } else if (id === 'dingtalk') {
        channelForm.value.dingtalk = {
          enabled: !!cur.enabled,
          clientId: typeof cur.clientId === 'string' ? cur.clientId : '',
          clientSecret: typeof cur.clientSecret === 'string' ? cur.clientSecret : '',
          defaultAgentId: (cur.defaultAgentId || 'default').trim(),
        };
      } else if (id === 'telegram') {
        channelForm.value.telegram = {
          enabled: !!cur.enabled,
          botToken: typeof cur.botToken === 'string' ? cur.botToken : '',
          defaultAgentId: (cur.defaultAgentId || 'default').trim(),
        };
      } else if (id === 'wechat') {
        channelForm.value.wechat = {
          enabled: !!cur.enabled,
          puppet: typeof cur.puppet === 'string' ? cur.puppet : '',
          defaultAgentId: (cur.defaultAgentId || 'default').trim(),
        };
        wechatQrCodeModal.value = null;
        wechatModalStatus.value = 'logged_out';
        wechatModalUserName.value = null;
        if (channelForm.value.wechat.enabled) fetchWechatQrCodeModal();
      }
      loadAgentList();
    }

    function closeChannelConfig() {
      channelConfigId.value = null;
      if (wechatPollTimerModal) {
        clearInterval(wechatPollTimerModal);
        wechatPollTimerModal = null;
      }
    }

    async function saveChannelConfig() {
      const id = channelConfigId.value;
      if (!id) return;
      channelSaveLoading.value = true;
      try {
        const ch = config.value?.channels || {};
        const next = {
          feishu: ch.feishu || {},
          dingtalk: ch.dingtalk || {},
          telegram: ch.telegram || {},
          wechat: ch.wechat || {},
        };
        if (id === 'feishu') {
          next.feishu = {
            enabled: !!channelForm.value.feishu.enabled,
            appId: (channelForm.value.feishu.appId || '').trim(),
            appSecret: (channelForm.value.feishu.appSecret || '').trim(),
            defaultAgentId: (channelForm.value.feishu.defaultAgentId || 'default').trim(),
          };
        } else if (id === 'dingtalk') {
          next.dingtalk = {
            enabled: !!channelForm.value.dingtalk.enabled,
            clientId: (channelForm.value.dingtalk.clientId || '').trim(),
            clientSecret: (channelForm.value.dingtalk.clientSecret || '').trim(),
            defaultAgentId: (channelForm.value.dingtalk.defaultAgentId || 'default').trim(),
          };
        } else if (id === 'telegram') {
          next.telegram = {
            enabled: !!channelForm.value.telegram.enabled,
            botToken: (channelForm.value.telegram.botToken || '').trim(),
            defaultAgentId: (channelForm.value.telegram.defaultAgentId || 'default').trim(),
          };
        } else if (id === 'wechat') {
          next.wechat = {
            enabled: !!channelForm.value.wechat.enabled,
            puppet: (channelForm.value.wechat.puppet || '').trim() || undefined,
            defaultAgentId: (channelForm.value.wechat.defaultAgentId || 'default').trim(),
          };
        }
        await settingsStore.updateConfig({ channels: next });
        await loadConfig();
        if (id === 'wechat') fetchWechatStatus();
        closeChannelConfig();
        alert(t('common.saved'));
      } catch (e) {
        console.error('[Channels] saveChannelConfig failed', e);
        alert(e?.response?.data?.message || e?.message || t('common.error') || 'Save failed');
      } finally {
        channelSaveLoading.value = false;
      }
    }

    onMounted(async () => {
      await loadConfig();
      if (config.value?.channels?.wechat?.enabled) fetchWechatStatus();
    });

    return {
      t,
      loading,
      channelList,
      wechatStatus,
      wechatStatusText,
      channelConfigId,
      channelForm,
      modalTitle,
      agentOptions,
      channelSaveLoading,
      wechatQrCodeModal,
      wechatModalStatus,
      wechatModalUserName,
      wechatQrLoading,
      wechatModalStatusClass,
      wechatModalStatusText,
      openChannelConfig,
      closeChannelConfig,
      saveChannelConfig,
      fetchWechatQrCodeModal,
    };
  },
};
</script>

<style scoped>
.channels-view {
  width: 100%;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: var(--spacing-lg);
  overflow: hidden;
}

.channels-header {
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

.view-desc {
  font-size: var(--font-size-sm);
  margin: 0;
  line-height: 1.5;
}

.channels-loading {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-md);
  color: var(--color-text-secondary);
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--color-bg-tertiary);
  border-top-color: var(--color-accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.channels-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--spacing-lg);
  overflow-y: auto;
  align-content: start;
}

.channel-card {
  display: flex;
  flex-direction: column;
  padding: var(--spacing-lg);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
  background: var(--color-bg-secondary);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.channel-card:hover {
  border-color: rgba(102, 126, 234, 0.35);
  box-shadow: 0 4px 16px rgba(102, 126, 234, 0.08);
}

.channel-card-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-sm);
}

.channel-icon {
  font-size: 1.5rem;
  line-height: 1;
}

.channel-name {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text-primary);
}

.channel-status-badge {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.2em 0.5em;
  border-radius: var(--radius-sm);
  margin-left: auto;
}

.channel-status-badge.status-enabled {
  color: var(--color-success, #28a745);
  background: rgba(40, 167, 69, 0.12);
}

.channel-status-badge.status-disabled {
  color: var(--color-text-tertiary);
  background: var(--color-bg-tertiary);
}

.channel-status-extra {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  width: 100%;
  margin-top: 2px;
}

.channel-card-desc {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: 1.45;
  margin: 0 0 var(--spacing-md) 0;
  flex: 1;
  min-height: 0;
}

.channel-card-actions {
  margin-top: auto;
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--glass-border);
}

.btn-configure {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-sm) var(--spacing-lg);
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-accent-primary);
  background: transparent;
  border: 1px solid var(--color-accent-primary);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.btn-configure:hover {
  background: rgba(102, 126, 234, 0.1);
  color: var(--color-accent-primary);
}

.text-secondary {
  color: var(--color-text-secondary);
}

/* 弹窗 */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: var(--spacing-lg);
}

.channel-config-modal {
  width: 100%;
  max-width: 440px;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-lg);
  border-bottom: 1px solid var(--glass-border);
  flex-shrink: 0;
}

.modal-header h2 {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text-primary);
}

.close-btn {
  background: none;
  border: none;
  font-size: 1.25rem;
  color: var(--color-text-secondary);
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.close-btn:hover {
  color: var(--color-text-primary);
}

.modal-body {
  padding: var(--spacing-lg);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.modal-footer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
  border-top: 1px solid var(--glass-border);
  flex-shrink: 0;
}

.form-group {
  margin-bottom: var(--spacing-md);
}

.form-group label {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-primary);
  margin-bottom: var(--spacing-xs);
}

.form-input {
  width: 100%;
  padding: var(--spacing-sm) var(--spacing-md);
  font-size: var(--font-size-sm);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
}

.checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-sm);
  cursor: pointer;
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.form-hint {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  margin: var(--spacing-xs) 0 0 0;
  line-height: 1.4;
}

.btn-primary {
  padding: var(--spacing-sm) var(--spacing-lg);
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: white;
  background: var(--color-accent-primary);
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
}

.btn-primary:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.btn-secondary {
  padding: var(--spacing-sm) var(--spacing-lg);
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-secondary);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.wechat-qrcode-section {
  margin-top: var(--spacing-md);
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--glass-border);
}

.wechat-status-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-sm);
  font-size: var(--font-size-sm);
}

.wechat-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
}

.wechat-status-dot.status-scanning {
  background: #ffc107;
  animation: wechat-pulse 1.5s ease-in-out infinite;
}

.wechat-status-dot.status-logged-in {
  background: var(--color-success, #28a745);
}

.wechat-username {
  color: var(--color-text-secondary);
}

.wechat-qrcode-wrap {
  margin-top: var(--spacing-sm);
}

.wechat-qrcode-img {
  display: block;
  max-width: 200px;
  height: auto;
}

@keyframes wechat-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
