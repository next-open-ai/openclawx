import { computed, ref } from 'vue';
import { getServerSearchConfig, saveServerSearchConfig } from '../services/api.js';

export const searchProviderIds = ['bocha', 'tavily', 'brave', 'exa', 'zhipu', 'aliyun'] as const;
export type SearchProviderId = (typeof searchProviderIds)[number];
export interface SearchProviderConfig { id: SearchProviderId; label: string; apiKey: string; baseUrl: string; enabled: boolean; }
export interface SearchSettings { version: 1; defaultProvider: SearchProviderId | 'auto'; providers: SearchProviderConfig[]; }

const defaults: Record<SearchProviderId, Omit<SearchProviderConfig, 'apiKey' | 'enabled'>> = {
  bocha: { id: 'bocha', label: '博查', baseUrl: 'https://api.bochaai.com/v1/web-search' }, tavily: { id: 'tavily', label: 'Tavily', baseUrl: 'https://api.tavily.com/search' }, brave: { id: 'brave', label: 'Brave Search', baseUrl: 'https://api.search.brave.com/res/v1/web/search' }, exa: { id: 'exa', label: 'Exa', baseUrl: 'https://api.exa.ai/search' }, zhipu: { id: 'zhipu', label: '智谱 Web Search', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/web_search' }, aliyun: { id: 'aliyun', label: '阿里云 AI 搜索', baseUrl: '' },
};
const settings = ref<SearchSettings>({ version: 1, defaultProvider: 'auto', providers: searchProviderIds.map((id) => ({ ...defaults[id], apiKey: '', enabled: false })) });
const loaded = ref(false);
function normalize(value: unknown): SearchSettings {
  const raw = value && typeof value === 'object' ? value as Partial<SearchSettings> : {}; const rows = Array.isArray(raw.providers) ? raw.providers : [];
  const defaultProvider: SearchSettings['defaultProvider'] = raw.defaultProvider === 'auto' || searchProviderIds.includes(raw.defaultProvider as SearchProviderId) ? raw.defaultProvider as SearchSettings['defaultProvider'] : 'auto';
  return { version: 1, defaultProvider, providers: searchProviderIds.map((id) => { const stored = rows.find((item) => item && typeof item === 'object' && (item as SearchProviderConfig).id === id) as Partial<SearchProviderConfig> | undefined; return { ...defaults[id], apiKey: String(stored?.apiKey || ''), baseUrl: String(stored?.baseUrl ?? defaults[id].baseUrl), label: String(stored?.label || defaults[id].label), enabled: Boolean(stored?.enabled) }; }) };
}
export function useSearchConfig() {
  const configuredProviders = computed(() => settings.value.providers.filter((item) => item.enabled && item.apiKey.trim()));
  const load = async () => { if (loaded.value) return; const value = window.openclawxDesktop ? await window.openclawxDesktop.getSearchConfig() : await getServerSearchConfig(); settings.value = normalize(value); loaded.value = true; };
  const save = async (value = settings.value) => { const next = normalize(JSON.parse(JSON.stringify(value))); settings.value = next; if (window.openclawxDesktop) await window.openclawxDesktop.saveSearchConfig(next); else await saveServerSearchConfig(next); };
  const runtimeProviders = (preferredOverride?: SearchProviderId | 'auto' | null) => {
    const rows = configuredProviders.value.map(({ id, label, apiKey, baseUrl, enabled }) => ({
      id,
      label,
      apiKey,
      baseUrl: baseUrl.trim() || undefined,
      enabled,
      preferred: preferredOverride === id || (preferredOverride == null && settings.value.defaultProvider === id),
    }));
    return rows;
  };

  /** Resolve providers for an employee search preference. */
  const runtimeProvidersFor = (mode: 'inherit' | 'auto' | 'off' | 'llm-builtin' | SearchProviderId = 'inherit') => {
    if (mode === 'off' || mode === 'llm-builtin') return [];
    if (mode === 'inherit') return runtimeProviders();
    if (mode === 'auto') return runtimeProviders(null);
    const only = configuredProviders.value.filter((item) => item.id === mode);
    return only.map(({ id, label, apiKey, baseUrl, enabled }) => ({
      id, label, apiKey, baseUrl: baseUrl.trim() || undefined, enabled, preferred: true,
    }));
  };

  return { settings, load, save, configuredProviders, runtimeProviders, runtimeProvidersFor, defaults };
}
