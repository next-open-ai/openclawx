---
name: code-runner
description: Executes code snippets by saving them to a temporary file and running them via bash commands (e.g., node, python, go run) to test logic or compute results.
allowed-tools: bash, write
---

# Code Runner Skill

Use this skill to quickly execute a piece of code to test logic, write a script for the user, or run built-in system tools.

## Workflow

1. Determine the language required (Node.js, Python, Shell, Go, etc.).
2. Write the code snippet to a temporary file using the `write` tool (e.g., in `/tmp/test-script.js`).
3. Use the `bash` tool to execute the script (e.g., `node /tmp/test-script.js`).
4. Capture the standard output and standard error.
5. Provide the execution result to the user.
6. Clean up the temporary file using `bash` (`rm /tmp/test-script.js`).

## Example Usage
If the user asks "How do I reverse a string in JavaScript? Show me.", write a script with the solution, run it to verify it works, and show them both the code and the verified output.
