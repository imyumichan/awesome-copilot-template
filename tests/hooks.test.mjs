import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SHEBANG = /^#!.*[/\s](bash|dash|ksh|sh)(\s|$)/;

const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
const hooksPath = typeof manifest.hooks === 'string' ? manifest.hooks : 'hooks/hooks.json';
const config = JSON.parse(readFileSync(join(root, hooksPath), 'utf8'));
const entries = Object.entries(config.hooks ?? {}).flatMap(([event, list]) => list.map((hook) => ({ event, ...hook })));
const commandOf = (hook) => hook.bash ?? hook.command;

function scriptTarget(command) {
  const first = command.trim().split(/\s+/)[0];
  if (!first.includes('/')) return null;
  return first.replace(/^\$\{PLUGIN_ROOT\}\//, '').replace(/^\.\//, '');
}

function shellScripts(dir) {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => file.endsWith('.sh') || SHEBANG.test(readFileSync(file, 'utf8').split('\n', 1)[0]));
}

test('hooks config uses version 1 and defines at least one hook', () => {
  assert.equal(config.version, 1);
  assert.ok(entries.length > 0, 'no hooks defined');
});

test('every hook has a command', () => {
  for (const hook of entries) {
    assert.equal(typeof commandOf(hook), 'string', `${hook.event}: missing "bash" or "command"`);
  }
});

test('hook commands point at existing executable scripts', () => {
  for (const hook of entries) {
    const target = scriptTarget(commandOf(hook));
    if (!target) continue;
    const file = join(root, target);
    assert.ok(existsSync(file), `${hook.event}: ${target} does not exist`);
    assert.ok(statSync(file).mode & 0o111, `${hook.event}: ${target} is not executable`);
  }
});

test('shell scripts in scripts/, hooks/ and .githooks/ are executable', () => {
  const files = ['scripts', 'hooks', '.githooks'].flatMap(shellScripts);
  for (const file of files) {
    assert.ok(statSync(file).mode & 0o111, `${file} is not executable (chmod +x)`);
  }
});

for (const hook of entries.filter((h) => h.event === 'sessionStart')) {
  test(`sessionStart hook "${commandOf(hook)}" exits 0 within its timeout and prints something`, () => {
    const result = spawnSync('bash', ['-c', commandOf(hook)], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PLUGIN_ROOT: root },
      timeout: (hook.timeoutSec ?? 10) * 1000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim().length > 0, 'hook printed nothing');
    if (result.stdout.trimStart().startsWith('{')) JSON.parse(result.stdout);
  });
}
