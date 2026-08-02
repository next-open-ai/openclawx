import { search as ddgSearch } from "duck-duck-scrape";
import { duckDuckScrapeProvider } from "../../../../src/core/tools/web-search/providers/duck-duck-scrape.js";

jest.mock("duck-duck-scrape", () => ({
    search: jest.fn(),
}));

const searchMock = jest.mocked(ddgSearch);

describe("duckDuckScrapeProvider", () => {
    it("maps Web results and respects the requested count", async () => {
        searchMock.mockResolvedValue({
            noResults: false,
            vqd: "test-vqd",
            results: [
                {
                    hostname: "example.com",
                    title: "First result",
                    url: "https://example.com/first",
                    description: "First description",
                    rawDescription: "First description",
                    icon: "https://example.com/favicon.ico",
                },
                {
                    hostname: "example.com",
                    title: "Second result",
                    url: "https://example.com/second",
                    description: "Second description",
                    rawDescription: "Second description",
                    icon: "https://example.com/favicon.ico",
                },
            ],
        });

        const result = await duckDuckScrapeProvider.search({
            query: "test query",
            count: 1,
        });

        expect(result).toMatchObject({
            query: "test query",
            provider: "duck-duck-scrape",
            count: 1,
            cached: false,
            results: [
                {
                    title: "First result",
                    url: "https://example.com/first",
                    description: "First description",
                },
            ],
        });
    });
});
