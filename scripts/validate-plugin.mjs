#!/usr/bin/env node
// Structural check plus a reviewer inventory of everything that can run code or reach a server; no dependency on docs/app.
import { appendFileSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] || '.');
const SKIP = new Set(['.git', 'node_modules', '.venv']);
const BAD_PATH = /[\\\x00-\x1f\x7f]/;
const COMMAND_KEYS = new Set(['bash', 'powershell', 'command', 'run']);

const problems = [];
const files = [];
const executables = [];
const symlinks = [];
// Only shell-style scripts are scanned; path-like text in js/py source is too ambiguous to judge.
const SCRIPT_EXTENSIONS = ['.sh', '.bash', '.zsh', '.ksh', '.ps1', '.cmd', '.bat'];

function isScriptFile(rel) {
  return SCRIPT_EXTENSIONS.some((ext) => rel.endsWith(ext));
}

function inspectScriptForEscape(rel) {
  try {
    const text = readFileSync(join(root, rel), 'utf8');
    for (const match of text.matchAll(/(?:^|[\s"'`])((?:~\/|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/])[^\s"'`<>;&|()]+)/g)) {
      const token = match[1];
      if (/^https?:\/\//.test(token)) continue;
      checkCommandTargets(token, rel);
    }
  } catch {
    // ignore unreadable files; the repo walk already records other structural issues
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const rel = relative(root, full).split(sep).join('/');
    if (BAD_PATH.test(rel)) problems.push(`${JSON.stringify(rel)}: path has a backslash or control character`);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(full);
      const inside = !isAbsolute(target) && !relative(root, resolve(dirname(full), target)).startsWith('..');
      if (!inside) problems.push(`${rel}: symlink target ${JSON.stringify(target)} is absolute or leaves the repository`);
      symlinks.push(`${rel} -> ${target}`);
    } else if (st.isDirectory()) walk(full);
    else {
      files.push(rel);
      if (st.mode & 0o111) executables.push(rel);
    }
  }
}

function checkCommandTargets(command, source) {
  for (const token of command.split(/[\s;&|()<>]+/)) {
    const clean = token.replace(/^['"]+|['"]+$/g, '').trim();
    if (!clean || clean === '.' || clean === '..' || !/^(?:\.|\/|~\/|[A-Za-z]:[\\/])/.test(clean)) continue;
    if (/^[A-Za-z]:[\\/]/.test(clean)) {
      problems.push(`${source}: command ${JSON.stringify(command)} resolves outside the repository via ${JSON.stringify(clean)}`);
      return;
    }
    if (clean.startsWith('~')) {
      const expanded = resolve(process.env.HOME || '/', clean.slice(1));
      const rel = relative(root, expanded);
      if (rel.startsWith('..') || rel === '..') {
        problems.push(`${source}: command ${JSON.stringify(command)} resolves outside the repository via ${JSON.stringify(clean)}`);
        return;
      }
      continue;
    }
    const resolved = resolve(root, clean);
    const rel = relative(root, resolved);
    if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) {
      problems.push(`${source}: command ${JSON.stringify(command)} resolves outside the repository via ${JSON.stringify(clean)}`);
      return;
    }
  }
}

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(join(root, rel), 'utf8'));
  } catch (e) {
    problems.push(`${rel}: ${e.code === 'ENOENT' ? 'file is missing' : 'is not valid JSON'}`);
    return null;
  }
}

function commandsIn(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => commandsIn(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (COMMAND_KEYS.has(k) && typeof v === 'string') out.push(v);
      else commandsIn(v, out);
    }
  }
  return out;
}

walk(root);
for (const rel of files) {
  if (isScriptFile(rel)) inspectScriptForEscape(rel);
}

const manifest = files.includes('plugin.json') ? readJson('plugin.json') : (problems.push('plugin.json: file is missing'), null);
if (manifest && (typeof manifest !== 'object' || Array.isArray(manifest) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string')) {
  problems.push('plugin.json: must be an object with string "name" and "version"');
}

const hookFiles = new Set(files.filter((f) => f === 'hooks.json' || f.endsWith('/hooks.json')));
if (typeof manifest?.hooks === 'string') hookFiles.add(manifest.hooks);
const mcpFiles = new Set(files.filter((f) => /(^|\/)(\.mcp\.json|mcp\.json)$/.test(f)));
if (typeof manifest?.mcpServers === 'string') mcpFiles.add(manifest.mcpServers);

const hooks = [...hookFiles].flatMap((f) => {
  const cmds = commandsIn(readJson(f));
  cmds.forEach((c) => checkCommandTargets(c, f));
  return cmds.map((c) => `${f}: ${c}`);
});
const servers = [...mcpFiles].flatMap((f) => {
  const cfg = readJson(f) || {};
  const entries = Object.entries(cfg.mcpServers || cfg.servers || {});
  for (const [, s] of entries) {
    const pieces = [s.command, ...(s.args || [])].filter(Boolean);
    if (pieces.length) pieces.forEach((piece) => checkCommandTargets(piece, f));
    for (const field of ['url', 'httpUrl', 'serverUrl']) {
      if (typeof s[field] === 'string') checkCommandTargets(s[field], f);
    }
  }
  return entries.map(([name, s]) => `${f}: ${name} -> ${s.url || s.httpUrl || s.serverUrl || [s.command, ...(s.args || [])].join(' ')}`);
});

const section = (title, items) => `### ${title} (${items.length})\n${items.length ? items.map((i) => `- \`${i}\``).join('\n') : '- none'}\n`;
const report = ['## Plugin review inventory\n', section('Hook commands', hooks), section('MCP servers', servers), section('Executable files', executables), section('Symlinks', symlinks)].join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(1);
}
