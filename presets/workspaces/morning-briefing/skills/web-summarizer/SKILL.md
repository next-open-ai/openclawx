---
name: web-summarizer
description: Reads the content of an article or webpage, extracts the main points, and provides a concise, structured summary.
allowed-tools: read_url_content
---

# Web Summarizer Skill

Use this skill to extract the core message from long articles, blog posts, or webpage content without the user having to read the whole text.

## Workflow

1. Receive a URL from the user or from a previous step (like `news-fetcher`).
2. Use the `read_url_content` tool to retrieve the page content.
3. Analyze the returned markdown content, ignoring navigation elements, ads, and footers.
4. Generate a structured summary containing:
   - **Title**: The main topic.
   - **TL;DR**: A one-sentence summary.
   - **Key Points**: 3 to 5 bullet points with the most important facts.
5. If the article is too long to read in one go, inform the user you are summarizing the beginning of the article.
