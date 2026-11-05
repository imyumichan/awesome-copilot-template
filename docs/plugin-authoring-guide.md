# Plugin Authoring Guide for GitHub Copilot CLI

A comprehensive guide to creating, testing, and distributing plugins for GitHub
Copilot CLI. Based on the official documentation and community best practices.

---

## Table of Contents

1. [Overview](#overview)
2. [Plugin Structure](#plugin-structure)
3. [The Manifest: plugin.json](#the-manifest-pluginjson)
4. [Agents](#agents)
5. [Prompts](#prompts)
6. [Skills](#skills)
7. [Hooks](#hooks)
8. [MCP Server Configuration](#mcp-server-configuration)
9. [LSP Server Configuration](#lsp-server-configuration)
10. [Instructions](#instructions)
11. [Development Workflow](#development-workflow)
12. [Testing](#testing)
13. [Distribution via Marketplaces](#distribution-via-marketplaces)
14. [Loading Order and Precedence](#loading-order-and-precedence)
15. [Best Practices](#best-practices)
16. [References](#references)

---

## Overview

A **plugin** is a distributable package that extends GitHub Copilot CLI with
reusable agents, instructions, prompts, skills, hooks. Plugins bundle these
components into a single installable unit, enabling:

- **Reusability** across projects
- **Team standardization** of CLI configuration
- **Domain expertise sharing** (e.g., a Rails expert, Kubernetes expert)
- **Encapsulation** of complex MCP server setups

### What Plugins Can Contain

| Component | Description |
|-----------|-------------|
| Agents | Specialized AI assistants (`*.agent.md` files) |
| Instructions | Shared guidance files (`*.instructions.md`) |
| Prompts | Reusable prompt templates (`*.prompt.md` files) |
| Skills | Discrete callable capabilities (`SKILL.md` files) |
| Hooks | Event handlers that intercept agent behavior |
| MCP Servers | Model Context Protocol integrations |
| LSP Servers | Language Server Protocol integrations |

---

## Plugin Structure

At minimum, a plugin is a directory containing a `plugin.json` manifest. The
full structure looks like:

```
my-plugin/
├── plugin.json           # Required manifest
├── .github/              # Workspace discovery entrypoints (optional)
│   ├── agents/
│   ├── prompts/
│   ├── instructions/
│   ├── hooks/
│   └── skills/
├── agents/               # Custom agents (optional)
│   └── *.agent.md
├── instructions/         # Shared instructions (optional)
│   └── *.instructions.md
├── prompts/              # Reusable prompt templates (optional)
│   └── *.prompt.md
├── skills/               # Skills (optional)
│   └── YOUR_AGENT_SKILL/
│       └── SKILL.md
├── .mcp.json             # MCP server config (optional)
├── hooks/                # Hook configuration (optional)
│   └── hooks.json
├── lsp.json              # LSP server config (optional)
└── scripts/              # Helper scripts for hooks (optional)
    └── pre-commit.sh
```

### File Location Discovery

The CLI looks for the plugin manifest in these locations (checked in order):

1. `.plugin/plugin.json`
2. `plugin.json` (root)
3. `.github/plugin/plugin.json`
4. `.claude-plugin/plugin.json`

---

## The Manifest: plugin.json

The manifest is the only **required** file. It declares the plugin's metadata
and tells the CLI where to find its components.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Kebab-case plugin name (letters, numbers, hyphens). Max 64 chars. |

### Optional Metadata Fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Brief description. Max 1024 chars. |
| `version` | string | Semantic version (e.g., `1.0.0`). |
| `author` | object | `{ name, email?, url? }` |
| `homepage` | string | Plugin homepage URL. |
| `repository` | string | Source repository URL. |
| `license` | string | License identifier (e.g., `MIT`). |
| `keywords` | string[] | Search keywords. |
| `category` | string | Plugin category. |
| `tags` | string[] | Additional tags. |

### Component Path Fields

These tell the CLI where to find your components. All are optional — the CLI
uses default conventions if omitted.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agents` | string \| string[] | `agents/` | Path(s) to agent directories |
| `skills` | string \| string[] | `skills/` | Path(s) to skill directories |
| `commands` | string \| string[] | — | Path(s) to command directories |
| `hooks` | string \| object | — | Path to hooks config or inline object |
| `mcpServers` | string \| object | — | Path to MCP config or inline definitions |
| `lspServers` | string \| object | — | Path to LSP config or inline definitions |

### Example

```json
{
  "name": "my-dev-tools",
  "description": "Development utilities and workflow automation",
  "version": "1.0.0",
  "author": {
    "name": "Your Name",
    "email": "you@example.com"
  },
  "license": "MIT",
  "keywords": ["development", "workflow"],
  "agents": "agents/",
  "skills": ["skills/", "extra-skills/"],
  "hooks": "hooks/hooks.json",
  "mcpServers": ".mcp.json"
}
```

---

## Agents

Agents are specialized AI assistants defined as Markdown files with YAML
frontmatter.

### File Naming

- Location: `agents/` directory (or path specified in manifest)
- Pattern: `<name>.agent.md`
- The agent ID is derived from the filename (e.g., `reviewer.agent.md` → ID `reviewer`)

### Frontmatter Schema

```yaml
---
name: my-agent
description: One-line description of what this agent does
tools: ["bash", "edit", "view", "glob", "rg"]
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Human-readable agent name |
| `description` | Yes | Brief description shown in agent listings |
| `tools` | No | List of tools this agent can access |

### Body Content

The Markdown body below the frontmatter is the agent's **system prompt**. This
defines the agent's personality, behavior rules, and output format.

### Example: `agents/reviewer.agent.md`

```markdown
---
name: reviewer
description: Reviews code changes for correctness, security, and style
tools: ["bash", "edit", "view", "glob", "rg"]
---

You are a code reviewer. Analyze changes and provide actionable feedback.

## Checklist

1. Correctness — Does the code work as intended?
2. Security — Any vulnerabilities?
3. Style — Consistent with project conventions?
4. Tests — Are changes tested?

## Output

Group findings by severity: Critical, Warning, Suggestion.
```

### Built-in Tools Available to Agents

| Tool | Purpose |
|------|---------|
| `bash` | Execute shell commands |
| `edit` | Edit files |
| `view` | Read file contents |
| `glob` | Find files by pattern |
| `rg` | Search file contents (ripgrep) |
| `task` | Dispatch sub-agents |

### Design Tips

- Keep the system prompt focused on one role.
- Be explicit about output format expectations.
- Include constraints (what the agent should NOT do).
- Reference shared instructions if needed.

---

## Prompts

Prompts are reusable task templates defined as Markdown files with YAML
frontmatter.

### File Naming

- Location: `prompts/` directory (or path discovered via workspace mode)
- Pattern: `<name>.prompt.md`

### Frontmatter Schema

```yaml
---
name: review-template
description: Reusable prompt for reviewing code changes
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Prompt identifier |
| `description` | Yes | One-line summary used for discovery |

### Example: `prompts/review.prompt.md`

```markdown
---
name: review-template
description: Review code for correctness, security, and test gaps
---

Review the selected changes and report:
1. Critical issues
2. Behavioral regressions
3. Missing tests
```

---

## Skills

Skills are discrete, callable capabilities. Each skill is a directory containing
a `SKILL.md` file.

### Directory Structure

```
skills/
├── research/
│   └── SKILL.md
├── deploy/
│   ├── SKILL.md
│   └── templates/       # Optional supporting files
│       └── deploy.yaml
└── test-driven-development/
    └── SKILL.md
```

### SKILL.md Frontmatter

```yaml
---
name: research
description: Gathers information from the codebase to answer questions
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill name (used for deduplication) |
| `description` | Yes | When/why to use this skill |

### Body Content

The body should include:

1. **When to Use** — Conditions that trigger this skill
2. **Instructions** — Step-by-step procedure for the agent to follow
3. **Rules** — Constraints or invariants to maintain

### Example: `skills/deploy/SKILL.md`

```markdown
---
name: deploy
description: Deploys the current project to the configured environment
---

## When to Use

Activates when the user asks to deploy, ship, or release the project.

## Instructions

1. Verify all tests pass.
2. Check for uncommitted changes.
3. Run the deployment script: `./scripts/deploy.sh`
4. Verify the deployment succeeded.
5. Report the deployed version and URL.

## Rules

- Never deploy with failing tests.
- Always confirm the target environment with the user.
```

### Skill Deduplication

Skills are deduplicated by their `name` field. If multiple plugins define a
skill with the same name, the first-loaded version wins. Project-level skills
always take precedence over plugin skills.

---

## Hooks

Hooks are event handlers that intercept agent behavior at specific lifecycle
points.

### Configuration

Hooks are defined in `hooks/hooks.json` (or inline in `plugin.json`) using
configuration version `1`:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "type": "command",
        "bash": "${PLUGIN_ROOT}/scripts/load-context.sh",
        "powershell": "${PLUGIN_ROOT}/scripts/load-context.ps1",
        "timeoutSec": 10
      }
    ],
    "preToolUse": [
      {
        "type": "command",
        "bash": "${PLUGIN_ROOT}/scripts/guard-destructive.sh",
        "powershell": "${PLUGIN_ROOT}/scripts/guard-destructive.ps1",
        "matcher": "bash",
        "timeoutSec": 15
      }
    ]
  }
}
```

### Available Hook Points

| Hook | Trigger |
|------|---------|
| `sessionStart` | A new or resumed session begins |
| `sessionEnd` | A session terminates |
| `userPromptSubmitted` | A user prompt is submitted |
| `preToolUse` | Before a tool executes (can allow/deny/modify input) |
| `postToolUse` | After a tool succeeds |
| `postToolUseFailure` | After a tool fails |
| `agentStop` | The main agent finishes a turn |
| `subagentStart` | A subagent is spawned |
| `subagentStop` | A subagent completes |
| `errorOccurred` | An error occurs during execution |
| `preCompact` | Context compaction is about to begin |
| `permissionRequest` | Before permission checks run (Copilot CLI only) |
| `notification` | System notification emitted (Copilot CLI only, async) |

Cloud agent supports a subset of events and runs in a Linux sandbox. In cloud
agent, hooks are loaded from `.github/hooks/*.json` in the repository, and only
`bash` (or fallback `command`) entries are used.

### Hook Script Requirements

- Hook config must include `"version": 1`.
- Hook entries are arrays per event, with `type` (`command`, `http`, or
  `prompt`, depending on event support).
- Command hooks should provide `bash` and `powershell` (or `command` fallback)
  for cross-platform support.
- Scripts must be executable when invoked as files (`chmod +x`).
- Exit code `0` indicates success; non-zero behavior depends on event type.
  For `preToolUse`, hook failures are fail-closed and deny the tool call.
- Use `${PLUGIN_ROOT}` when referencing plugin-bundled scripts.

### Design Tips

- Keep hooks fast — they run synchronously in the agent loop.
- Use `matcher` where supported to scope hooks (for example by tool name).
- Log hook actions for debugging.
- Validate and sanitize hook input JSON before acting on it.

---

## MCP Server Configuration

MCP (Model Context Protocol) servers provide tools and resources to the agent
via a standardized protocol.

### Configuration File: `.mcp.json`

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@my-org/mcp-server"],
      "env": {
        "API_KEY": "${MY_API_KEY}"
      }
    },
    "local-server": {
      "command": "${PLUGIN_ROOT}/scripts/start-mcp.sh",
      "args": []
    }
  }
}
```

### Server Entry Fields

| Field | Required | Description |
|-------|----------|-------------|
| `command` | Yes* | Executable to launch the server |
| `bash` | Yes* | Bash command (Linux/macOS alternative) |
| `powershell` | Yes* | PowerShell command (Windows alternative) |
| `args` | No | Command arguments |
| `env` | No | Environment variables |
| `cwd` | No | Working directory |
| `disabled` | No | Set `true` to skip loading |

*At least one of `command`, `bash`, or `powershell` is required.

### Environment Variable Substitution

- `${PLUGIN_ROOT}` — Path to the installed plugin directory
- `${COPILOT_PLUGIN_DATA}` — Persistent writable directory for the plugin
- Standard env vars like `${HOME}`, `${MY_API_KEY}`, etc.

### MCP Precedence

MCP servers use **last-wins** precedence:
1. `~/.copilot/mcp-config.json` (lowest priority)
2. Plugin MCP configs
3. `--additional-mcp-config` flag (highest priority)

---

## LSP Server Configuration

LSP (Language Server Protocol) servers provide language intelligence (completions,
diagnostics, etc.) for specific file types.

### Configuration File: `lsp.json`

```json
{
  "lspServers": {
    "my-lsp": {
      "command": "my-language-server",
      "args": ["--stdio"],
      "fileExtensions": {
        ".myext": "mylang"
      }
    }
  }
}
```

### Cross-Platform Support

```json
{
  "lspServers": {
    "my-lsp": {
      "bash": "${PLUGIN_ROOT}/scripts/start-lsp.sh",
      "powershell": "${PLUGIN_ROOT}/scripts/start-lsp.ps1",
      "fileExtensions": { ".myext": "mylang" }
    }
  }
}
```

---

## Instructions

While not a formal plugin component, instruction files provide shared guidelines
that agents and skills can reference. Place them in an `instructions/` directory.

Common patterns:
- `instructions/coding-standards.md` — Project style guide
- `instructions/security.md` — Security policies
- `instructions/architecture.md` — System design decisions

Agents can reference these in their system prompts:
```markdown
Refer to the `instructions/` directory for project-specific guidelines.
```

---

## Development Workflow

### Initial Setup

```bash
# Create plugin directory
mkdir my-plugin && cd my-plugin

# Create minimal manifest
cat > plugin.json << 'EOF'
{
  "name": "my-plugin",
  "description": "My custom plugin",
  "version": "0.1.0"
}
EOF

# Create directories
mkdir -p agents skills scripts
```

### Install Locally

```bash
copilot plugin install ./my-plugin
```

### Iterate

After making changes, reinstall to pick them up (plugins are cached):

```bash
copilot plugin install ./my-plugin
```

### Verify

```bash
# List installed plugins
copilot plugin list

# In interactive session:
/agent           # List agents
/skills list     # List skills
/plugin list     # List plugins
```

### Uninstall

```bash
copilot plugin uninstall my-plugin
```

> **Note:** Use the plugin `name` from `plugin.json`, not the directory path.

---

## Testing

### Manual Testing

1. Install the plugin locally.
2. Start an interactive session.
3. Verify each agent loads: `/agent`
4. Verify skills load: `/skills list`
5. Test hook triggers by performing the relevant actions.
6. Test MCP servers connect and provide tools.

### Automated Testing

Create test scripts that:
- Validate `plugin.json` is well-formed JSON
- Check all referenced files exist
- Verify agent frontmatter is valid YAML
- Ensure hook scripts are executable

---

## Distribution via Marketplaces

### Creating a Marketplace

A marketplace is a repository with a `marketplace.json` in `.github/plugin/`:

```json
{
  "name": "my-marketplace",
  "owner": {
    "name": "Your Organization",
    "email": "plugins@example.com"
  },
  "metadata": {
    "description": "Curated plugins for our team",
    "version": "1.0.0"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "Description of the plugin",
      "version": "1.0.0",
      "source": "./plugins/my-plugin"
    }
  ]
}
```

### Installing from Marketplaces

```bash
# Register a marketplace
copilot plugin marketplace add OWNER/REPO

# Browse available plugins
copilot plugin marketplace browse MARKETPLACE_NAME

# Install a plugin
copilot plugin install PLUGIN_NAME@MARKETPLACE_NAME
```

### Default Marketplaces

These are registered by default:
- `github/copilot-plugins`
- `github/awesome-copilot`

### Plugin Specification Formats

| Format | Example | Description |
|--------|---------|-------------|
| Marketplace | `plugin@marketplace` | From a registered marketplace |
| GitHub | `OWNER/REPO` | Root of a GitHub repository |
| GitHub subdir | `OWNER/REPO:PATH/TO/PLUGIN` | Subdirectory in a repo |
| Git URL | `https://github.com/o/r.git` | Any Git URL |
| Local path | `./my-plugin` or `/abs/path` | Local directory |

---

## Loading Order and Precedence

### Agents and Skills: First-Found Wins

```
1. Project-level (~/.copilot/agents/, .github/agents/)
2. Inherited (parent directories)
3. Plugin agents (by install order)
4. Remote org/enterprise agents
```

Project-level definitions always override plugin definitions. Plugins cannot
override project or personal configurations.

### MCP Servers: Last Wins

```
1. ~/.copilot/mcp-config.json  (lowest priority)
2. Plugin MCP configs
3. --additional-mcp-config     (highest priority)
```

### Built-in Components

Built-in tools and agents are always present and cannot be overridden.

---

## Best Practices

### Plugin Design

- **Single responsibility** — Each plugin should serve one coherent purpose.
- **Minimal dependencies** — Avoid requiring complex setup or many env vars.
- **Sensible defaults** — Work out of the box with zero configuration.
- **Document requirements** — Clearly state prerequisites and env vars.

### Agent Design

- **Focused role** — One agent, one job.
- **Clear constraints** — State what the agent should NOT do.
- **Structured output** — Define expected output format.
- **Tool minimization** — Only grant tools the agent actually needs.

### Skill Design

- **Clear trigger conditions** — When should this skill activate?
- **Step-by-step instructions** — Unambiguous procedure.
- **Verification steps** — How to confirm the skill succeeded.
- **Guard rails** — Rules that prevent misuse.

### Hook Design

- **Fast execution** — Hooks block the agent loop.
- **Graceful failure** — Don't crash on unexpected input.
- **Scoped triggers** — Use `toolNames` to limit scope.
- **Logging** — Print what the hook did for debugging.

### Security

- Never include secrets in plugin source code.
- Use `${ENV_VAR}` references for sensitive values.
- Validate hook inputs before acting on them.
- Scope tool access to the minimum required set.

---

## References

- [About plugins for GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-plugins)
- [Creating a plugin for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating)
- [GitHub Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/cli-plugin-reference)
- [Finding and installing plugins](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing)
- [Creating a plugin marketplace](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace)
