import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const hasPython = spawnSync('python3', ['--version']).status === 0;

test('.vscode/mcp.json is in sync with .mcp.json', { skip: !hasPython && 'python3 is not installed' }, () => {
  const result = spawnSync('python3', ['scripts/sync-mcp-server-configs.py', '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
