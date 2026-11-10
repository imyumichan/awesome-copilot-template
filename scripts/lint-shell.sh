#!/usr/bin/env bash
#
# Lint shell scripts: ShellCheck plus a shell syntax check.
#
# Usage:
#   scripts/lint-shell.sh [file ...]
#
# Without arguments, lints every tracked file that is a shell script (a .sh
# file or one with a sh/bash/dash/ksh shebang). Requires ShellCheck on PATH.
set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

command -v shellcheck >/dev/null 2>&1 || die "required tool 'shellcheck' is not on PATH"

shebang_re='^#!.*[/[:space:]](bash|dash|ksh|sh)([[:space:]]|$)'

is_shell_file() {
  local first_line=""

  [[ -f "$1" ]] || return 1
  [[ "$1" == *.sh ]] && return 0
  IFS= read -r first_line <"$1" || true
  [[ "$first_line" =~ $shebang_re ]]
}

files=()
if [[ $# -gt 0 ]]; then
  for path in "$@"; do
    [[ -f "$path" ]] || die "not a file: $path"
    files+=("$path")
  done
else
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "run this from inside a git work tree, or pass files explicitly"
  while IFS= read -r -d '' path; do
    if is_shell_file "$path"; then
      files+=("$path")
    fi
  done < <(git ls-files -z)
fi

if [[ ${#files[@]} -eq 0 ]]; then
  echo "No shell files found."
  exit 0
fi

echo "Linting ${#files[@]} shell file(s)"
shellcheck --severity=warning --external-sources --source-path=SCRIPTDIR "${files[@]}"

for file in "${files[@]}"; do
  IFS= read -r first_line <"$file" || true
  case "$first_line" in
    *"/sh"* | *" sh"* | *"/dash"* | *" dash"*) sh -n "$file" ;;
    *) bash -n "$file" ;;
  esac
done
