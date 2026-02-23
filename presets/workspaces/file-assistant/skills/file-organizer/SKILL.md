---
name: file-organizer
description: Organizes, categorizes, and renames files in a directory based on user instructions. Uses bash commands to move, copy, or rename files.
allowed-tools: bash
---

# File Organizer Skill

Use this skill when the user asks to organize, categorize, or rename files in a specific directory.

## Workflow

1. Use `ls` or `find` to list the files in the target directory to understand the current structure and file types.
2. Based on the user's intent (e.g., "group by extension", "sort images by date"), formulate a plan using `bash` commands like `mkdir`, `mv`, `cp`, or `rename`.
3. Before executing destructive commands (like moving or renaming many files), EXPLICITLY confirm the plan with the user by asking for permission using the `notify_user` tool unless the user has already explicitly authorized it.
4. Execute the bash script to organize the files.
5. Verify the result using `ls -la` and report back to the user.
