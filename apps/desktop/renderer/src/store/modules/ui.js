import { defineStore } from 'pinia';

const STORAGE_KEY = 'openbot-ui';
const defaultState = {
  sessionsPanelVisible: true,
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
