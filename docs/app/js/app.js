import { buildZip } from './zip.js';
import {
  CATEGORY_DEFS, LIMITS, admitLoadedFiles, applyPluginMeta, buildModel, categoryDef, createItemFromUpload, createItemFromUploadFiles,
  decodeUtf8, displayName, encodeUtf8, executableInventory, finalFiles, gateState, hookWarnings, isSymlinkMode, itemWarnings, mainFile, mergeUpload,
  mirrorMcpJson, outputGate, packageProblem, resolveConfigPaths, restoreEol, reviewRowText, syncMarketplace, unreferencedScripts, uploadSizeProblem, upsertBaseFile,
  usesCrlf, validateHooksJson, validateMcpJson, validatePluginMeta, visible, classifyPath,
} from './model.js';
import { defaultBranch, detectSource, inspectTarget, isTrustedLoad, isValidBranch, loadRepo, normalizeRef, parseRepoRef, planChanges, publish, verifyToken } from './github.js';

const $ = (id) => document.getElementById(id);
const CONFIG_TAB = 'config';
const link = detectSource(location);
const state = {
  baseFiles: [], items: [], dirs: {}, manifest: {}, activeTab: CATEGORY_DEFS[0].key,
  configEdited: new Set(), originalName: '', loadedCount: 0,
  token: null, user: null, inspection: null, plan: null, source: { repo: link.repo, branch: link.branch },
  sourceTrusted: false, inventory: null, skippedLinks: [],
};

let sessionCtl = new AbortController(); // all authenticated work while signed in
let signInCtl = null; // the token check in the sign-in dialog
const endSession = () => {
  sessionCtl.abort();
  sessionCtl = new AbortController();
};
let busy = false;
let planGen = 0; // bumped by invalidatePlan(); a Preview that started before the bump must not publish its plan
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

function say(text, kind = 'ok', box = 'messages') {
  $(box).replaceChildren(el('p', { class: kind }, text));
}
function sayMany(list) {
  $('messages').replaceChildren(...list.map(({ text, kind }) => el('p', { class: kind }, text)));
}
const errText = (e) => (e && e.message ? e.message : String(e));

// Skipped-symlink warnings belong to the loaded source, so they outlive sign-in and sign-out messages.
function sayInSource(text, kind = 'ok') {
  $('source-messages').replaceChildren(el('p', { class: kind }, text), ...state.skippedLinks.map((s) => el('p', { class: 'warn' }, skippedLinkText(s))));
}
function updateNewRepoLink() {
  const name = $('tgt-repo').value.trim().split('/').pop();
  $('new-repo-link').href = `https://github.com/new${name ? `?name=${encodeURIComponent(name)}` : ''}`;
}

function invalidatePlan() {
  planGen++;
  state.plan = null;
  $('plan').hidden = true;
  $('confirm-name').value = '';
  updateNewRepoLink();
  renderGate();
}

function currentGate() {
  return outputGate({ trusted: state.sourceTrusted, inventory: state.inventory ?? { paths: new Set() }, changes: state.plan ?? [] });
}

function confirmMatches() {
  const target = state.inspection?.target;
  return Boolean(target) && normalizeRef($('confirm-name').value) === normalizeRef(`${target.owner}/${target.repo}`);
}

const gateView = () => gateState({
  gate: currentGate(), acked: $('ack-exec').checked, busy, hasPlan: Boolean(state.plan?.length), typedOk: confirmMatches(),
});
const isBlocked = () => gateView().blocked;

// The only place that sets the state of the download, preview and publish buttons.
function renderGate() {
  const view = gateView();
  const target = state.inspection?.target;
  $('ack-row').hidden = !view.ackVisible;
  $('download-btn').disabled = view.downloadDisabled;
  $('preview-btn').disabled = view.previewDisabled;
  $('confirm-row').hidden = !view.confirmVisible;
  $('confirm-target').textContent = target ? `${target.owner}/${target.repo}` : '';
  $('publish-btn').disabled = view.publishDisabled;
}

const ACK_REFUSAL = 'Tick the review confirmation under Output first.';

// Re-checks the gate when the handler runs, so a re-enabled button cannot bypass it.
const guarded = (fn, box) => (ev) => {
  if (isBlocked()) {
    ev.preventDefault();
    say(ACK_REFUSAL, 'error', box);
    return undefined;
  }
  return fn(ev);
};

function activeItems() {
  return state.items.filter((i) => i.cat === state.activeTab);
}

function renderTabs() {
  const tab = (key, label, count) => el('button', {
    type: 'button', role: 'tab', 'aria-selected': String(key === state.activeTab),
    on: { click: () => {
      if (key === CONFIG_TAB && state.activeTab !== CONFIG_TAB) fillMetaForm();
      state.activeTab = key;
      render();
    } },
  }, label, count == null ? null : el('span', { class: 'badge' }, String(count)));
  $('tabs').replaceChildren(
    ...CATEGORY_DEFS.map((def) => tab(def.key, def.label, state.items.filter((i) => i.cat === def.key && !i.removed).length)),
    tab(CONFIG_TAB, 'Config'),
  );
}

function renderDropzone() {
  const def = categoryDef(state.activeTab);
  const dir = state.dirs[def.key];
  $('dz-title').textContent = `Add ${def.label.toLowerCase()}`;
  $('upload-files-btn').textContent = def.anyFile ? 'Choose files' : 'Choose .md files';
  $('file-input').accept = def.anyFile ? '' : '.md,text/markdown';
  $('upload-folder-btn').textContent = 'Choose skill folder';
  $('upload-folder-btn').hidden = def.kind !== 'dir';
  if (def.anyFile) $('dz-hint').textContent = `Upload files (up to 1 MB each). They are saved as ${dir}/<name> and marked executable.`;
  else if (def.kind === 'dir') $('dz-hint').textContent = `Upload a skill folder or a SKILL.md file. The folder name or the frontmatter name becomes the item under ${dir}/.`;
  else $('dz-hint').textContent = `Upload .md files. They are saved as ${dir}/<name>${def.suffix}.`;
}

function parseJsonFile(path) {
  const file = state.baseFiles.find((f) => f.path === path);
  if (!file) return null;
  try {
    return JSON.parse(decodeUtf8(file.bytes));
  } catch {
    return null;
  }
}

function renderItems() {
  const items = activeItems().sort((a, b) => (a.name < b.name ? -1 : 1));
  $('empty-msg').hidden = items.length > 0;
  const hooks = state.activeTab === 'scripts' ? parseJsonFile(resolveConfigPaths(state.manifest).hooks) : null;
  const unreferenced = new Set(hooks ? unreferencedScripts(items.flatMap((i) => (i.removed ? [] : i.files.map((f) => f.path))), hooks, state.dirs.scripts) : []);
  $('item-list').replaceChildren(
    ...items.map((item) => {
      const main = mainFile(item, state.dirs);
      const isLink = Boolean(main && isSymlinkMode(main.mode));
      let editable = false;
      if (main && !isLink) {
        try { decodeUtf8(main.bytes); editable = true; } catch { editable = false; }
      }
      const tags = [];
      if (isLink) tags.push(el('span', { class: 'tag warn' }, 'symlink'));
      if (item.origin === 'upload') tags.push(el('span', { class: 'tag new' }, 'new'));
      else if (item.edited) tags.push(el('span', { class: 'tag edited' }, 'edited'));
      if (item.removed) tags.push(el('span', { class: 'tag' }, 'removed'));
      for (const w of itemWarnings(item, state.dirs)) tags.push(el('span', { class: 'tag warn' }, w));
      if (!item.removed && main && unreferenced.has(main.path)) tags.push(el('span', { class: 'tag warn' }, 'not referenced by any hook'));

      const prefix = `${state.dirs[item.cat]}/${item.name}/`;
      const details = item.cat === 'skills' && item.files.length > 0
        ? el('details', { class: 'item-details' },
            el('summary', {}, `Files (${item.files.length})`),
            el('ul', { class: 'file-list' }, ...item.files.map((f) => el('li', {}, f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path))),
          )
        : null;

      const actions = el('div', { class: 'actions' });
      if (!item.removed) {
        actions.append(el('button', { type: 'button', ...(editable ? {} : { disabled: '' }), on: { click: () => openEditor(item) } }, 'Edit'));
      }
      actions.append(
        item.removed
          ? el('button', { type: 'button', on: { click: () => { item.removed = false; changed(); } } }, 'Undo')
          : el('button', { type: 'button', class: 'danger', on: { click: () => removeItem(item) } }, 'Remove'),
      );

      return el('li', { class: item.removed ? 'removed' : '' },
        el('div', { class: 'item-body' },
          el('div', { class: 'item-header' }, el('span', { class: 'name' }, displayName(item, state.dirs)), ...tags),
          details,
        ),
        actions,
      );
    }),
  );
}

// Final package files, with the plugin settings mirrored into marketplace.json.
function buildOutput() {
  return syncMarketplace(finalFiles(state.baseFiles, state.items), state.manifest, state.originalName);
}

function renderSummary(out) {
  const live = state.items.filter((i) => !i.removed);
  const added = live.filter((i) => i.origin === 'upload').length;
  const edited = live.filter((i) => i.origin === 'repo' && i.edited).length;
  const removed = state.items.filter((i) => i.removed).length;
  const config = state.configEdited.size + (out.status === 'updated' ? 1 : 0);
  const links = state.inventory.symlinks.length;
  $('summary').textContent = `${out.map.size} files in package · ${added} added · ${edited} edited · ${removed} removed · ${config} config file(s) changed${links ? ` · ${links} symlink(s)` : ''}`;
}

const reviewGroup = (title, lines) => (lines.length
  ? el('div', {}, el('h4', {}, `${title} (${lines.length})`), el('ul', {}, ...lines.map((text) => el('li', {}, text))))
  : null);

const skippedLinkText = (s) => reviewRowText('skippedLink', s);

function renderReview() {
  const { hooks, mcp, executables, symlinks, unreadable } = state.inventory;
  const repoLabel = `${state.source.repo}@${visible(state.source.branch)}`;
  const rows = (kind, list) => list.map((row) => reviewRowText(kind, row));
  const groups = [
    reviewGroup('Hook commands', rows('hook', hooks)),
    reviewGroup('MCP servers', rows('mcp', mcp)),
    reviewGroup('Executable files', rows('executable', executables)),
    reviewGroup('Symlinks', rows('symlink', symlinks)),
  ];
  $('review-list').replaceChildren(...groups.filter(Boolean));
  $('review-empty').hidden = groups.some(Boolean);
  $('review-warnings').replaceChildren(
    ...state.skippedLinks.map((s) => el('li', {}, skippedLinkText(s))),
    ...rows('unreadable', unreadable).map((text) => el('li', {}, text)),
  );
  const notice = $('review-notice');
  notice.hidden = state.sourceTrusted;
  notice.textContent = state.sourceTrusted ? '' : `This package comes from ${repoLabel}, which is not a trusted source for this site. Hooks, MCP servers and scripts listed below run code or contact servers when the plugin is used. Read them before you continue.`;
  $('ack-text').textContent = `I have reviewed the items above and I trust ${state.source.repo}.`;
}

function renderOutput() {
  const out = buildOutput();
  state.inventory = executableInventory(out.map);
  renderSummary(out);
  renderReview();
  renderGate();
}

function render() {
  const isConfig = state.activeTab === CONFIG_TAB;
  $('items-panel').hidden = isConfig;
  $('config-panel').hidden = !isConfig;
  renderTabs();
  if (isConfig) {
    renderConfig();
  } else {
    renderDropzone();
    renderItems();
  }
  renderOutput();
}

function changed() {
  invalidatePlan();
  $('download-messages').replaceChildren();
  render();
}

function removeItem(item) {
  if (item.origin === 'upload') state.items = state.items.filter((i) => i !== item);
  else item.removed = true;
  changed();
}

function groupUploadFiles(fileList) {
  const groups = new Map();
  for (const file of fileList) {
    const rel = file.webkitRelativePath || '';
    const key = rel && rel.includes('/') ? rel.split('/')[0] : (file.name || 'upload');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  return [...groups.values()];
}

// Adds the upload to the item list; an upload over a repo item counts as an edit of it.
function mergeIncoming(incoming) {
  const existing = state.items.find((i) => i.id === incoming.id);
  const result = mergeUpload(state.items, incoming);
  if (existing && existing.origin === 'repo') {
    incoming.origin = 'repo';
    incoming.edited = true;
  }
  return result;
}

async function handleFiles(fileList) {
  if (state.activeTab === CONFIG_TAB) return;
  const def = categoryDef(state.activeTab);
  const sizeProblem = uploadSizeProblem(fileList.map((f) => f.size));
  if (sizeProblem) {
    sayMany([{ text: sizeProblem, kind: 'error' }]);
    return;
  }
  const groups = groupUploadFiles(fileList);
  const msgs = [];

  for (const group of groups) {
    const file = group[0];
    const label = group.length > 1 ? (file.webkitRelativePath || file.name).split('/')[0] : file.name;
    const isFolderUpload = Boolean(file.webkitRelativePath && file.webkitRelativePath.includes('/'));

    try {
      if (!isFolderUpload) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const incoming = createItemFromUpload(def, state.dirs, file.name, bytes);
        const result = mergeIncoming(incoming);
        msgs.push({ text: `${file.name}: ${result === 'added' ? 'added' : 'replaced existing'} ${def.label.toLowerCase().replace(/s$/, '')} "${incoming.name}"`, kind: 'ok' });
        continue;
      }

      const loaded = await Promise.all(group.map(async (entry) => ({
        name: entry.name,
        path: entry.webkitRelativePath,
        bytes: new Uint8Array(await entry.arrayBuffer()),
      })));
      const incoming = createItemFromUploadFiles(def, state.dirs, loaded);
      const result = mergeIncoming(incoming);
      msgs.push({ text: `${label}: ${result === 'added' ? 'added' : 'replaced existing'} ${def.label.toLowerCase().replace(/s$/, '')} "${incoming.name}"`, kind: 'ok' });
    } catch (e) {
      msgs.push({ text: `${label}: ${errText(e)}`, kind: 'error' });
    }
  }
  changed();
  sayMany(msgs);
}

// Dialog state: validate(text) returns error strings, commit(text) applies the edit.
let editing = null;
let editingCrlf = false;
function showEditor(spec) {
  editing = spec;
  editingCrlf = usesCrlf(spec.text);
  $('edit-title').textContent = spec.title;
  $('edit-text').value = spec.text;
  $('edit-error').replaceChildren();
  $('edit-dialog').showModal();
}

function openEditor(item) {
  const main = mainFile(item, state.dirs);
  if (!main) return;
  showEditor({
    title: main.path,
    text: decodeUtf8(main.bytes),
    validate: (text) => (encodeUtf8(text).length === 0 ? ['Content cannot be empty.'] : []),
    commit: (text) => {
      if (text === decodeUtf8(main.bytes)) return;
      main.bytes = encodeUtf8(text);
      item.edited = true;
    },
  });
}

function applyEdit(ev) {
  ev.preventDefault();
  if (!editing) return;
  const text = $('edit-text').value;
  const errors = editing.validate(text);
  if (errors.length) {
    $('edit-error').replaceChildren(...errors.map((e) => el('p', { class: 'error' }, e)));
    return;
  }
  editing.commit(restoreEol(text, editingCrlf));
  $('edit-dialog').close();
  changed();
}

const CONFIG_TEMPLATES = { mcp: '{\n  "mcpServers": {}\n}\n', hooks: '{\n  "version": 1,\n  "hooks": {}\n}\n' };

// undefined when the file does not exist, null when it is not valid UTF-8.
function baseText(path) {
  const file = state.baseFiles.find((f) => f.path === path);
  if (!file) return undefined;
  try {
    return decodeUtf8(file.bytes);
  } catch {
    return null;
  }
}

function markConfigEdited(...paths) {
  for (const p of paths) state.configEdited.add(p);
}

function editMcp() {
  const { mcp, vscodeMcp } = resolveConfigPaths(state.manifest);
  const text = baseText(mcp);
  if (text === null) return;
  showEditor({
    title: `${mcp} (also regenerates ${vscodeMcp})`,
    text: text ?? CONFIG_TEMPLATES.mcp,
    validate: (t) => validateMcpJson(t).errors,
    commit: (t) => {
      if (t === baseText(mcp)) return;
      upsertBaseFile(state.baseFiles, mcp, encodeUtf8(t));
      upsertBaseFile(state.baseFiles, vscodeMcp, encodeUtf8(mirrorMcpJson(t)));
      markConfigEdited(mcp, vscodeMcp);
    },
  });
}

function editHooks() {
  const { hooks } = resolveConfigPaths(state.manifest);
  const text = baseText(hooks);
  if (text === null) return;
  showEditor({
    title: hooks,
    text: text ?? CONFIG_TEMPLATES.hooks,
    validate: (t) => validateHooksJson(t).errors,
    commit: (t) => {
      if (t === baseText(hooks)) return;
      upsertBaseFile(state.baseFiles, hooks, encodeUtf8(t));
      markConfigEdited(hooks);
    },
  });
}

function editedTag(path) {
  return state.configEdited.has(path) ? el('span', { class: 'tag edited' }, 'edited') : null;
}

function renderMarketplaceStatus() {
  const invalid = buildOutput().status === 'invalid';
  const note = $('meta-market');
  note.hidden = !invalid;
  note.className = invalid ? 'hint warn' : 'hint';
  const text = invalid ? 'marketplace.json is not a valid marketplace file, so it will not be updated.' : '';
  if (note.textContent !== text) note.textContent = text;
}

const META_FIELDS = ['name', 'description', 'version'];
const savedMeta = (key) => (typeof state.manifest[key] === 'string' ? state.manifest[key] : '');

function updateMetaDirty() {
  $('meta-dirty').hidden = !META_FIELDS.some((k) => $(`meta-${k}`).value.trim() !== savedMeta(k));
}

// Only called when entering the Config tab, after loading and after saving, so unsaved input survives re-renders.
function fillMetaForm() {
  for (const k of META_FIELDS) $(`meta-${k}`).value = savedMeta(k);
  $('meta-messages').replaceChildren();
  updateMetaDirty();
}

function renderConfig() {
  const paths = resolveConfigPaths(state.manifest);
  const usable = parseJsonFile('plugin.json') !== null;
  for (const id of ['meta-name', 'meta-description', 'meta-version', 'meta-save']) $(id).disabled = !usable;
  $('meta-note').textContent = usable ? '' : 'plugin.json is missing or is not valid JSON, so its metadata cannot be edited here.';
  renderMarketplaceStatus();

  const fileState = (path, tagsId, buttonId, pathId, hintId, manifestKey) => {
    const text = baseText(path);
    $(hintId).hidden = !(text === undefined && state.manifest[manifestKey] == null);
    $(pathId).textContent = path;
    $(tagsId).replaceChildren(...[text === undefined ? el('span', { class: 'tag' }, 'not in repository') : null, editedTag(path), text === null ? el('span', { class: 'tag warn' }, 'not valid UTF-8') : null].filter(Boolean));
    $(buttonId).textContent = text === undefined ? 'Create' : 'Edit';
    $(buttonId).disabled = text === null;
    return text;
  };
  fileState(paths.mcp, 'mcp-tags', 'mcp-edit', 'mcp-path', 'mcp-hint', 'mcpServers');
  const hooksText = fileState(paths.hooks, 'hooks-tags', 'hooks-edit', 'hooks-path', 'hooks-hint', 'hooks');
  let warnings = [];
  if (typeof hooksText === 'string') {
    const parsed = validateHooksJson(hooksText);
    warnings = parsed.errors.length
      ? parsed.errors.map((e) => `invalid: ${e}`)
      : hookWarnings(parsed.value, state.dirs.scripts, new Set(finalFiles(state.baseFiles, state.items).keys()));
  }
  $('hooks-warnings').replaceChildren(...warnings.map((w) => el('li', {}, w)));
}

function saveMeta(ev) {
  ev.preventDefault();
  const fields = { name: $('meta-name').value.trim(), description: $('meta-description').value.trim(), version: $('meta-version').value.trim() };
  const errors = validatePluginMeta(fields, state.manifest);
  if (errors.length) {
    $('meta-messages').replaceChildren(...errors.map((e) => el('p', { class: 'error' }, e)));
    return;
  }
  const file = state.baseFiles.find((f) => f.path === 'plugin.json');
  const before = decodeUtf8(file.bytes);
  let after;
  try {
    after = applyPluginMeta(before, fields);
  } catch (e) {
    say(errText(e), 'error', 'meta-messages');
    return;
  }
  const changedFile = after !== before;
  if (changedFile) {
    file.bytes = encodeUtf8(after);
    markConfigEdited('plugin.json');
  }
  Object.assign(state.manifest, fields);
  updatePluginHeader();
  fillMetaForm();
  changed();
  if (changedFile) say('Metadata saved.', 'ok', 'meta-messages');
  else say('No changes to save.', 'ok', 'meta-messages');
}

function updatePluginHeader() {
  $('plugin-meta').textContent = `${state.manifest.name || 'plugin'} ${state.manifest.version || ''} · ${state.loadedCount} files loaded`;
}

async function loadSource(ev) {
  ev.preventDefault();
  const progress = $('load-progress');
  const token = state.token;
  const signal = token ? sessionCtl.signal : undefined;
  const cancelled = () => Boolean(token) && (signal.aborted || state.token !== token);
  $('load-btn').disabled = true;
  progress.hidden = false;
  progress.removeAttribute('value');
  try {
    const { owner, repo } = parseRepoRef($('src-repo').value);
    const typedBranch = $('src-branch').value.trim();
    if (typedBranch && !isValidBranch(typedBranch)) throw new Error('Invalid branch name');
    const repoDefault = await defaultBranch({ owner, repo }, token, { signal });
    const branch = typedBranch || repoDefault;
    $('src-branch').value = branch;
    const loaded = await loadRepo({ owner, repo, branch }, token, (done, total) => {
      progress.max = total;
      progress.value = done;
    }, { signal });
    if (cancelled()) return;
    const { files, skipped } = admitLoadedFiles(loaded);
    const model = buildModel(files);
    const repoName = `${owner}/${repo}`;
    Object.assign(state, {
      baseFiles: model.baseFiles, items: model.items, dirs: model.dirs, manifest: model.manifest,
      configEdited: new Set(), originalName: typeof model.manifest.name === 'string' ? model.manifest.name : '',
      loadedCount: files.length, source: { repo: repoName, branch },
      sourceTrusted: isTrustedLoad(repoName, branch, repoDefault, link.pagesRepo), skippedLinks: skipped,
    });
    $('ack-exec').checked = false;
    $('tgt-repo').value ||= repoName;
    syncTargetRepo();
    updateNewRepoLink();
    $('tgt-branch').value ||= branch;
    updatePluginHeader();
    for (const id of ['messages', 'meta-messages', 'edit-error', 'download-messages']) $(id).replaceChildren();
    state.inspection = null;
    fillMetaForm();
    $('editor').hidden = false;
    $('output').hidden = false;
    invalidatePlan();
    render();
    const notice = $('source-notice');
    notice.hidden = state.sourceTrusted;
    if (!state.sourceTrusted) notice.textContent = `${repoName}@${visible(branch)} is not a trusted source for this site. Hooks, MCP servers and scripts in it run code or contact servers when the plugin is used. Review them under Output before you download or publish.`;
    sayInSource(`Loaded ${repoName}@${visible(branch)}.`);
  } catch (e) {
    if (cancelled()) return;
    sayInSource(`Could not load repository: ${errText(e)}`, 'error');
  } finally {
    progress.hidden = true;
    $('load-btn').disabled = false;
  }
}

function packageName() {
  const n = String(state.manifest.name || 'plugin').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 64);
  return n || 'plugin';
}

function download() {
  try {
    const out = buildOutput().map;
    const problem = packageProblem(out);
    if (problem) throw new Error(problem);
    const root = packageName();
    const files = [...out].sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, f]) => ({ path, data: f.bytes, mode: f.mode }));
    const blob = new Blob([buildZip(files, new Date(), root)], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `${root}.zip` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    say(`Downloaded ${root}.zip (${files.length} files).`, 'ok', 'download-messages');
  } catch (e) {
    say(`Could not build package: ${errText(e)}`, 'error', 'download-messages');
  }
}

let targetFollowsAccount = true;

// Until the user edits it, the target repo is <signed-in user or source owner>/<source repo name>.
function syncTargetRepo() {
  if (!targetFollowsAccount) return;
  const [srcOwner, name] = state.source.repo.split('/');
  if (!name) return;
  $('tgt-repo').value = `${state.user || srcOwner}/${name}`;
  invalidatePlan();
}

function renderAuth() {
  const signedIn = Boolean(state.user);
  $('user-login').textContent = state.user || '';
  $('publish-account').textContent = signedIn ? `Publishing as ${state.user}.` : 'Not signed in. Use Sign in under Source to publish.';
  $('auth-out').hidden = signedIn;
  $('auth-in').hidden = !signedIn;
  $('signin-btn').hidden = signedIn;
  $('signout-btn').hidden = !signedIn;
  $('token-cancel').textContent = signedIn ? 'Close' : 'Cancel';
}

function openAuth() {
  $('auth-messages').replaceChildren();
  renderAuth();
  $('token-dialog').showModal();
}

async function signIn(ev) {
  ev.preventDefault();
  const token = $('token').value.trim();
  if (state.user || !token) return;
  signInCtl = new AbortController();
  const { signal } = signInCtl;
  $('signin-btn').disabled = true;
  try {
    const { login } = await verifyToken(token, { signal });
    if (signal.aborted) return;
    state.token = token;
    state.user = login;
    state.inspection = null;
    invalidatePlan();
    $('token').value = '';
    renderAuth();
    syncTargetRepo();
    $('token-dialog').close();
    sayInSource(`Signed in as ${login}.`);
  } catch (e) {
    if (signal.aborted) return;
    say(`Sign-in failed: ${errText(e)}`, 'error', 'auth-messages');
  } finally {
    $('signin-btn').disabled = false;
  }
}

function signOut() {
  endSession();
  state.token = null;
  state.user = null;
  state.inspection = null;
  invalidatePlan();
  renderAuth();
  syncTargetRepo();
  $('token-dialog').close();
  sayInSource('Signed out.');
}

function targetRef() {
  const { owner, repo } = parseRepoRef($('tgt-repo').value);
  const branch = $('tgt-branch').value.trim();
  if (!isValidBranch(branch)) throw new Error('Invalid branch name');
  return { owner, repo, branch };
}

async function previewChanges() {
  busy = true;
  renderGate();
  const token = state.token;
  const signal = sessionCtl.signal;
  try {
    if (!token) throw new Error('Sign in under Source first');
    const problem = packageProblem(buildOutput().map);
    if (problem) throw new Error(problem);
    const { login } = await verifyToken(token, { signal });
    if (state.token !== token) return;
    if (login !== state.user) {
      state.user = login;
      renderAuth();
      syncTargetRepo();
    }
    const target = targetRef();
    const gen = planGen; // inputs are read here; any later invalidatePlan() makes this result stale
    const inspection = await inspectTarget(target, target.branch, token, { signal });
    const finalMap = buildOutput().map;
    const changes = await planChanges(finalMap, inspection.remote, (p) => classifyPath(p, state.dirs) !== null);
    if (state.token !== token) return;
    if (gen !== planGen) {
      say('The target or the package changed while checking. Press Preview again.', 'warn', 'publish-messages');
      return;
    }
    $('publish-messages').replaceChildren();
    state.inspection = { ...inspection, target };
    state.plan = changes;
    const note = { existing: `branch ${visible(inspection.branch)} exists`, newBranch: `branch ${visible(inspection.branch)} will be created`, empty: 'repository is empty and will be initialised' }[inspection.kind] + ` · as ${login}`;
    const where = `${target.owner}/${target.repo}`;
    $('plan-summary').textContent = changes.length ? `${changes.length} change(s) to ${where} · ${note}` : `No changes to publish to ${where} · ${note}`;
    const execPaths = new Set(currentGate().execChanges.map((c) => c.path));
    $('plan-list').replaceChildren(...changes.map((c) => el('li', { class: c.status },
      `${{ add: '+', modify: '~', delete: '-' }[c.status]} ${visible(c.path)}`,
      execPaths.has(c.path) ? ' ' : null,
      execPaths.has(c.path) ? el('span', { class: 'tag warn' }, 'executable content') : null)));
    $('plan').hidden = false;
  } catch (e) {
    if (signal.aborted || state.token !== token) return;
    invalidatePlan();
    say(`Preview failed: ${errText(e)}`, 'error', 'publish-messages');
  } finally {
    busy = false;
    renderGate();
  }
}

async function doPublish(ev) {
  ev.preventDefault();
  if (!state.plan || !state.plan.length || !state.inspection || !state.token) return;
  if (currentGate().typed && !confirmMatches()) {
    say('Type the target repository name to confirm.', 'error', 'publish-messages');
    return;
  }
  const { target } = state.inspection;
  if (!window.confirm(`Commit ${state.plan.length} change(s) to ${target.owner}/${target.repo} (${state.inspection.branch})?`)) return;
  const progress = $('publish-progress');
  const token = state.token;
  const signal = sessionCtl.signal;
  busy = true;
  renderGate();
  progress.hidden = false;
  $('publish-messages').replaceChildren();
  try {
    const message = $('tgt-message').value.trim() || 'Update plugin content via Plugin Bundler';
    const result = await publish(target, token, state.inspection, state.plan, message, (t) => say(t, 'ok', 'publish-messages'), { signal });
    invalidatePlan();
    $('publish-messages').replaceChildren(el('p', { class: 'ok' }, 'Published. ', el('a', { href: result.url, target: '_blank', rel: 'noopener noreferrer' }, result.sha.slice(0, 7))));
  } catch (e) {
    if (signal.aborted) say('Publish cancelled because you signed out. Check the target branch before trying again.', 'error', 'publish-messages');
    else say(`Publish failed: ${errText(e)}`, 'error', 'publish-messages');
  } finally {
    progress.hidden = true;
    busy = false;
    renderGate();
  }
}

async function collectEntryFiles(entry, prefix, out) {
  if (entry.isFile) {
    if (out.length >= LIMITS.maxUploadFiles) throw new Error(`Too many files; the limit is ${LIMITS.maxUploadFiles} per upload.`);
    const file = await new Promise((res, rej) => entry.file(res, rej));
    Object.defineProperty(file, 'webkitRelativePath', { value: `${prefix}${entry.name}` });
    out.push(file);
    return;
  }
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const child of batch) await collectEntryFiles(child, `${prefix}${entry.name}/`, out);
  }
}

function wire() {
  $('src-repo').value = state.source.repo;
  $('src-branch').value = state.source.branch;
  const notice = $('source-notice');
  notice.hidden = !link.fromLink;
  if (link.fromLink) {
    notice.textContent = link.repo
      ? `A link filled in ${link.repo}${link.branch ? ` @ ${link.branch}` : ''} as the source. Nothing was loaded. Check that you trust this repository, because its hooks, MCP servers and scripts run code when the plugin is used. Press Load only if you do.`
      : 'A link tried to fill in a source repository, but its value is not a valid repository, so it was ignored. Nothing was loaded.';
  }
  $('source-form').addEventListener('submit', loadSource);
  $('source-auth-btn').addEventListener('click', openAuth);
  $('token-form').addEventListener('submit', signIn);
  $('token-cancel').addEventListener('click', () => {
    signInCtl?.abort();
    $('token-dialog').close();
  });
  $('token-dialog').addEventListener('close', () => {
    signInCtl?.abort();
    $('token').value = '';
  });
  $('signout-btn').addEventListener('click', signOut);
  $('upload-files-btn').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => { handleFiles([...e.target.files]); e.target.value = ''; });
  $('upload-folder-btn').addEventListener('click', () => $('folder-input').click());
  $('folder-input').addEventListener('change', (e) => { handleFiles([...e.target.files]); e.target.value = ''; });
  const dz = $('dropzone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (state.activeTab === CONFIG_TAB) return;
    if (categoryDef(state.activeTab).kind !== 'dir' || !entries.some((en) => en.isDirectory)) {
      handleFiles([...e.dataTransfer.files]);
      return;
    }
    const files = [];
    try {
      for (const en of entries) await collectEntryFiles(en, '', files);
    } catch (err) {
      sayMany([{ text: errText(err), kind: 'error' }]);
      return;
    }
    handleFiles(files);
  });
  $('edit-form').addEventListener('submit', applyEdit);
  $('edit-cancel').addEventListener('click', () => $('edit-dialog').close());
  $('edit-dialog').addEventListener('close', () => { editing = null; });
  $('meta-form').addEventListener('submit', saveMeta);
  for (const k of META_FIELDS) $(`meta-${k}`).addEventListener('input', updateMetaDirty);
  $('mcp-edit').addEventListener('click', editMcp);
  $('hooks-edit').addEventListener('click', editHooks);
  $('download-btn').addEventListener('click', guarded(download, 'download-messages'));
  $('preview-btn').addEventListener('click', guarded(previewChanges, 'publish-messages'));
  $('publish-form').addEventListener('submit', guarded(doPublish, 'publish-messages'));
  $('ack-exec').addEventListener('change', () => {
    for (const id of ['download-messages', 'publish-messages']) $(id).replaceChildren();
    renderGate();
  });
  $('confirm-name').addEventListener('input', renderGate);
  for (const id of ['tgt-repo', 'tgt-branch']) $(id).addEventListener('input', invalidatePlan);
  $('tgt-repo').addEventListener('input', (e) => { targetFollowsAccount = e.target.value.trim() === ''; });
}

// A framed page wires nothing: no token entry and no request.
if (window.top !== window.self) {
  $('frame-notice').hidden = false;
  $('app').hidden = true;
} else {
  wire();
  renderAuth();
  if (state.source.repo && !link.fromLink) $('source-form').requestSubmit();
}
