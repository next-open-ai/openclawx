# Skills system

OpenClawX follows the **Agent Skills** spec: multiple load paths, local install, and dynamic extension, including self-discovery and iteration.

---

## Spec and loading

- Skills use **SKILL.md** (description, triggers, capabilities).
- Load paths: built-in (e.g. `skills/`), user dirs, and `openbot -s <path>`.
- Skill content is injected into the agent system prompt via `formatSkillsForPrompt`.

---

## Built-in skills

| Skill | Description |
|-------|-------------|
| **find-skills** | Discover and install Cursor/Agent skills |
| **agent-browser** | Browser automation (Playwright/agent-browser CLI): navigate, fill forms, screenshot, scrape |

---

## Usage

- **CLI**: `openbot -s ./skills "Use find-skills to search for PDF skills"`, or rely on default paths.
- **Desktop**: View loaded skills in the Skills page; same agent core and config as CLI.
- **Install**: Use find-skills to discover and install, or place a SKILL.md in a loaded directory.

---

## Extending

- Custom skills must follow the SKILL.md spec and live in a loaded directory.
- Build and packaging: see the project root README “Development” section.

---

## Next steps

- [CLI usage](../guides/cli-usage.md)
- [Config overview](../configuration/config-overview.md)

[← Back to index](../README.md)
