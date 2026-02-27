/**
 * 在线搜索 Provider 统一类型，供 web_search 工具与多 Provider 实现使用。
 */

export type WebSearchProviderId = "duck-duck-scrape" | "brave";

export interface WebSearchResultItem {
    title: string;
    url: string;
    description?: string;
    published?: string;
    siteName?: string;
}

export interface WebSearchProviderResult {
    query: string;
    provider: WebSearchProviderId;
    results: WebSearchResultItem[];
    count: number;
    tookMs?: number;
    cached?: boolean;
}

export interface WebSearchSearchParams {
    query: string;
    count?: number;
    apiKey?: string;
    timeoutSeconds?: number;
    cacheTtlMinutes?: number;
    country?: string;
    freshness?: string;
}

export interface IWebSearchProvider {
    id: WebSearchProviderId;
    isAvailable(options: { apiKey?: string }): boolean;
    search(params: WebSearchSearchParams): Promise<WebSearchProviderResult>;
}
