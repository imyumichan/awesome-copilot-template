// Pure plugin-model logic (no DOM): classify repo files into editable items and rebuild the file set.
export const CATEGORY_DEFS = [
  { key: 'agents', label: 'Agents', manifestKey: 'agents', fallback: 'agents', kind: 'file', suffix: '.agent.md', required: ['name', 'description'] },
  { key: 'skills', label: 'Skills', manifestKey: 'skills', fallback: 'skills', kind: 'dir', main: 'SKILL.md', required: ['name', 'description'] },
  { key: 'prompts', label: 'Prompts', manifestKey: 'commands', fallback: 'prompts', kind: 'file', suffix: '.prompt.md', required: [] },
  { key: 'instructions', label: 'Instructions', manifestKey: null, fallback: 'instructions', kind: 'file', suffix: '.instructions.md', required: [] },
  { key: 'scripts', label: 'Scripts', manifestKey: null, fallback: 'scripts', kind: 'file', suffix: '', anyFile: true, mode: 0o100755, required: [] },
];

export const MIB = 1024 * 1024;
export const LIMITS = Object.freeze({
  maxFiles: 2000, // blobs per loaded repo and per output package
  maxFileBytes: 5 * MIB,
  maxTotalBytes: 32 * MIB,
  maxSymlinkBytes: 240, // one symlink target; also the character cap in validateSymlink
  maxUploadFiles: 200,
  maxUploadBytes: 1 * MIB,
  maxUploadTotalBytes: 8 * MIB,
});
export const MAX_UPLOAD_BYTES = LIMITS.maxUploadBytes;
export const formatMiB = (n) => `${+(n / MIB).toFixed(1)} MiB`;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
export const decodeUtf8 = (bytes) => decoder.decode(bytes);
export const encodeUtf8 = (text) => encoder.encode(text);

export function isSafePath(path) {
  if (typeof path !== 'string' || !path || path.length > 240) return false;
  if (path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f]/.test(path)) return false;
  return path.split('/').every((s) => s && s !== '.' && s !== '..');
}

export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { present: false, fields: {} };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { present: true, fields };
}

export function resolveDirs(manifest) {
  const dirs = {};
  for (const def of CATEGORY_DEFS) {
    let dir = def.fallback;
    const v = def.manifestKey && manifest ? manifest[def.manifestKey] : null;
    if (typeof v === 'string') {
      const cleaned = v.replace(/^\.\//, '').replace(/\/+$/, '');
      if (isSafePath(cleaned)) dir = cleaned;
    }
    dirs[def.key] = dir;
  }
  return dirs;
}

export function classifyPath(path, dirs) {
  for (const def of CATEGORY_DEFS) {
    const prefix = `${dirs[def.key]}/`;
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (def.kind === 'file') {
      if (!rest.includes('/') && rest.endsWith(def.suffix) && rest.length > def.suffix.length) {
        return { cat: def.key, name: rest.slice(0, rest.length - def.suffix.length) };
      }
    } else {
      const parts = rest.split('/');
      if (parts.length >= 2) return { cat: def.key, name: parts[0] };
    }
  }
  return null;
}

export function buildModel(files) {
  let manifest = {};
  const mf = files.find((f) => f.path === 'plugin.json');
  if (mf) {
    try {
      manifest = JSON.parse(decodeUtf8(mf.bytes));
    } catch {
      manifest = {};
    }
    if (!isObject(manifest)) manifest = {};
  }
  const dirs = resolveDirs(manifest);
  const items = new Map();
  const baseFiles = [];
  for (const f of files) {
    const c = classifyPath(f.path, dirs);
    if (!c) {
      baseFiles.push(f);
      continue;
    }
    const id = `${c.cat}:${c.name}`;
    if (!items.has(id)) items.set(id, { id, cat: c.cat, name: c.name, origin: 'repo', edited: false, removed: false, files: [] });
    items.get(id).files.push(f);
  }
  return { manifest, dirs, baseFiles, items: [...items.values()] };
}

export const categoryDef = (key) => CATEGORY_DEFS.find((d) => d.key === key);

export function mainFile(item, dirs) {
  const def = categoryDef(item.cat);
  if (def.kind === 'dir') {
    const want = `${dirs[item.cat]}/${item.name}/${def.main}`;
    return item.files.find((f) => f.path === want)
      || item.files.find((f) => f.path.split('/').pop() === def.main)
      || null;
  }
  return item.files[0] || null;
}

export function itemWarnings(item, dirs) {
  const def = categoryDef(item.cat);
  const main = mainFile(item, dirs);
  if (!main) return [`missing ${def.main}`];
  if (def.anyFile) return [];
  let text;
  try {
    text = decodeUtf8(main.bytes);
  } catch {
    return ['not valid UTF-8'];
  }
  if (!def.required.length) return [];
  const fm = parseFrontmatter(text);
  if (!fm.present) return ['no frontmatter'];
  const missing = def.required.filter((k) => !fm.fields[k]);
  return missing.length ? [`frontmatter missing: ${missing.join(', ')}`] : [];
}

export function createItemFromUpload(def, dirs, filename, bytes) {
  if (def.anyFile) {
    if (bytes.length === 0) throw new Error('file is empty');
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('file is larger than 1 MB');
    if (!NAME_RE.test(filename)) throw new Error(`invalid name "${filename}" (allowed: letters, digits, dot, underscore, hyphen; must start with a letter or digit)`);
    const target = `${dirs[def.key]}/${filename}`;
    if (!isSafePath(target)) throw new Error('invalid target path');
    return { id: `${def.key}:${filename}`, cat: def.key, name: filename, origin: 'upload', edited: false, removed: false, files: [{ path: target, bytes, mode: def.mode }] };
  }
  if (!/\.md$/i.test(filename)) throw new Error('only .md files are supported');
  if (bytes.length === 0) throw new Error('file is empty');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('file is larger than 1 MB');
  let text;
  try {
    text = decodeUtf8(bytes);
  } catch {
    throw new Error('file is not valid UTF-8');
  }
  const dir = dirs[def.key];
  let name;
  let path;
  if (def.kind === 'file') {
    name = filename.endsWith(def.suffix) ? filename.slice(0, -def.suffix.length) : filename.replace(/\.md$/i, '');
    if (!NAME_RE.test(name)) throw new Error(`invalid name "${name}"`);
    path = `${dir}/${name}${def.suffix}`;
  } else {
    const fm = parseFrontmatter(text);
    name = fm.fields.name || (filename.toLowerCase() === 'skill.md' ? '' : filename.replace(/\.md$/i, ''));
    if (!name) throw new Error('skill needs a "name" in its frontmatter');
    if (!KEBAB_RE.test(name)) throw new Error(`skill name "${name}" must be kebab-case`);
    path = `${dir}/${name}/${def.main}`;
  }
  if (!isSafePath(path)) throw new Error('invalid target path');
  return { id: `${def.key}:${name}`, cat: def.key, name, origin: 'upload', edited: false, removed: false, files: [{ path, bytes, mode: 0o100644 }] };
}

export function createItemFromUploadFiles(def, dirs, files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('no files selected');

  const entries = files.map((file) => {
    const rawPath = typeof file?.webkitRelativePath === 'string' && file.webkitRelativePath
      ? file.webkitRelativePath.replace(/^\/+/, '')
      : (typeof file?.path === 'string' ? file.path.replace(/^\/+/, '') : (file?.name || ''));
    const name = file?.name || rawPath.split('/').pop() || '';
    const bytes = file?.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file?.bytes || []);
    return { name, path: rawPath, bytes };
  });

  if (def.kind === 'file') {
    if (entries.length > 1) throw new Error('only one file may be uploaded at a time');
    const [entry] = entries;
    return createItemFromUpload(def, dirs, entry.name, entry.bytes);
  }

  if (entries.length === 1 && !entries[0].path.includes('/')) {
    return createItemFromUpload(def, dirs, entries[0].name, entries[0].bytes);
  }

  const sizeProblem = uploadSizeProblem(entries.map((e) => e.bytes.length));
  if (sizeProblem) throw new Error(sizeProblem);

  const mainEntry = entries.find((entry) => (entry.path.split('/').pop() || '').toLowerCase() === def.main.toLowerCase());
  if (!mainEntry) throw new Error(`skill folder must include ${def.main}`);

  const text = decodeUtf8(mainEntry.bytes);
  const fm = parseFrontmatter(text);
  const folderName = mainEntry.path.split('/')[0] || mainEntry.name.replace(/\.md$/i, '');
  let name = fm.fields.name || folderName;
  if (!name) throw new Error('skill needs a "name" in its frontmatter');
  if (!KEBAB_RE.test(name)) throw new Error(`skill name "${name}" must be kebab-case`);

  const dir = dirs[def.key];
  const outgoing = [];
  for (const entry of entries) {
    const clean = entry.path.replace(/^\/+/, '');
    const relative = clean.includes('/') ? clean.split('/').slice(1).join('/') : clean;
    const target = relative && relative !== def.main ? `${dir}/${name}/${relative}` : `${dir}/${name}/${def.main}`;
    if (!isSafePath(target)) throw new Error('invalid target path');
    outgoing.push({ path: target, bytes: entry.bytes, mode: 0o100644 });
  }

  return { id: `${def.key}:${name}`, cat: def.key, name, origin: 'upload', edited: false, removed: false, files: outgoing };
}

/** Adds or replaces an upload in `items`; a replaced skill keeps its supporting files. */
export function mergeUpload(items, incoming) {
  const idx = items.findIndex((i) => i.id === incoming.id);
  if (idx < 0) {
    items.push(incoming);
    return 'added';
  }
  const existing = items[idx];
  const paths = new Set(incoming.files.map((f) => f.path));
  incoming.files = [...existing.files.filter((f) => !paths.has(f.path)), ...incoming.files];
  items[idx] = incoming;
  return 'replaced';
}

// The bundler itself must not end up in packages or published repos.
export const isWebAppPath = (path) => path === 'docs/index.html' || path.startsWith('docs/app/');

export function displayName(item, dirs) {
  if (item.cat === 'skills') return item.name;
  const main = mainFile(item, dirs);
  return main ? main.path.slice(dirs[item.cat].length + 1) : item.name;
}

export function finalFiles(baseFiles, items) {
  const out = new Map();
  for (const f of baseFiles) if (!isWebAppPath(f.path)) out.set(f.path, { bytes: f.bytes, mode: f.mode });
  for (const item of items) {
    if (item.removed) continue;
    for (const f of item.files) out.set(f.path, { bytes: f.bytes, mode: f.mode });
  }
  return out;
}

// ---- Plugin config files (plugin.json fields, MCP, hooks, marketplace) ----

export const VSCODE_MCP_PATH = '.vscode/mcp.json';
export const MARKETPLACE_PATH = '.github/plugin/marketplace.json';
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Paths of the MCP and hooks files; plugin.json may relocate them with a string value. */
export function resolveConfigPaths(manifest) {
  const dirs = resolveDirs(manifest);
  const reserved = ['plugin.json', MARKETPLACE_PATH, VSCODE_MCP_PATH];
  const pick = (v, fallback) => {
    if (typeof v !== 'string') return fallback;
    const cleaned = v.replace(/^\.\//, '');
    if (!isSafePath(cleaned) || !cleaned.endsWith('.json')) return fallback;
    return reserved.includes(cleaned) || classifyPath(cleaned, dirs) ? fallback : cleaned;
  };
  return { mcp: pick(manifest?.mcpServers, '.mcp.json'), hooks: pick(manifest?.hooks, 'hooks/hooks.json'), vscodeMcp: VSCODE_MCP_PATH };
}

/** True when the first line break in `text` is CRLF; mixed files follow that first break. */
export function usesCrlf(text) {
  const m = text.match(/\r?\n/);
  return m !== null && m[0] === '\r\n';
}

/** Textarea values are LF-only; converts every line break to CRLF when `crlf`, else to LF. */
export function restoreEol(text, crlf) {
  const lf = text.replace(/\r\n/g, '\n');
  return crlf ? lf.replace(/\n/g, '\r\n') : lf;
}

function detectIndent(text) {
  const m = text.match(/^[ \t]+(?=")/m);
  return m ? m[0] : '  ';
}

function serializeJson(value, original) {
  return JSON.stringify(value, null, detectIndent(original)) + (original === '' || original.endsWith('\n') ? '\n' : '');
}

// Minimal JSON scanner: finds value spans in already-valid JSON text so edits leave other bytes untouched.
const skipWs = (t, i) => {
  while (i < t.length && /[ \t\r\n]/.test(t[i])) i++;
  return i;
};

function skipString(t, i) {
  for (i++; i < t.length; i++) {
    if (t[i] === '\\') i++;
    else if (t[i] === '"') return i + 1;
  }
  throw new Error('unterminated string');
}

function skipValue(t, i) {
  if (t[i] === '"') return skipString(t, i);
  if (t[i] === '{' || t[i] === '[') {
    let depth = 0;
    for (; i < t.length; i++) {
      if (t[i] === '"') i = skipString(t, i) - 1;
      else if (t[i] === '{' || t[i] === '[') depth++;
      else if ((t[i] === '}' || t[i] === ']') && --depth === 0) return i + 1;
    }
    throw new Error('unterminated container');
  }
  while (i < t.length && !/[,\]}\s]/.test(t[i])) i++;
  return i;
}

function* members(t, container) {
  const isObj = t[container] === '{';
  let i = skipWs(t, container + 1);
  let index = 0;
  while (i < t.length && t[i] !== '}' && t[i] !== ']') {
    let key = index++;
    if (isObj) {
      const keyEnd = skipString(t, i);
      key = JSON.parse(t.slice(i, keyEnd));
      i = skipWs(t, keyEnd);
      if (t[i] !== ':') throw new Error('expected colon');
      i = skipWs(t, i + 1);
    }
    const end = skipValue(t, i);
    yield { key, start: i, end };
    i = skipWs(t, end);
    if (t[i] === ',') i = skipWs(t, i + 1);
  }
}

function locate(t, path) {
  let start = skipWs(t, 0);
  let end = skipValue(t, start);
  for (const step of path) {
    if (t[start] !== '{' && t[start] !== '[') return null;
    let found = null;
    for (const m of members(t, start)) if (m.key === step) found = m;
    if (!found) return null;
    ({ start, end } = found);
  }
  return { start, end };
}

/** Replaces existing string values under the object at `path`; null when a key is missing, not a string, or scanning fails. */
export function setJsonStringProps(text, path, props) {
  try {
    const edits = [];
    for (const [key, value] of Object.entries(props)) {
      const span = locate(text, [...path, key]);
      if (!span || text[span.start] !== '"') return null;
      if (JSON.parse(text.slice(span.start, span.end)) !== value) edits.push({ ...span, value });
    }
    let out = text;
    for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + JSON.stringify(e.value) + out.slice(e.end);
    return out;
  } catch {
    return null;
  }
}

function parseJsonObject(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { error: `invalid JSON: ${e.message}` };
  }
  return isObject(value) ? { value } : { error: 'top level must be a JSON object' };
}

/** Errors for the editable plugin.json fields; a field equal to its `current` value is not re-validated. */
export function validatePluginMeta({ name, description, version }, current = {}) {
  const errors = [];
  if (name !== current.name && (!KEBAB_RE.test(name) || name.length > 64)) errors.push('name must be kebab-case (a-z, 0-9, hyphens), at most 64 characters');
  if (description !== current.description) {
    if (!description.trim()) errors.push('description is required');
    else if (description.length > 1024 || /[\r\n]/.test(description)) errors.push('description must be a single line of at most 1024 characters');
  }
  if (version !== current.version && !SEMVER_RE.test(version)) errors.push('version must be semver, for example 1.2.3');
  return errors;
}

/** Returns plugin.json text with only name, description and version replaced. */
export function applyPluginMeta(text, fields) {
  const parsed = parseJsonObject(text);
  if (parsed.error) throw new Error(`plugin.json: ${parsed.error}`);
  const { name, description, version } = fields;
  const edited = setJsonStringProps(text, [], { name, description, version });
  if (edited !== null) return edited;
  Object.assign(parsed.value, { name, description, version });
  return serializeJson(parsed.value, text);
}

const MCP_TRANSPORT_KEYS = ['command', 'url', 'httpUrl', 'serverUrl'];

export function validateMcpJson(text) {
  const parsed = parseJsonObject(text);
  if (parsed.error) return { errors: [parsed.error] };
  const v = parsed.value;
  const errors = [];
  if ('servers' in v) errors.push('use "mcpServers", not "servers" (.vscode/mcp.json is generated)');
  if (!isObject(v.mcpServers)) {
    errors.push('"mcpServers" must be an object');
  } else {
    for (const [name, s] of Object.entries(v.mcpServers)) {
      if (name.startsWith('_')) continue;
      if (!isObject(s)) errors.push(`server "${name}" must be an object`);
      else if (!MCP_TRANSPORT_KEYS.some((k) => typeof s[k] === 'string')) errors.push(`server "${name}" needs a string "command", "url", "httpUrl" or "serverUrl"`);
    }
  }
  if ('inputs' in v && !Array.isArray(v.inputs)) errors.push('"inputs" must be an array');
  return { errors, value: v };
}

/** Same transform as scripts/sync-mcp-server-configs.py: top-level mcpServers becomes servers. */
// Known limits vs Python: integer-like keys are reordered by JS and number formatting can differ.
export function mirrorMcpJson(text) {
  const out = Object.fromEntries(Object.entries(JSON.parse(text)).map(([k, v]) => [k === 'mcpServers' ? 'servers' : k, v]));
  return `${JSON.stringify(out, null, 2)}\n`;
}

const HOOK_COMMAND_KEYS = ['command', 'bash', 'powershell'];

export function validateHooksJson(text) {
  const parsed = parseJsonObject(text);
  if (parsed.error) return { errors: [parsed.error] };
  const v = parsed.value;
  const errors = [];
  if (!isObject(v.hooks)) {
    errors.push('"hooks" must be an object');
  } else {
    const checkEntries = (list, path) => list.forEach((entry, i) => {
      const at = `${path}[${i}]`;
      if (!isObject(entry)) {
        errors.push(`${at} must be an object`);
        return;
      }
      if (Array.isArray(entry.hooks)) checkEntries(entry.hooks, `${at}.hooks`);
      else if ((entry.type === undefined || entry.type === 'command') && !HOOK_COMMAND_KEYS.some((k) => typeof entry[k] === 'string' && entry[k].trim())) errors.push(`${at} needs a non-empty "command", "bash" or "powershell"`);
      if ('timeoutSec' in entry && !(typeof entry.timeoutSec === 'number' && entry.timeoutSec > 0)) errors.push(`${at}.timeoutSec must be a positive number`);
    });
    for (const [event, list] of Object.entries(v.hooks)) {
      if (Array.isArray(list)) checkEntries(list, `hooks.${event}`);
      else errors.push(`hooks.${event} must be an array`);
    }
  }
  return { errors, value: v };
}

// Resolves ./ and a/../b segments so a spelled-out path compares equal to the package path.
function normalizeToken(token) {
  if (!/(^|\/)\.\.?(\/|$)/.test(token)) return token;
  const out = [];
  for (const seg of token.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** Normalised path-like tokens of every hook command, `--flag=value` values included; entries with a custom cwd are skipped unless `includeCwd`. */
function hookCommandTokens(hooksJson, includeCwd = false) {
  const tokens = new Set();
  if (!isObject(hooksJson) || !isObject(hooksJson.hooks)) return tokens;
  const collect = (list) => {
    for (const entry of list) {
      if (!isObject(entry) || (entry.cwd && !includeCwd)) continue;
      if (Array.isArray(entry.hooks)) collect(entry.hooks);
      for (const key of HOOK_COMMAND_KEYS) {
        if (typeof entry[key] !== 'string') continue;
        for (const raw of entry[key].split(/[\s;&|()<>]+/)) {
          const cleaned = raw.replace(/\\/g, '/').replace(/^["']+|["']+$/g, '');
          const eq = cleaned.indexOf('=');
          for (const candidate of eq >= 0 ? [cleaned, cleaned.slice(eq + 1).replace(/^["']+/, '')] : [cleaned]) {
            const token = normalizeToken(candidate.replace(/^\$\{?[A-Z_]*PLUGIN_ROOT\}?\//, '').replace(/^\.\//, ''));
            if (token) tokens.add(token);
          }
        }
      }
    }
  };
  for (const list of Object.values(hooksJson.hooks)) if (Array.isArray(list)) collect(list);
  return tokens;
}

/** Script paths under `scriptsDir` that hook commands run (entries with a custom cwd are skipped). */
export function hookScriptRefs(hooksJson, scriptsDir) {
  const prefix = `${scriptsDir}/`;
  return new Set([...hookCommandTokens(hooksJson)].filter((t) => t.startsWith(prefix) && t.length > prefix.length));
}

/** Warnings for hook script references that do not exist in the output (`existingPaths` is a Set). */
export function hookWarnings(hooksJson, scriptsDir, existingPaths) {
  return [...hookScriptRefs(hooksJson, scriptsDir)].filter((p) => !existingPaths.has(p)).map((p) => `references missing file ${p}`);
}

/** Script item paths that no hook runs. */
export function unreferencedScripts(scriptPaths, hooksJson, scriptsDir) {
  const refs = hookScriptRefs(hooksJson, scriptsDir);
  return scriptPaths.filter((p) => !refs.has(p));
}

/** Edits a base file in place, or adds it when missing. */
export function upsertBaseFile(baseFiles, path, bytes, mode = 0o100644) {
  const existing = baseFiles.find((f) => f.path === path);
  if (existing) {
    existing.bytes = bytes;
    return existing;
  }
  const file = { path, bytes, mode };
  baseFiles.push(file);
  return file;
}

/**
 * Copies name, description and version from the manifest into the marketplace entry for this plugin
 * (source "." or, failing that, the entry still carrying `originalName`). The marketplace's own metadata is left alone.
 * @returns {{map: Map, status: 'updated'|'unchanged'|'missing'|'invalid'|'no-entry', entry?: string}}
 */
export function syncMarketplace(finalMap, manifest, originalName) {
  const file = finalMap.get(MARKETPLACE_PATH);
  if (!file) return { map: finalMap, status: 'missing' };
  let text;
  let data;
  try {
    text = decodeUtf8(file.bytes);
    data = JSON.parse(text);
  } catch {
    return { map: finalMap, status: 'invalid' };
  }
  if (!isObject(data) || !Array.isArray(data.plugins)) return { map: finalMap, status: 'invalid' };
  let idx = data.plugins.findIndex((p) => isObject(p) && typeof p.source === 'string' && /^\.\/?$/.test(p.source));
  if (idx < 0) idx = data.plugins.findIndex((p) => isObject(p) && originalName && p.name === originalName);
  if (idx < 0) return { map: finalMap, status: 'no-entry' };
  const entry = data.plugins[idx];
  const props = {};
  for (const key of ['name', 'description', 'version']) {
    const v = manifest?.[key];
    if (typeof v === 'string' && entry[key] !== v) props[key] = v;
  }
  if (!Object.keys(props).length) return { map: finalMap, status: 'unchanged', entry: entry.name };
  const outText = setJsonStringProps(text, ['plugins', idx], props) ?? serializeJson({ ...data, plugins: data.plugins.map((p, i) => (i === idx ? { ...p, ...props } : p)) }, text);
  const map = new Map(finalMap);
  map.set(MARKETPLACE_PATH, { bytes: encodeUtf8(outText), mode: file.mode });
  return { map, status: 'updated', entry: props.name ?? entry.name };
}

// ---- Limits ----

// Control, invisible, bidi, variation-selector, filler, braille-blank and tag characters; one class shared by visible() and validateSymlink().
const INVISIBLE = '\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180e\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u206f\\u2800\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufffc\\u{1d159}\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e007f}\\u{e0100}-\\u{e01ef}';
const HIDDEN_CHARS = new RegExp(`[${INVISIBLE}]`, 'gu');

/** Escapes control, bidi and zero-width characters so hidden text cannot pass review; truncates to `max`. */
export function visible(text, max = 300) {
  const raw = String(text);
  const escaped = raw.slice(0, max).replace(HIDDEN_CHARS, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
  return raw.length > max ? `${escaped}…` : escaped;
}

export const isSymlinkMode = (mode) => (mode & 0o170000) === 0o120000;

// For measured sizes, where NaN or a negative value means the measurement is broken.
const invalidSize = (n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0;

/** @param {string|number} mode git mode as octal string (tree entry) or number (loaded file) */
export function fileSizeProblem(path, mode, size, limits = LIMITS) {
  if (invalidSize(size)) return `${visible(path)} has an invalid size.`;
  const octalMode = typeof mode === 'string' ? Number.parseInt(mode, 8) : mode;
  if (isSymlinkMode(octalMode)) {
    return size > limits.maxSymlinkBytes ? `Symlink ${visible(path)} has a target of ${size} bytes; the limit is ${limits.maxSymlinkBytes}.` : null;
  }
  return size > limits.maxFileBytes ? `${visible(path)} is ${formatMiB(size)}; the per-file limit is ${formatMiB(limits.maxFileBytes)}.` : null;
}

export function totalSizeProblem(total, limits = LIMITS) {
  return total > limits.maxTotalBytes ? `Repository is ${formatMiB(total)}; the limit is ${formatMiB(limits.maxTotalBytes)} in total.` : null;
}

const knownSize = (e) => Number.isSafeInteger(e.size) && e.size >= 0;

/** Checks blob tree entries against their declared sizes; entries without a usable size are caught after the fetch. */
export function treeLimitProblem(entries, limits = LIMITS) {
  if (entries.length > limits.maxFiles) return `Repository has ${entries.length} files; the limit is ${limits.maxFiles}.`;
  let declared = 0;
  for (const e of entries) {
    if (!knownSize(e)) continue;
    const problem = fileSizeProblem(e.path, e.mode, e.size, limits);
    if (problem) return problem;
    declared += e.size;
  }
  return totalSizeProblem(declared, limits);
}

export function uploadSizeProblem(sizes, limits = LIMITS) {
  if (sizes.length > limits.maxUploadFiles) return `Too many files (${sizes.length}); the limit is ${limits.maxUploadFiles} per upload.`;
  if (sizes.some(invalidSize)) return 'A selected file has an invalid size.';
  if (sizes.some((s) => s > limits.maxUploadBytes)) return 'file is larger than 1 MB';
  const total = sizes.reduce((a, b) => a + b, 0);
  return total > limits.maxUploadTotalBytes ? `The selected files total ${formatMiB(total)}; the limit is ${formatMiB(limits.maxUploadTotalBytes)} per upload.` : null;
}

/** @param {Map<string,{bytes:{length:number}}>} finalMap */
export function packageProblem(finalMap, limits = LIMITS) {
  if (finalMap.size > limits.maxFiles) return `The package has ${finalMap.size} files; the limit is ${limits.maxFiles}.`;
  let total = 0;
  for (const f of finalMap.values()) {
    if (invalidSize(f.bytes.length)) return 'The package contains a file with an invalid size.';
    total += f.bytes.length;
  }
  return total > limits.maxTotalBytes ? `The package is ${formatMiB(total)}; the limit is ${formatMiB(limits.maxTotalBytes)}.` : null;
}

// ---- Symlinks ----

const UNSAFE_TARGET = new RegExp(`[${INVISIBLE}\\\\:]`, 'u');
// Windows drops trailing spaces and dots and resolves 8.3 short names such as GIT~1.
const WINDOWS_ALIAS = /[ .]$|~\d/;

/**
 * Allows only ../ steps followed by plain names inside the package. With `..` leading only and no link through
 * another link, lexical resolution equals real resolution.
 * @returns {{resolved:string}|{error:string}}
 */
export function validateSymlink(path, targetText) {
  const bad = (error) => ({ error });
  if (!isSafePath(path)) return bad('invalid symlink path');
  if (typeof targetText !== 'string' || !targetText) return bad('empty target');
  if (targetText.length > LIMITS.maxSymlinkBytes) return bad('target is too long');
  if (UNSAFE_TARGET.test(targetText)) return bad('target has control, invisible, backslash or colon characters');
  if (targetText.startsWith('/')) return bad('target is an absolute path');
  const parts = targetText.replace(/^\.\//, '').replace(/\/$/, '').split('/');
  let ups = 0;
  while (parts[ups] === '..') ups++;
  const rest = parts.slice(ups);
  if (!rest.length || rest.some((s) => !s || s === '.' || s === '..' || s.toLowerCase() === '.git')) return bad('target must be ../ steps followed by plain names (no .git)');
  if (rest.some((s) => WINDOWS_ALIAS.test(s))) return bad('target names must not end in a space or dot or contain ~ and a digit');
  const base = path.split('/').slice(0, -1);
  if (ups > base.length) return bad('target points outside the package');
  const resolved = [...base.slice(0, base.length - ups), ...rest].join('/');
  if (!isSafePath(resolved)) return bad('resolved target is not a valid path');
  if (resolved === path) return bad('target points at the symlink itself');
  if (path.startsWith(`${resolved}/`)) return bad('target points at a directory that contains the symlink');
  return { resolved };
}

/**
 * @param {Iterable<{path:string,bytes:Uint8Array,mode:number}>|Map<string,{bytes:Uint8Array,mode:number}>} files
 * @returns {{valid:{path:string,target:string,resolved:string}[], rejected:{path:string,target:string,reason:string}[]}}
 */
export function checkSymlinks(files) {
  const list = files instanceof Map ? [...files].map(([path, f]) => ({ path, bytes: f.bytes, mode: f.mode })) : [...files];
  const candidates = [];
  const rejected = [];
  for (const f of list) {
    if (!isSymlinkMode(f.mode)) continue;
    let target;
    try {
      target = decodeUtf8(f.bytes);
    } catch {
      rejected.push({ path: f.path, target: '', reason: 'target is not valid UTF-8' });
      continue;
    }
    const result = validateSymlink(f.path, target);
    if (result.error) rejected.push({ path: f.path, target, reason: result.error });
    else candidates.push({ path: f.path, target, resolved: result.resolved });
  }
  const linkPaths = candidates.map((c) => c.path);
  const throughLink = (c) => linkPaths.some((p) => p !== c.path && (c.resolved === p || c.resolved.startsWith(`${p}/`)));
  const valid = [];
  for (const c of candidates) {
    if (throughLink(c)) rejected.push({ path: c.path, target: c.target, reason: 'target points through another symlink' });
    else valid.push(c);
  }
  return { valid, rejected };
}

/** Throws on an unsafe path; drops invalid symlinks and reports them in `skipped`. */
export function admitLoadedFiles(files) {
  if (!files.every((f) => isSafePath(f.path))) throw new Error('Repository contains unsupported file paths');
  const { rejected } = checkSymlinks(files);
  const dropped = new Set(rejected.map((r) => r.path));
  return { files: files.filter((f) => !dropped.has(f.path)), skipped: rejected };
}

// ---- Executable content review ----

const HOOK_FILE_RE = /^(\.github\/)?hooks\/[^/]+\.json$/;
// ${input:x}, ${env:x} and bare ${NAME}, except the plain path variables.
const SECRET_REF_RE = /\$\{(?:input:|env:|(?!(?:workspaceFolder|CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|userHome|cwd)[}:])[A-Za-z_]\w*(?::-[^}]*)?\})/;
const MCP_SERVER_KEYS = ['mcpServers', 'servers'];

function readJsonFile(finalMap, path) {
  const file = finalMap.get(path);
  if (!file) return null;
  try {
    const value = JSON.parse(decodeUtf8(file.bytes));
    return isObject(value) ? { value } : { error: 'top level is not a JSON object' };
  } catch {
    return { error: 'not valid UTF-8 JSON' };
  }
}

function collectHooks(events, file, out) {
  const walk = (list, event) => {
    for (const entry of list) {
      if (!isObject(entry)) continue;
      if (Array.isArray(entry.hooks)) walk(entry.hooks, event);
      if (entry.type === 'prompt') continue;
      for (const field of HOOK_COMMAND_KEYS) {
        if (typeof entry[field] === 'string' && entry[field].trim()) out.push({ file, event, field, command: entry[field], cwd: typeof entry.cwd === 'string' ? entry.cwd : '' });
      }
    }
  };
  for (const [event, list] of Object.entries(events)) if (Array.isArray(list)) walk(list, event);
}

const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const asList = (v) => (Array.isArray(v) ? v.map(asText) : v == null ? [] : [asText(v)]);
const asPairs = (v, sep) => (isObject(v) ? Object.entries(v).map(([k, x]) => `${k}${sep}${asText(x)}`) : asList(v));

function collectMcp(servers, file, key, acc) {
  const origin = `${file} (${key})`;
  for (const [name, s] of Object.entries(servers)) {
    if (!isObject(s)) continue;
    const urls = [s.url, s.httpUrl, s.serverUrl].filter((u) => u != null).map(asText);
    const row = {
      files: [file],
      origins: [origin],
      name,
      type: asText(s.type),
      command: asText(s.command),
      args: asList(s.args),
      url: urls.join(' '),
      cwd: asText(s.cwd),
      envFile: asText(s.envFile),
      headers: asPairs(s.headers, ': '),
      env: asPairs(s.env, '='),
      usesSecrets: SECRET_REF_RE.test(JSON.stringify([s.command, s.args, urls, s.cwd, s.envFile, s.headers, s.env])),
    };
    // Any difference in the server object, such as an env value, makes a separate row.
    const dedupeKey = JSON.stringify([name, s]);
    const seen = acc.get(dedupeKey);
    if (!seen) acc.set(dedupeKey, row);
    else {
      if (!seen.files.includes(file)) seen.files.push(file);
      if (!seen.origins.includes(origin)) seen.origins.push(origin);
    }
  }
}

/** Everything in the package that runs code or contacts servers when the plugin is used. */
export function executableInventory(finalMap) {
  const paths = new Set();
  const unreadable = [];
  const hooks = [];
  const mcp = new Map();

  let manifest = {};
  const manifestRead = readJsonFile(finalMap, 'plugin.json');
  if (manifestRead?.value) manifest = manifestRead.value;
  const cfg = resolveConfigPaths(manifest);
  const dirs = resolveDirs(manifest);

  // Scripts under scripts/ and any other file in the package that a hook command names.
  const addHookFiles = (hooksJson) => {
    for (const ref of hookScriptRefs(hooksJson, dirs.scripts)) paths.add(ref);
    for (const token of hookCommandTokens(hooksJson, true)) if (finalMap.has(token)) paths.add(token);
  };

  const hookFiles = new Set([cfg.hooks, 'hooks/hooks.json']);
  for (const p of finalMap.keys()) if (HOOK_FILE_RE.test(p)) hookFiles.add(p);
  for (const file of hookFiles) {
    const read = readJsonFile(finalMap, file);
    if (!read) continue;
    paths.add(file);
    if (read.error) unreadable.push({ file, reason: read.error });
    else if (isObject(read.value.hooks)) {
      collectHooks(read.value.hooks, file, hooks);
      addHookFiles(read.value);
    }
  }
  for (const p of finalMap.keys()) if (p.startsWith(`${dirs.scripts}/`)) paths.add(p);

  for (const file of new Set([cfg.mcp, cfg.vscodeMcp, '.mcp.json'])) {
    const read = readJsonFile(finalMap, file);
    if (!read) continue;
    paths.add(file);
    if (read.error) unreadable.push({ file, reason: read.error });
    else for (const key of MCP_SERVER_KEYS) if (isObject(read.value[key])) collectMcp(read.value[key], file, key, mcp);
  }

  const before = hooks.length + mcp.size;
  if (isObject(manifest.hooks)) {
    const inline = isObject(manifest.hooks.hooks) ? manifest.hooks.hooks : manifest.hooks;
    collectHooks(inline, 'plugin.json', hooks);
    addHookFiles({ hooks: inline });
  }
  if (isObject(manifest.mcpServers)) collectMcp(manifest.mcpServers, 'plugin.json', 'mcpServers', mcp);
  if (hooks.length + mcp.size > before) paths.add('plugin.json');

  const executables = [];
  for (const [path, f] of finalMap) {
    if (isSymlinkMode(f.mode)) continue;
    const reason = f.mode & 0o111 ? 'mode' : (f.bytes[0] === 0x23 && f.bytes[1] === 0x21 ? 'shebang' : null);
    if (reason) {
      executables.push({ path, reason });
      paths.add(path);
    }
  }

  const { valid, rejected } = checkSymlinks(finalMap);
  for (const r of rejected) unreadable.push({ file: r.path, reason: `symlink ${r.reason}` });
  for (const p of [...valid, ...rejected]) paths.add(p.path);

  return { hooks, mcp: [...mcp.values()], executables, symlinks: valid, unreadable, paths };
}

// Review rows escape hidden characters but never truncate: padding must not push a command out of view.
const showAll = (text) => visible(text, Infinity);

const REVIEW_ROWS = {
  hook: (h) => `${showAll(h.event)} · ${h.field}: ${showAll(h.command)}${h.cwd ? ` (cwd ${showAll(h.cwd)})` : ''} · ${showAll(h.file)}`,
  mcp: (s) => {
    const list = (label, items) => (items.length ? `${label} ${items.map(showAll).join(', ')}` : '');
    return [
      showAll(s.name),
      s.type ? `type ${showAll(s.type)}` : '',
      s.command || s.args.length ? `command ${showAll([s.command, ...s.args].join(' '))}` : '',
      s.url ? `url ${showAll(s.url)}` : '',
      s.cwd ? `cwd ${showAll(s.cwd)}` : '',
      s.envFile ? `envFile ${showAll(s.envFile)}` : '',
      list('headers', s.headers),
      list('env', s.env),
      s.usesSecrets ? 'references input or environment values' : '',
      s.origins.map(showAll).join(', '),
    ].filter(Boolean).join(' · ');
  },
  executable: (x) => `${showAll(x.path)} (${x.reason === 'mode' ? 'executable bit' : 'shebang line'})`,
  symlink: (s) => `${showAll(s.path)} → ${showAll(s.target)}`,
  skippedLink: (s) => `Skipped symlink ${showAll(s.path)} → ${showAll(s.target)}: ${s.reason}.`,
  unreadable: (u) => `${showAll(u.file)}: ${u.reason}`,
};

/** Full text of one review row; `kind` is hook, mcp, executable, symlink, skippedLink or unreadable. */
export const reviewRowText = (kind, row) => REVIEW_ROWS[kind](row);

/** Ack for every untrusted source; typed confirmation only when the commit adds or changes inventory paths. */
export function outputGate({ trusted, inventory, changes = [] }) {
  const execChanges = changes.filter((c) => c.status !== 'delete' && inventory.paths.has(c.path));
  return { ack: !trusted, typed: !trusted && execChanges.length > 0, execChanges };
}

/** Button and row state for the output gate; the only place that decides what is blocked. */
export function gateState({ gate, acked, busy, hasPlan, typedOk }) {
  const blocked = gate.ack && !acked;
  return {
    blocked,
    ackVisible: gate.ack,
    confirmVisible: gate.typed,
    downloadDisabled: blocked,
    previewDisabled: blocked || busy,
    publishDisabled: !hasPlan || blocked || busy || (gate.typed && !typedOk),
  };
}
