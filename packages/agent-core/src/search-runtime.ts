import type { SearchProviderRuntime } from '@openclawx/contracts';
import { Type, StringEnum, defineAgentTool, type AgentTool } from './pi-tools.js';

type SearchResult = { title: string; url: string; snippet: string; publishedDate?: string; source?: string };
const MAX_RESULTS = 10;
const timeout = <T>(promise: Promise<T>, ms = 15_000) =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Search request timed out.')), ms))]);

function text(value: unknown) { return typeof value === 'string' ? value : ''; }
function list(value: unknown) { return Array.isArray(value) ? value : []; }
function take(items: SearchResult[], count: number) {
  return items.filter((item) => item.title && item.url).slice(0, Math.min(count, MAX_RESULTS));
}
function minimizeQuery(value: string) {
  const sensitive = /(身份证|护照|银行卡|信用卡|密码|口令|验证码|api[_ -]?key|secret|token|手机号|电话|邮箱|住址|地址)/i.test(value) || /\b\d{15,19}\b/.test(value);
  return { sensitive, query: sensitive ? value.replace(/(?:\b\d{6,19}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|1\d{10})/gi, '[已脱敏]') : value };
}
function estimatedCredits(id: SearchProviderRuntime['id']) { return id === 'tavily' ? 1 : id === 'exa' ? 1 : 1; }

async function json(url: string, init: RequestInit) {
  const response = await timeout(fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }));
  if (!response.ok) throw new Error(`Search provider returned HTTP ${response.status}.`);
  return response.json() as Promise<any>;
}

async function search(provider: SearchProviderRuntime, query: string, count: number, freshness?: string): Promise<SearchResult[]> {
  const endpoint = provider.baseUrl?.replace(/\/$/, '');
  switch (provider.id) {
    case 'bocha': {
      const data = await json(endpoint || 'https://api.bochaai.com/v1/web-search', { method: 'POST', headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, count, summary: true, ...(freshness ? { freshness } : {}) }) });
      const rows = list(data?.data?.webPages?.value ?? data?.data?.value ?? data?.webPages?.value ?? data?.data);
      return take(rows.map((item: any) => ({ title: text(item.name ?? item.title), url: text(item.url ?? item.link), snippet: text(item.summary ?? item.snippet ?? item.content), publishedDate: text(item.datePublished ?? item.publish_date), source: '博查' })), count);
    }
    case 'tavily': {
      const data = await json(endpoint || 'https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: provider.apiKey, query, max_results: count, search_depth: 'basic', include_answer: false }) });
      return take(list(data?.results).map((item: any) => ({ title: text(item.title), url: text(item.url), snippet: text(item.content), publishedDate: text(item.published_date), source: 'Tavily' })), count);
    }
    case 'brave': {
      const params = new URLSearchParams({ q: query, count: String(count) });
      const data = await json(`${endpoint || 'https://api.search.brave.com/res/v1/web/search'}?${params}`, { headers: { Accept: 'application/json', 'X-Subscription-Token': provider.apiKey } });
      return take(list(data?.web?.results).map((item: any) => ({ title: text(item.title), url: text(item.url), snippet: text(item.description), publishedDate: text(item.age), source: 'Brave' })), count);
    }
    case 'exa': {
      const data = await json(endpoint || 'https://api.exa.ai/search', { method: 'POST', headers: { 'x-api-key': provider.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ query, numResults: count, type: 'auto', contents: { text: { maxCharacters: 1_500 } } }) });
      return take(list(data?.results).map((item: any) => ({ title: text(item.title), url: text(item.url), snippet: text(item.text ?? item.highlights?.[0]), publishedDate: text(item.publishedDate), source: 'Exa' })), count);
    }
    case 'zhipu': {
      const data = await json(endpoint || 'https://open.bigmodel.cn/api/paas/v4/web_search', { method: 'POST', headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ search_query: query, search_engine: 'search_std', search_intent: false, count, search_recency_filter: freshness || 'noLimit', content_size: 'medium' }) });
      return take(list(data?.search_result).map((item: any) => ({ title: text(item.title), url: text(item.link), snippet: text(item.content), publishedDate: text(item.publish_date), source: text(item.media) || '智谱' })), count);
    }
    case 'aliyun': {
      if (!endpoint) throw new Error('Aliyun requires the full Web Search service endpoint in settings.');
      const data = await json(endpoint, { method: 'POST', headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, count }) });
      const rows = list(data?.result?.items ?? data?.data?.items ?? data?.items);
      return take(rows.map((item: any) => ({ title: text(item.title ?? item.name), url: text(item.url ?? item.link), snippet: text(item.summary ?? item.content), publishedDate: text(item.publish_time ?? item.publishDate), source: '阿里云 AI 搜索' })), count);
    }
  }
}

const ProviderChoice = StringEnum(['auto', 'bocha', 'tavily', 'brave', 'exa', 'zhipu', 'aliyun'] as const);
const FreshnessChoice = StringEnum(['oneDay', 'oneWeek', 'oneMonth', 'oneYear', 'noLimit'] as const);

export function createWebSearchTools(providers: SearchProviderRuntime[]): AgentTool[] {
  const enabled = providers.filter((provider) => provider.enabled && provider.apiKey.trim());
  if (!enabled.length) return [];
  return [
    defineAgentTool({
      name: 'web_search',
      description: `Search the public web using an enabled provider. Providers: ${enabled.map((item) => `${item.id} (${item.label})`).join(', ')}. Choose bocha or zhipu for Chinese/mainland queries, tavily/brave for global web, exa for semantic research. Return cited sources; never invent results.`,
      parameters: Type.Object({
        query: Type.String({ minLength: 2, maxLength: 500 }),
        provider: Type.Optional(ProviderChoice),
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
        freshness: Type.Optional(FreshnessChoice),
      }),
      execute: async ({ query, provider: requested = 'auto', count = 5, freshness }) => {
        const selected = requested === 'auto'
          ? enabled.find((item) => item.preferred) ?? (/[㐀-鿿]/.test(query)
            ? enabled.find((item) => item.id === 'bocha' || item.id === 'zhipu')
            : enabled.find((item) => item.id === 'tavily') ?? enabled.find((item) => item.id === 'brave') ?? enabled.find((item) => item.id === 'exa')) ?? enabled[0]
          : enabled.find((item) => item.id === requested);
        if (!selected) {
          return { ok: false, error: requested === 'auto' ? 'No online search provider is configured.' : `Search provider ${requested} is not enabled.` };
        }
        const minimized = minimizeQuery(query);
        const startedAt = Date.now();
        const attempt = async (candidate: SearchProviderRuntime) => ({ candidate, results: await search(candidate, minimized.query, count, freshness) });
        try {
          let response = await attempt(selected);
          let fallbackFrom: string | undefined;
          if (selected.id === 'tavily' && !response.results.length) {
            const brave = enabled.find((item) => item.id === 'brave');
            if (brave) { fallbackFrom = 'tavily'; response = await attempt(brave); }
          }
          return {
            ok: true,
            provider: response.candidate.id,
            fallbackFrom,
            durationMs: Date.now() - startedAt,
            estimatedCredits: estimatedCredits(response.candidate.id),
            queryMinimized: minimized.sensitive,
            results: response.results,
            sources: response.results.map(({ title, url, source }) => ({ title, url, source })),
          };
        } catch (error) {
          if (selected.id === 'tavily') {
            const brave = enabled.find((item) => item.id === 'brave');
            if (brave) {
              try {
                const response = await attempt(brave);
                return {
                  ok: true,
                  provider: 'brave',
                  fallbackFrom: 'tavily',
                  durationMs: Date.now() - startedAt,
                  estimatedCredits: estimatedCredits('brave'),
                  queryMinimized: minimized.sensitive,
                  results: response.results,
                  sources: response.results.map(({ title, url, source }) => ({ title, url, source })),
                };
              } catch { /* retain original error */ }
            }
          }
          return { ok: false, provider: selected.id, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : 'Search request failed.' };
        }
      },
    }),
  ];
}
