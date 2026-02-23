---
name: git-helper
description: Assists with git operations, such as checking branch status, creating commits, stashing changes, resolving conflicts, or analyzing git history.
allowed-tools: bash
---

# Git Helper Skill

Use this skill to help users manage their Git repositories.

## Common Operations

1. **Status & Changes**: 
   - `git status` to see current state.
   - `git diff` or `git diff --cached` to see exact line changes.
2. **Committing**:
   - `git add <files>` to stage.
   - Write clear and descriptive commit messages following conventional commits standard.
3. **Branching**:
   - `git checkout -b <branch>` to create a new branch.
   - `git branch -a` to list all branches.
4. **History**:
   - `git log --oneline --graph --decorate -n 10` for a compact history view.
5. **Conflict Resolution**:
   - Use `git status` to identify conflicting files.
   - Ask the user how they wish to resolve the conflict before editing the files.

## Safeguards
NEVER run `git push`, `git reset --hard`, or `git clean -fd` without EXPLICIT user confirmation via the `notify_user` tool.
