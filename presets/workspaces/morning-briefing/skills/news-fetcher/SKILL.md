---
name: news-fetcher
description: Fetches top news, recent articles, or RSS feeds from the web using curl, wget or custom scripts to provide the user with the latest information on a given topic.
allowed-tools: read_url_content, bash
---

# News Fetcher Skill

Use this skill when the user asks for the latest news, updates on a topic, or trending topics.

## Workflow

1. Understand the user's topic of interest (e.g., "AI news", "technology", "sports").
2. Use the `read_url_content` tool to fetch RSS feeds (like news.ycombinator.com/rss) or news aggregator sites. If the site requires JavaScript, advise the user that the `agent-browser` skill might be more appropriate.
3. Parse the retrieved content. If it's XML/RSS, you can use `bash` tools (like `xmllint`, `grep`, or short python scripts) to extract titles and URLs.
4. Present the top 5-10 headlines with URLs to the user in a clean, markdown-formatted list.
