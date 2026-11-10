import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hasShellcheck = spawnSync('shellcheck', ['--version']).status === 0;
const needsShellcheck = { skip: !hasShellcheck && 'shellcheck is not installed' };

function lint(scriptText) {
  const file = join(mkdtempSync(join(tmpdir(), 'lint-shell-')), 'sample.sh');
  writeFileSync(file, scriptText);
  const result = spawnSync('bash', ['scripts/lint-shell.sh', file], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

test('lint-shell accepts a clean script', needsShellcheck, () => {
  const { status, output } = lint('#!/usr/bin/env bash\nset -euo pipefail\necho "ok"\n');
  assert.equal(status, 0, output);
});

test('lint-shell rejects a script with a syntax error', needsShellcheck, () => {
  const { status } = lint('#!/usr/bin/env bash\nif true; then\necho "unterminated"\n');
  assert.notEqual(status, 0);
});

test('lint-shell rejects a script with a ShellCheck warning', needsShellcheck, () => {
  const { status, output } = lint('#!/usr/bin/env bash\ncd /tmp\nls\n');
  assert.notEqual(status, 0, output);
  assert.match(output, /SC2164/);
});

test('lint-shell fails with a clear message when shellcheck is missing', () => {
  const emptyPath = mkdtempSync(join(tmpdir(), 'no-tools-'));
  const result = spawnSync('/bin/bash', ['scripts/lint-shell.sh'], { encoding: 'utf8', env: { PATH: emptyPath } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shellcheck/);
});
