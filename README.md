# Template for an Agentic AI Assistant Plugin

A self-contained, ready-to-use template. Clone it, replace the sample agent,
skill, prompt, and instruction, and you have a working assistant plugin — no
extra scaffolding to assemble.

The template is optimised for two surfaces, with more planned. The same files
serve both. `.github/agents`, `.github/skills`, `.github/instructions`,
`.github/prompts`, and `.github/hooks` are symlinks to the canonical
directories, so there is one copy to edit:

| Surface | How it finds the files |
|---------|------------------------|
| VS Code | Follows the `.github/` symlinks and reads MCP servers from `.vscode/mcp.json` |
| Copilot CLI | Installs the plugin declared in `plugin.json`, which points at the canonical directories |

## What you get out of the box

Every component is already wired and filled with a working sample:

| Component | Canonical path |
|-----------|----------------|
| Agent | `agents/*.agent.md` |
| Skill | `skills/*/SKILL.md` |
| Instruction | `instructions/*.instructions.md` |
| Prompt | `prompts/*.prompt.md` |
| Hook | `hooks/hooks.json` |
| MCP servers | `.mcp.json` |
| Plugin manifest | `plugin.json` |

Rename the samples and edit their frontmatter. You do not need to create
directories, manifests, or discovery links.

## Quick start

Pick a surface first.

### VS Code

Recommended for workflow development and harness engineering to improve the reliability and functionality of AI agents iteratively.

1. Clone this repository: `git clone REPO_URL`.
2. Open the repository root in the workspace, alongside with the project you are working on:
   On the navigation bar, open `File` > `Add Folder to Workspace...` and select this repository.

> [!NOTE]
> Project-level discovery is automatically wired through symlinks under `.github/`and MCP servers through `.vscode/mcp.json`. Edits apply without installing.

### Copilot CLI

Recommended for stable, reproducible behavior across machines.

To run as a packaged plugin, register the marketplace first before installation:

```bash
copilot plugin marketplace add OWNER/REPO
copilot plugin install my-awesome-copilot@my-marketplace
copilot plugin list
```

> [!NOTE]
> Installing directly from a local path or a published Git URL (`copilot plugin install REPO_PATH`) may be deprecated in a future release.

#### GitHub Copilot Chat Extension

Alternatively, you can always run your prompt on your IDE by switching the Agent Provider of your Chat from `Local` to `Copilot CLI`.
The task will then be delegated to GitHub Copilot CLI.
This allows you to leverage the plugin's agents, skills, and other components without leaving your IDE.

## Compatibility Across Surfaces

### Prompts

Prompts are supported natively in VS Code or other editors with the GitHub Copilot Chat Extension only.
In Copilot CLI, prompt files are exposed as **commands** via [plugin.json](plugin.json).
This allows you to execute prompts via the slash command interface in Copilot CLI.

### MCP Configuration

The Copilot CLI plugin reads MCP servers from `.mcp.json` (`mcpServers`).
VS Code reads `.vscode/mcp.json` (`servers`), with a different top-level key requirement.

> [!NOTE]
> Committing a change to `.mcp.json` runs `.githooks/pre-commit`, which
> regenerates and stages `.vscode/mcp.json` in the same commit.

To regenerate it yourself:

```bash
uv run scripts/sync-mcp-server-configs.py
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Structure

```text
.
├── plugin.json                   # Plugin manifest (required)
├── .github/                      # GitHub configs and workspace discovery entrypoints
│   ├── agents -> ../agents
│   ├── skills -> ../skills
│   ├── instructions -> ../instructions
│   ├── prompts -> ../prompts
│   ├── hooks -> ../hooks
│   └── plugin/marketplace.json   # Marketplace metadata for the plugin
├── .vscode/mcp.json              # VS Code MCP config, generated from .mcp.json
├── agents/                       # Custom agent definitions (*.agent.md)
├── instructions/                 # Custom instructions (*.instructions.md)
├── prompts/                      # Reusable prompt templates (*.prompt.md, used by VS Code only)
├── skills/                       # Skill definitions (*/SKILL.md)
├── hooks/hooks.json              # Hooks configuration
├── .mcp.json                     # MCP servers for the Copilot CLI plugin
├── scripts/                      # Helper scripts for hooks and tooling
└── docs/                         # Documentation and additional resources
```
