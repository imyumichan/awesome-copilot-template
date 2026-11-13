# AGENTS.md

This file provides guidance to AI agents working within this repository.

## Repository Purpose

A Copilot CLI plugin, plus a web app under `docs/` that edits and publishes it.

## Branches

- Plugin content changes target `main`.
- The Plugin Bundler web app lives under `docs/` on the `webapp` branch.

## Cautions

- Hook commands, MCP server commands, and scripts run on users' machines. Do not add or change them without a clear reason, and call out any change in the summary.
- Keep `.mcp.json` and `.vscode/mcp.json` in sync. Edit only one per change, then run `uv run scripts/sync-mcp-server-configs.py`.
- Do not commit secrets, tokens, or absolute or home-directory paths.
- Keep symlinks under `.github/` relative and inside the repository.
- Do not rename files under `docs/` without updating the links in the README and `docs/app/README.md`.
- Do not push or open pull requests unless the user asks.

## Before Finishing a Change

- `node scripts/validate-plugin.mjs`
- `npm run lint`
- `npm run test:infra`
- `npm run test:app` when `docs/app/` changes.
- `copilot plugin install ./` for plugin content changes.
