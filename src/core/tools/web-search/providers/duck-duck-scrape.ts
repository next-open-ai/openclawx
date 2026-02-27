import { search as ddgSearch } from "duck-duck-scrape";
import type {
    IWebSearchProvider,
    WebSearchProviderResult,
    WebSearchResultItem,
} from "../types.js";

const PROVIDER_ID = "duck-duck-scrape" as const;

const cache = new Map<string, { result: WebSearchProviderResult; expiresAt: number }>();

function cacheKey(query: string, count: number): string {
    return `${PROVIDER_ID}:${query}:${count}`;
}

export const duckDuckScrapeProvider: IWebSearchProvider = {
    id: PROVIDER_ID,
    isAvailable() {
        return true;
    },
    async search(params: {
        query: string;
        count?: number;
        timeoutSeconds?: number;
        cacheTtlMinutes?: number;
    }): Promise<WebSearchProviderResult> {
        const query = (params.query ?? "").trim();
        const count = Math.min(10, Math.max(1, params.count ?? 5));
        const cacheTtlMinutes = typeof params.cacheTtlMinutes === "number" && params.cacheTtlMinutes >= 0 ? params.cacheTtlMinutes : 0;
        const key = cacheKey(query, count);
        if (cacheTtlMinutes > 0) {
            const hit = cache.get(key);
            if (hit && hit.expiresAt > Date.now()) {
                return { ...hit.result, cached: true };
            }
        }
        const start = Date.now();
        const res = await ddgSearch(query, {});
        const tookMs = Date.now() - start;
        const results: WebSearchResultItem[] = (res.results ?? []).slice(0, count).map((r: { title?: string; url?: string; description?: string }) => ({
            title: r.title ?? "",
            url: r.url ?? "",
            description: r.description,
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
    },
};
