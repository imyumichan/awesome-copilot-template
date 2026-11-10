import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const skillsDir = join(root, 'skills');
const MAX_SKILL_LINES = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const JUNK = /^(\.DS_Store|Thumbs\.db|node_modules|__pycache__|\.git|.*\.(log|orig|tmp|pyc))$/;
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const lines = match[1].split(/\r?\n/);
  const fields = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2];
    if (/^[>|][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(' ');
    }
    fields[kv[1]] = value.replace(/^(['"])(.*)\1$/, '$2');
  }
  return fields;
}

function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() || JUNK.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

const skills = existsSync(skillsDir)
  ? readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];

for (const skill of skills) {
  const dir = join(skillsDir, skill);
  const skillFile = join(dir, 'SKILL.md');

  test(`skill ${skill}: has SKILL.md with a matching name and a description`, () => {
    assert.ok(existsSync(skillFile), 'SKILL.md is missing');
    const fields = frontmatter(readFileSync(skillFile, 'utf8'));
    assert.ok(fields, 'SKILL.md has no frontmatter');
    assert.equal(fields.name, skill, 'frontmatter "name" must equal the folder name');
    assert.match(fields.name, NAME);
    assert.ok(fields.name.length <= 64, 'name is longer than 64 characters');
    assert.ok(fields.description, 'description is missing');
    assert.ok(fields.description.length >= 10, 'description is shorter than 10 characters');
    assert.ok(fields.description.length <= 1024, 'description is longer than 1024 characters');
  });

  test(`skill ${skill}: contains no dev or OS junk files`, () => {
    const junk = filesIn(dir).filter((file) => JUNK.test(file.split('/').pop()));
    assert.deepEqual(junk, []);
  });

  test(`skill ${skill}: SKILL.md and bundled files stay within size limits`, () => {
    if (existsSync(skillFile)) {
      const lines = readFileSync(skillFile, 'utf8').split('\n').length;
      assert.ok(lines <= MAX_SKILL_LINES, `SKILL.md has ${lines} lines (max ${MAX_SKILL_LINES}); move detail into referenced files`);
    }
    for (const file of filesIn(dir)) {
      assert.ok(statSync(file).size <= MAX_FILE_BYTES, `${file} is larger than 5 MB`);
    }
  });
}
