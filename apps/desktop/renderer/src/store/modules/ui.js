import { defineStore } from 'pinia';

const STORAGE_KEY = 'openbot-ui';
const defaultState = {
  /** 对话界面左侧会话列表：缺省不显示，点击顶部左侧显示图标按钮后展开 */
  sessionsPanelVisible: false,
  /** 对话界面输入框上方「选择智能体」区域是否展开，可收起因高度占用多 */
  agentBarVisible: true,
};

function getStored() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) {
      const o = JSON.parse(s);
      const out = { ...defaultState };
      if (typeof o.sessionsPanelVisible === 'boolean') out.sessionsPanelVisible = o.sessionsPanelVisible;
      if (typeof o.agentBarVisible === 'boolean') out.agentBarVisible = o.agentBarVisible;
      return out;
    }
  } catch (_) {}
  return defaultState;
}

function save(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sessionsPanelVisible: state.sessionsPanelVisible,
      agentBarVisible: state.agentBarVisible,
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
    setAgentBarVisible(visible) {
      this.agentBarVisible = !!visible;
      save(this.$state);
    },
    toggleAgentBar() {
      this.agentBarVisible = !this.agentBarVisible;
      save(this.$state);
    },
  },
});
