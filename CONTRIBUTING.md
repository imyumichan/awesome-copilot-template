# Contributing

## Adding an Agent

1. Create `agents/<name>.agent.md` with YAML frontmatter:
   ```yaml
   ---
   name: <name>
   description: <one-line description>
   tools: ["bash", "edit", "view"]
   ---
   ```
2. Write the system prompt below the frontmatter.
3. Reinstall and test: `copilot plugin install ./`

## Adding a Skill

1. Create `skills/<name>/SKILL.md` with YAML frontmatter:
   ```yaml
   ---
   name: <name>
   description: <one-line description>
   ---
   ```
2. Include "When to Use" and "Instructions" sections.
3. Reinstall and test.

## Adding a Hook

1. Add an entry to `hooks/hooks.json`.
2. Create the corresponding script in `scripts/`.
3. Make the script executable: `chmod +x scripts/<name>.sh`

## Adding an MCP Server

1. Add a server entry to `.mcp.json`.
2. Document required environment variables in the entry or in `docs/`.

## Checks

Run these before opening a pull request; CI runs the same:

- `node scripts/validate-plugin.mjs` checks the plugin structure and lists what can run code.
- `npm run lint` runs ShellCheck and a syntax check on every tracked shell script (needs `shellcheck` on `PATH`).
- `npm run test:infra` checks hooks, skill layout and size, MCP config sync, and the lint script.
- `npm run test:app` runs the web app tests, if this repository includes the bundler.

## Code Review

All contributions should be reviewed for:
- Correctness of YAML frontmatter syntax
- Clarity of instructions (another person should understand them)
- No hardcoded secrets or paths
