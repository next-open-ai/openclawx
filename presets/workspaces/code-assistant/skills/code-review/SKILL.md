---
name: code-review
description: Reads and analyzes source code files or project structures, identifies bugs, and suggests structural architectural or security improvements.
allowed-tools: read, bash
---

# Code Review Skill

Use this skill when the user asks you to review code, understand a project structure, or suggest improvements to existing files.

## Guidelines

1. **Understand Context**: Before making suggestions, use the `read` or `bash` tools (e.g., `ls -R`, `cat`) to understand the surrounding project structure, package dependencies (`package.json`, `pom.xml`, etc.), and related files.
2. **Analysis Focus**:
   - **Bugs/Logic Errors**: Identify edge cases, null pointer risks, race conditions, etc.
   - **Clean Code**: Suggest naming improvements, refactorings to reduce complexity, or adherence to SOLID principles.
   - **Performance**: Identify O(N^2) loops where O(N) is possible, memory leaks, unoptimized queries, etc.
   - **Security**: Check for hardcoded credentials, SQL injection vectors, or XSS vulnerabilities.
3. **Actionable Output**: Always provide actionable feedback. Instead of just saying "this is bad", provide the corrected code snippet.
