import type { WebSearchProviderId, IWebSearchProvider } from "../types.js";
import { duckDuckScrapeProvider } from "./duck-duck-scrape.js";
import { braveProvider } from "./brave.js";

const providers: Record<WebSearchProviderId, IWebSearchProvider> = {
    "duck-duck-scrape": duckDuckScrapeProvider,
    brave: braveProvider,
};

export function getWebSearchProvider(id: WebSearchProviderId): IWebSearchProvider {
    const p = providers[id];
    if (!p) throw new Error(`Unknown web search provider: ${id}`);
    return p;
}

export { duckDuckScrapeProvider, braveProvider };
