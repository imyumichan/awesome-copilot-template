# Plugin Bundler

Plugin Bundler is a web app for editing a plugin. Load a plugin repository, change its items
and configuration, then download the result as a ZIP or publish it to GitHub.

Open the app from [index.html](../index.html).

## Getting started

1. Load a repository in the **Source** form, or open a link that fills in the form.
2. Edit items in the tabs.
3. Check the **Review** panel under **Output**.
4. Download the ZIP, or publish the changes to GitHub.

## Tabs

- **Agents, Skills, Prompts, Instructions**: add, edit or remove items.
- **Scripts**: upload files up to 1 MB. Files are saved under `scripts/` and made executable.
  Removing a script deletes it when you publish.
- **Config**:
  - Plugin details: `name`, `description` and `version` in `plugin.json`.
  - `.mcp.json` and `hooks.json`: edit the JSON directly. It is checked when you press Apply.
  - Line endings (CRLF or LF) are kept when you edit a file.

## Limits

Loading and uploading show a message when a limit is reached.

| What | Limit |
| --- | --- |
| Files in a loaded repository or in the output package | 2000 |
| One loaded file | 5 MiB |
| All loaded files, and the output package | 32 MiB |
| One symlink target | 240 bytes |
| Files in one upload action | 200 |
| One uploaded file | 1 MiB |
| All files in one upload action | 8 MiB |

A repository over the file-count or size limits is rejected before it loads.

## Symlinks

Relative links such as `.github/agents -> ../agents` are kept and written to the ZIP and the commit.
A link that points outside the plugin, uses an absolute path, has an invalid name, or points through
another link is removed on load, with a warning. Linked items cannot be edited in the dialog.

## Publishing and review

To publish, sign in with a GitHub token. Use a fine-grained token (starts with `github_pat_`) that
has access to the repository you publish to. The token is kept in this tab only and is cleared when
you reload the page. Sign out to stop any running request.

Publishing creates a commit with your changes. If the commit adds or changes hook or MCP
configuration, a file named in a hook command, or any file under `scripts/`, type the target
`owner/repo` to confirm.

The **Review before you download or publish** panel under **Output** lists everything that will run
or be installed: hook commands, MCP servers (command or URL, arguments, folders and environment
values), executable files and symlinks. Rows are never cut short.

A repository other than the one this site is served from, or a branch other than its default branch,
is marked as not trusted. For such a source, tick the confirmation before you download, preview or
publish.

A link with `?repo=` or `?branch=` only fills in the Source form. Nothing loads until you press Load.

## Browser requirements

Chrome 100, Firefox 97 or Safari 16, or newer.
