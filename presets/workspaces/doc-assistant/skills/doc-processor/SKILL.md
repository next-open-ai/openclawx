---
name: doc-processor
description: Reads, parses, and generates documents in various formats like Markdown, PDF, docx, CSV, or HTML. Uses bash commands to invoke document conversion tools like pandoc or python scripts.
allowed-tools: read, write, bash
---

# Document Processor Skill

Use this skill when the user asks you to read specific technical documents, summarize reports, or generate structured files (like a structured markdown report, a CSV of data, or an HTML presentation).

## Workflow

1. **Reading Documents**:
   - If the file is plaintext (txt, md, csv, json), use the `read` tool directly.
   - If it's a binary document (pdf, docx), check if tools like `pdftotext` or `pandoc` are installed via the `bash` tool, then convert it to text in a temporary directory (`/tmp/`) before reading it.
2. **Generating Documents**:
   - Understand the required structure and content from the user.
   - Draft the content in a plaintext format (e.g., Markdown) using the `write` tool.
   - If the user requested a specific format like PDF or HTML, use `bash` to run `pandoc output.md -o output.pdf` or similar commands.
3. If necessary tools (like pandoc) are missing, politely inform the user to install them or provide the drafted Markdown as a fallback.
4. Notify the user with the path to the newly generated document.
