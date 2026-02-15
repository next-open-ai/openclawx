import { defineStore } from 'pinia';
import { configAPI } from '@/api';

export const useSettingsStore = defineStore('settings', {
    state: () => ({
        config: {
            gatewayUrl: 'ws://localhost:38080',
            defaultProvider: 'deepseek',
            defaultModel: 'deepseek-chat',
            defaultAgentId: 'default',
            theme: 'dark',
            maxAgentSessions: 5,
            loginUsername: '',
            loginPasswordSet: false,
            providers: {},
        },
        providers: [],
        providerSupport: {},
        models: {},
    }),

    actions: {
        async loadConfig() {
            try {
                const response = await configAPI.getConfig();
                const data = response?.data?.data;
                if (data && typeof data === 'object') {
                    this.config = { ...this.config, ...data };
                }
                this.applyTheme(this.config?.theme);
            } catch (error) {
                console.error('Failed to load config:', error);
                this.applyTheme(this.config?.theme);
            }
        },

        async updateConfig(updates) {
            try {
                const response = await configAPI.updateConfig(updates);
                const next = response?.data?.data;
                this.config = next && typeof next === 'object' ? { ...this.config, ...next } : this.config;
                if (updates?.theme) {
                    this.applyTheme(updates.theme);
                }
            } catch (error) {
                console.error('Failed to update config:', error);
            }
        },

        async loadProviderSupport() {
            try {
                const response = await configAPI.getProviderSupport();
                this.providerSupport = response.data?.data ?? {};
                this.providers = Object.keys(this.providerSupport);
            } catch (error) {
                console.error('Failed to load provider support:', error);
                this.providerSupport = {};
                this.providers = [];
            }
        },

        async loadProviders() {
            await this.loadProviderSupport();
        },

        /** @param {string} [type] - 可选，llm/embedding/image，按类型筛选；缓存 key 为 provider 或 provider:type */
        async loadModels(provider, type) {
            if (!provider) return;
            try {
                const response = await configAPI.getModels(provider, type);
                const list = response.data?.data ?? [];
                const key = type ? `${provider}:${type}` : provider;
                this.models = { ...this.models, [key]: list };
            } catch (error) {
                console.error('Failed to load models:', error);
            }
        },

        applyTheme(theme) {
            document.documentElement.setAttribute('data-theme', theme || 'dark');
        },

        /** 直接设置为指定主题（用于配置页点击某一主题卡片） */
        async setTheme(theme) {
            const valid = ['light', 'dark', 'cosmic', 'neon'].includes(theme);
            if (!valid) return;
            this.applyTheme(theme);
            try {
                await this.updateConfig({ theme });
            } catch (e) {
                console.error('Failed to save theme', e);
            }
        },

        /** 按顺序切换到下一主题（用于右上角图标点击）：专业 → 浅色 → 炫酷 → 深色 */
        toggleTheme() {
            const themes = ['cosmic', 'light', 'neon', 'dark'];
            const currentTheme = this.config.theme || 'dark';
            const nextIndex = (themes.indexOf(currentTheme) + 1) % themes.length;
            this.updateConfig({ theme: themes[nextIndex] });
        },
    },
});
