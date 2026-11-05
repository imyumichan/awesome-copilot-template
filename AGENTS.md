# AGENTS.md

This file provides guidance to AI agents working within this repository.

## Repository Purpose

This is a Copilot CLI plugin that packages AI tools, instructions, skills,
hooks, and MCP server configurations into a single installable unit.

## Directory Structure

- `plugin.json` — Plugin manifest and packaged component configuration
- `agents/` — Agent definition files (`*.agent.md`)
- `instructions/` — Shared instruction/guideline files
- `prompts/` — Reusable prompt templates (`*.prompt.md`)
- `scripts/` — Helper scripts used by hooks or generated config sync
- `skills/` — Skill directories, each containing a `SKILL.md`
- `.mcp.json` — MCP server configurations for Copilot CLI
- `.vscode/mcp.json` — VS Code-compatible mirror of `.mcp.json`
- `hooks/hooks.json` — Hook event handlers
- `docs/` — Documentation and other contextual resources

## Conventions

- Agent files use YAML frontmatter with `name`, `description`, and `tools` fields.
- Skill directories are named with kebab-case and contain a `SKILL.md` with YAML frontmatter.
- Hook scripts must be executable and exit 0 on success.
- Keep instructions focused and concise — one concern per file.

## When Editing

- Validate `plugin.json` remains valid JSON after changes.
- Ensure any new agents/skills follow the naming conventions above.
- Keep `.mcp.json` and `.vscode/mcp.json` in sync by running `uv run scripts/sync-mcp-server-configs.py` after any MCP changes.
- Test locally with `copilot plugin install ./` before committing.
