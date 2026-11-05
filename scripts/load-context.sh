#!/usr/bin/env bash
# Load project context at session start.
# This hook can print context that gets injected into the agent's system prompt.

set -euo pipefail

# Example: print key project facts
if [ -f "README.md" ]; then
  echo "Project README detected."
else
  echo "No README found."
fi
