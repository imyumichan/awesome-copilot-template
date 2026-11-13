# Contributing

## Workflow

1. Branch from `main` for plugin content. Use the `webapp` branch for changes to the bundler under `docs/`.
2. Keep each change focused on one concern, so the review inventory stays readable.
3. Run the checks below, then open a pull request.

## Cautions

- **Code runs on users' machines.** Hook commands, MCP server commands, and `scripts/*.sh` run when the plugin is installed. Review every change to them. `node scripts/validate-plugin.mjs` lists them for review.
- **Keep MCP configs in sync.** `.mcp.json` and `.vscode/mcp.json` must match. Edit only one of them per change, then run `uv run scripts/sync-mcp-server-configs.py`. The pre-commit hook refuses a commit where both files changed and differ. Git uses the hook only when `core.hooksPath` is set, so run `git config core.hooksPath .githooks` in a fresh clone.
- **Keep paths relative and inside the repository.** Symlinks under `.github/` must be relative and stay in the repo. Commands must not use absolute paths or paths outside the repo. The validator reports both.
- **No secrets or personal paths.** Do not commit tokens (such as `github_pat_...`), `.env` files, or home-directory paths. Tokens entered in the web app stay in memory and are cleared on reload.
- **Keep JSON valid.** `plugin.json`, `.mcp.json`, and `hooks/hooks.json` must parse.
- **Shell scripts.** Make them executable, exit 0 on success, and pass ShellCheck (`npm run lint`).
- **Web app.** Keep the limits in [docs/app/README.md](docs/app/README.md) in step with the code and tests.

## Checks

Run these before opening a pull request; CI runs the same:

- `node scripts/validate-plugin.mjs` checks the plugin structure and lists what can run code.
- `npm run lint` runs ShellCheck and a syntax check on every tracked shell script (needs `shellcheck` on `PATH`).
- `npm run test:infra` checks hooks, skill layout and size, MCP config sync, and the lint script.
- `npm run test:app` runs the web app tests, if this repository includes the bundler.

## Code Review

All contributions should be reviewed for:
- Valid YAML frontmatter and JSON in changed files
- Clarity of instructions (another person should understand them)
- No hardcoded secrets or paths
