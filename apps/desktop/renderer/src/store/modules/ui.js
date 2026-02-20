import { defineStore } from 'pinia';

const STORAGE_KEY = 'openbot-ui';
const defaultState = {
  /** 对话界面左侧会话列表：缺省不显示，点击顶部左侧显示图标按钮后展开 */
  sessionsPanelVisible: false,
};

function getStored() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) {
      const o = JSON.parse(s);
      if (typeof o.sessionsPanelVisible === 'boolean') return o;
    }
  } catch (_) {}
  return defaultState;
}

function save(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sessionsPanelVisible: state.sessionsPanelVisible,
    }));
  } catch (_) {}
}

export const useUIStore = defineStore('ui', {
  state: () => getStored(),

  actions: {
    setSessionsPanelVisible(visible) {
      this.sessionsPanelVisible = !!visible;
      save(this.$state);
    },
    toggleSessionsPanel() {
      this.sessionsPanelVisible = !this.sessionsPanelVisible;
      save(this.$state);
    },
  },
});
