---
name: file-search
description: Searches for files by name, extension, size, or content using powerful system tools like grep or find.
allowed-tools: bash
---

# File Search Skill

Use this skill to recursively search for files or file contents within a specified directory.

## Workflow

1. Identify the user's search criteria:
   - By name/extension pattern (e.g., "*.md")
   - By content (e.g., "contains the word 'auth'")
   - By metadata (e.g., "modified in the last 7 days", "larger than 10MB")
2. Formulate the appropriate `bash` command:
   - Use `find <dir> -name "*.ext" -type f` to search by name.
   - Use `grep -rn "pattern" <dir>` or `rg "pattern" <dir>` (if ripgrep is available) to search by content.
   - Use `find <dir> -mtime -7 -size +10M` to search by metadata.
3. Execute the command using the `bash` tool.
4. Process the output and present the results clearly to the user.
