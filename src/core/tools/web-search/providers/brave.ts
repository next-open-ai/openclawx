import type {
    IWebSearchProvider,
    WebSearchProviderResult,
    WebSearchResultItem,
} from "../types.js";

const PROVIDER_ID = "brave" as const;
const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

const cache = new Map<string, { result: WebSearchProviderResult; expiresAt: number }>();

function cacheKey(query: string, count: number): string {
    return `${PROVIDER_ID}:${query}:${count}`;
}

interface BraveWebResult {
    title?: string;
    url?: string;
    description?: string;
    age?: string;
    language?: string;
}

interface BraveWebResponse {
    web?: { results?: BraveWebResult[] };
}

export const braveProvider: IWebSearchProvider = {
    id: PROVIDER_ID,
    isAvailable(options: { apiKey?: string }) {
        return !!(options.apiKey && String(options.apiKey).trim());
    },
    async search(params: {
        query: string;
        count?: number;
        apiKey?: string;
        timeoutSeconds?: number;
        cacheTtlMinutes?: number;
        country?: string;
        freshness?: string;
    }): Promise<WebSearchProviderResult> {
        const query = (params.query ?? "").trim();
        const count = Math.min(10, Math.max(1, params.count ?? 5));
        const apiKey = params.apiKey?.trim();
        if (!apiKey) {
            return {
                query,
                provider: PROVIDER_ID,
                results: [],
                count: 0,
                tookMs: 0,
                cached: false,
            };
        }
        const cacheTtlMinutes = typeof params.cacheTtlMinutes === "number" && params.cacheTtlMinutes >= 0 ? params.cacheTtlMinutes : 0;
        const key = cacheKey(query, count);
        if (cacheTtlMinutes > 0) {
            const hit = cache.get(key);
            if (hit && hit.expiresAt > Date.now()) {
                return { ...hit.result, cached: true };
            }
        }
        const timeoutMs = (params.timeoutSeconds ?? 15) * 1000;
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        const start = Date.now();
        try {
            const url = new URL(BRAVE_WEB_SEARCH_URL);
            url.searchParams.set("q", query);
            url.searchParams.set("count", String(count));
            if (params.country?.trim()) url.searchParams.set("country", params.country.trim());
            if (params.freshness?.trim()) url.searchParams.set("freshness", params.freshness.trim());
            const res = await fetch(url.toString(), {
                method: "GET",
                headers: {
                    Accept: "application/json",
                    "X-Subscription-Token": apiKey,
                },
                signal: controller.signal,
            });
            const tookMs = Date.now() - start;
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Brave Search API error ${res.status}: ${text || res.statusText}`);
            }
            const data = (await res.json()) as BraveWebResponse;
            const rawResults = data.web?.results ?? [];
            const results: WebSearchResultItem[] = rawResults.slice(0, count).map((r: BraveWebResult) => ({
                title: r.title ?? "",
                url: r.url ?? "",
                description: r.description,
                published: r.age,
            }));
            const result: WebSearchProviderResult = {
                query,
                provider: PROVIDER_ID,
                results,
                count: results.length,
                tookMs,
                cached: false,
            };
            if (cacheTtlMinutes > 0) {
                cache.set(key, {
                    result,
                    expiresAt: Date.now() + cacheTtlMinutes * 60 * 1000,
                });
            }
            return result;
        } finally {
            clearTimeout(t);
        }
    },
};
