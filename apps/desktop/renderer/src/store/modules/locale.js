import { defineStore } from 'pinia';
import zh from '@/locales/zh';
import en from '@/locales/en';

const STORAGE_KEY = 'openbot-locale';
const messages = { zh, en };

/** 兜底文案：当 key 未在 locale 中定义时避免显示 key 本身 */
const fallbacks = {
  'common.edit': { zh: '编辑', en: 'Edit' },
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'agents.modelConfig': { zh: '模型配置', en: 'Model Configuration' },
  'agents.modelConfigHint': {
    zh: '从已配置 API Key 的 Provider 中选择该智能体使用的模型。',
    en: 'Select the model for this agent from providers that have API keys configured.',
  },
};

function getStoredLocale() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'zh' || stored === 'en') return stored;
  } catch (_) {}
  return 'zh';
}

export const useLocaleStore = defineStore('locale', {
  state: () => ({
    locale: getStoredLocale(),
  }),

  getters: {
    messages: (state) => messages[state.locale] || zh,
    /** 当前语言显示名 */
    localeLabel: (state) => (state.locale === 'zh' ? '中文' : 'English'),
  },

  actions: {
    setLocale(locale) {
      if (locale !== 'zh' && locale !== 'en') return;
      this.locale = locale;
      try {
        localStorage.setItem(STORAGE_KEY, locale);
      } catch (_) {}
    },
    /** 根据 key 取文案，key 如 'nav.dashboard' */
    t(key) {
      const msg = this.messages;
      const value = key.split('.').reduce((o, k) => (o != null ? o[k] : undefined), msg);
      if (value != null) return value;
      const fb = fallbacks[key];
      return fb ? (fb[this.locale] || fb.zh || key) : key;
    },
  },
});
