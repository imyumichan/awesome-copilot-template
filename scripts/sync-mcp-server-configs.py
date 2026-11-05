#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# ///
"""Generate a VS Code-compatible .vscode/mcp.json from the repo's .mcp.json.

The Copilot CLI plugin reads MCP server definitions from .mcp.json under a
top-level "mcpServers" key, while VS Code reads them from .vscode/mcp.json
under a top-level "servers" key. This script renames only that top-level key,
copying everything else (key order, args order, _comment fields) verbatim.
"""

import argparse
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE = REPO_ROOT / ".mcp.json"
OUTPUT = REPO_ROOT / ".vscode" / "mcp.json"

SOURCE_KEY = "mcpServers"
TARGET_KEY = "servers"


def load_source():
    """Load and validate the source .mcp.json, exiting non-zero on any error."""
    if not SOURCE.exists():
        sys.exit(f"error: source file not found: {SOURCE}")
    try:
        with SOURCE.open(encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        sys.exit(f"error: {SOURCE} is not valid JSON: {exc}")
    if not isinstance(data, dict) or SOURCE_KEY not in data:
        sys.exit(
            f"error: {SOURCE} must be a JSON object containing a top-level "
            f"'{SOURCE_KEY}' key"
        )
    if TARGET_KEY in data:
        sys.exit(
            f"error: {SOURCE} must not contain both '{SOURCE_KEY}' and "
            f"'{TARGET_KEY}' keys"
        )
    return data


def transform(data):
    """Return a copy of data with only the top-level mcpServers key renamed.

    Top-level key order is preserved; nested content is left untouched.
    """
    return {
        (TARGET_KEY if key == SOURCE_KEY else key): value
        for key, value in data.items()
    }


def render(obj):
    """Serialize obj to the canonical .vscode/mcp.json text."""
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def write_atomically(text):
    """Write text to OUTPUT atomically via a temp file in the same directory."""
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUTPUT.with_name(OUTPUT.name + ".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, OUTPUT)
    except OSError:
        if tmp.exists():
            tmp.unlink()
        raise


def main():
    parser = argparse.ArgumentParser(
        description="Generate .vscode/mcp.json from .mcp.json (mcpServers -> servers)."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify .vscode/mcp.json is in sync without writing; exit non-zero if not",
    )
    args = parser.parse_args()

    expected = render(transform(load_source()))

    if args.check:
        if OUTPUT.exists() and OUTPUT.read_text(encoding="utf-8") == expected:
            return 0
        print(
            "error: .vscode/mcp.json is out of sync — run "
            "scripts/sync-mcp-server-configs.py and commit .vscode/mcp.json",
            file=sys.stderr,
        )
        return 1

    write_atomically(expected)
    print(f"wrote {OUTPUT.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
