// GitHub REST client for loading a repo and publishing a commit via the Git Data API.
import { LIMITS, checkSymlinks, decodeUtf8, formatMiB, totalSizeProblem, treeLimitProblem, validateSymlink, visible } from './model.js';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const seg = (s) => s.split('/').map(encodeURIComponent).join('/');

const FINE_GRAINED = /^github_pat_[A-Za-z0-9_]{20,}$/;

/** @returns {string|null} an error message, or null when the token may be used */
export function validateToken(token) {
  const t = String(token ?? '');
  if (FINE_GRAINED.test(t)) return null;
  if (t.startsWith('ghp_') || /^[0-9a-f]{40}$/i.test(t)) return 'Classic personal access tokens are not accepted because they grant broad access to all your repositories and may never expire. Create a fine-grained token (github_pat_…) instead.';
  if (/^gh[ousr]_/.test(t)) return 'OAuth and GitHub App tokens (gho_, ghu_, ghs_, ghr_) are not accepted. Use a fine-grained personal access token (github_pat_…).';
  return 'Not a fine-grained personal access token. It must start with github_pat_ and contain only letters, digits and underscores.';
}

const DOT_SEGMENTS = ['.', '..'];

export function parseRepoRef(input) {
  const m = String(input).trim().match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!m || DOT_SEGMENTS.includes(m[1]) || DOT_SEGMENTS.includes(m[2])) throw new Error('Enter a repository as owner/name or a github.com URL');
  return { owner: m[1], repo: m[2] };
}

const BAD_BRANCH = /[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|\/\/|\.lock$|^\/|\/$|(^|\/)\.|@\{/;

export const isValidBranch = (name) => Boolean(name) && !BAD_BRANCH.test(name);

export const normalizeRef = (ref) => {
  try {
    const { owner, repo } = parseRepoRef(ref);
    return `${owner}/${repo}`.toLowerCase();
  } catch {
    return String(ref).trim().toLowerCase();
  }
};

const canonicalRef = (ref) => {
  try {
    const { owner, repo } = parseRepoRef(ref);
    return `${owner}/${repo}`.toLowerCase();
  } catch {
    return '';
  }
};

/** Only the Pages-derived repo is trusted, and only for its exact default branch; other spellings (pull/N/head, short SHA, tag) can resolve to a fork's commit. */
export function isTrustedLoad(ref, branch, repoDefault, pagesRepo) {
  const name = canonicalRef(ref);
  return Boolean(repoDefault) && branch === repoDefault && name !== '' && name === canonicalRef(pagesRepo);
}

// Plain characters only, so a prefilled branch cannot show hidden or direction-changing text.
const LINK_BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;

// The repo comes from the Pages URL; ?repo=owner/name[&branch=x] only prefills the form (`fromLink`) and never loads.
export function detectSource({ search, hostname, pathname }) {
  const host = hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  let pagesRepo = '';
  if (host) {
    const first = pathname.split('/')[1];
    pagesRepo = `${host[1]}/${first && !first.endsWith('.html') ? first : `${host[1]}.github.io`}`;
  }
  const q = new URLSearchParams(search);
  const requested = (q.get('repo') ?? '').trim();
  if (!requested) return { repo: pagesRepo, branch: '', pagesRepo, fromLink: false };
  try {
    const { owner, repo } = parseRepoRef(requested);
    const branch = (q.get('branch') ?? '').trim();
    return { repo: `${owner}/${repo}`, branch: LINK_BRANCH.test(branch) && isValidBranch(branch) ? branch : '', pagesRepo, fromLink: true };
  } catch {
    return { repo: '', branch: '', pagesRepo, fromLink: true };
  }
}

/** @returns {Promise<Uint8Array|null>} null when the body exceeds `max`; stops reading at that point when streaming is available */
async function readCapped(res, max = Infinity) {
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        try {
          await reader.cancel();
        } catch {
          /* stream already closed */
        }
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes.length > max ? null : bytes;
}

async function request(path, { token, method = 'GET', body, accept, raw = false, signal, maxBytes } = {}) {
  signal?.throwIfAborted();
  const headers = { Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal });
  if (!res.ok) {
    let msg = res.statusText || `HTTP ${res.status}`;
    try {
      msg = (await res.json()).message || msg;
    } catch {
      /* non-JSON error body */
    }
    throw new GitHubError(msg, res.status);
  }
  if (raw) return readCapped(res, maxBytes);
  return res.status === 204 ? null : res.json();
}

async function tryRequest(path, opts) {
  try {
    return await request(path, opts);
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 404 || e.status === 409)) return null;
    throw e;
  }
}

export async function verifyToken(token, { signal } = {}) {
  const err = validateToken(token);
  if (err) throw new Error(err);
  const user = await request('/user', { token, signal });
  return { login: user.login };
}

export async function defaultBranch({ owner, repo }, token, { signal } = {}) {
  return (await makeReader(token, signal).read(`/repos/${owner}/${repo}`)).default_branch;
}

// Anonymous first; a private repo (404) or an exhausted anonymous rate limit (403/429) switches to the token for good.
// Once an anonymous read has succeeded the repo is public, so a 404 can no longer mean "private".
function makeReader(token, signal) {
  let authed = false;
  let proven = false;
  const read = async (path, opts = {}) => {
    if (authed) return request(path, { ...opts, token, signal });
    try {
      const result = await request(path, { ...opts, signal });
      proven = true;
      return result;
    } catch (e) {
      if (!token || !(e instanceof GitHubError) || !(proven ? [403, 429] : [403, 404, 429]).includes(e.status)) throw e;
      authed = true;
      return request(path, { ...opts, token, signal });
    }
  };
  return { read, get authed() { return authed; } };
}

// After the first failure no worker takes a new item; `worker` gets a second argument that reports it.
async function pool(items, limit, worker, signal) {
  let next = 0;
  let failed = false;
  const stopped = () => failed;
  const run = async () => {
    while (next < items.length && !failed) {
      try {
        signal?.throwIfAborted();
        await worker(items[next++], stopped);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

export async function loadRepo({ owner, repo, branch }, token, onProgress = () => {}, { signal, limits = LIMITS } = {}) {
  const reader = makeReader(token, signal);
  const tree = await reader.read(`/repos/${owner}/${repo}/git/trees/${seg(branch)}?recursive=1`);
  if (tree.truncated) throw new Error('Repository tree is too large to load in the browser');
  const entries = tree.tree.filter((e) => e.type === 'blob');
  const treeProblem = treeLimitProblem(entries, limits);
  if (treeProblem) throw new Error(treeProblem);
  const files = [];
  let done = 0;
  let loaded = 0;
  await pool(entries, 6, async (e, stopped) => {
    const isLink = e.mode === '120000';
    const cap = isLink ? limits.maxSymlinkBytes : limits.maxFileBytes;
    let bytes = null;
    // raw.githubusercontent.com does not return a symlink's target text reliably.
    if (!reader.authed && !isLink) {
      try {
        const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${seg(branch)}/${seg(e.path)}`, { signal });
        // Raw can be stale or LFS-resolved, so only bytes matching the tree's blob SHA are used.
        const got = res.ok ? await readCapped(res, Number.isSafeInteger(e.size) && e.size >= 0 ? e.size : cap) : null;
        if (got && await gitBlobSha(got) === e.sha) bytes = got;
      } catch (err) {
        if (signal?.aborted) throw err;
        /* raw unreachable or unhashable: use the blob API */
      }
    }
    bytes ??= await reader.read(`/repos/${owner}/${repo}/git/blobs/${e.sha}`, { accept: 'application/vnd.github.raw+json', raw: true, maxBytes: cap }).catch((err) => {
      throw err instanceof GitHubError ? new GitHubError(`Could not read ${e.path}: ${err.message}`, err.status) : err;
    });
    if (bytes === null) throw new Error(`${visible(e.path)} is larger than the per-file limit of ${isLink ? `${cap} bytes` : formatMiB(cap)}.`);
    loaded += bytes.length;
    const totalProblem = totalSizeProblem(loaded, limits);
    if (totalProblem) throw new Error(totalProblem);
    files.push({ path: e.path, bytes, mode: parseInt(e.mode, 8) });
    if (!stopped()) onProgress(++done, entries.length);
  }, signal);
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export async function gitBlobSha(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(header.length + bytes.length);
  buf.set(header);
  buf.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const GIT_MODE_SYMLINK = 0o120000;
const GIT_MODE_FILE = 0o100644;
const GIT_MODE_EXECUTABLE = 0o100755;

const octal = (n) => n.toString(8);

const gitMode = (mode) => {
  const value = typeof mode === 'string' ? Number.parseInt(mode, 8) : mode;
  if ((value & 0o170000) === GIT_MODE_SYMLINK) return octal(GIT_MODE_SYMLINK);
  return octal(value & 0o111 ? GIT_MODE_EXECUTABLE : GIT_MODE_FILE);
};

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const unsafeSymlink = (path, reason) => new Error(`Unsafe symlink ${visible(path)}: ${reason}`);

/** Reads the target branch (or the base to branch from) and its current tree. */
export async function inspectTarget({ owner, repo }, branch, token, { signal } = {}) {
  const base = `/repos/${owner}/${repo}`;
  let kind;
  let headSha = null;
  let effectiveBranch = branch;

  const ref = await tryRequest(`${base}/git/ref/heads/${seg(branch)}`, { token, signal });
  if (ref) {
    kind = 'existing';
    headSha = ref.object.sha;
  } else {
    const info = await request(base, { token, signal });
    if (!info.permissions?.push) throw new Error('The token has no write access to this repository');
    const defRef = await tryRequest(`${base}/git/ref/heads/${seg(info.default_branch)}`, { token, signal });
    if (defRef) {
      kind = 'newBranch';
      headSha = defRef.object.sha;
    } else {
      kind = 'empty';
      effectiveBranch = info.default_branch;
    }
  }

  const remote = new Map();
  let baseTreeSha = null;
  if (headSha) {
    const commit = await request(`${base}/git/commits/${headSha}`, { token, signal });
    baseTreeSha = commit.tree.sha;
    const tree = await request(`${base}/git/trees/${baseTreeSha}?recursive=1`, { token, signal });
    if (tree.truncated) throw new Error('Target repository tree is too large to compare in the browser');
    for (const e of tree.tree) if (e.type === 'blob') remote.set(e.path, { sha: e.sha, mode: e.mode });
  }
  return { kind, headSha, baseTreeSha, remote, branch: effectiveBranch };
}

/** @param {Map<string,{bytes:Uint8Array,mode:number}>} finalMap  @param {(path:string)=>boolean} isManaged */
export async function planChanges(finalMap, remote, isManaged) {
  const { rejected } = checkSymlinks(finalMap);
  if (rejected.length) throw unsafeSymlink(rejected[0].path, rejected[0].reason);
  const changes = [];
  for (const [path, f] of finalMap) {
    const mode = gitMode(f.mode);
    const sha = await gitBlobSha(f.bytes);
    const r = remote.get(path);
    if (!r) changes.push({ path, status: 'add', mode, bytes: f.bytes });
    else if (r.sha !== sha || r.mode !== mode) changes.push({ path, status: 'modify', mode, bytes: f.bytes });
  }
  for (const path of remote.keys()) {
    if (!finalMap.has(path) && isManaged(path)) {
      const r = remote.get(path);
      changes.push({ path, status: 'delete', mode: gitMode(r?.mode ?? '100644') });
    }
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export async function publish({ owner, repo }, token, inspection, changes, message, onProgress = () => {}, { signal } = {}) {
  const base = `/repos/${owner}/${repo}`;
  const { kind, branch } = inspection;
  let { headSha, baseTreeSha } = inspection;
  const upserts = changes.filter((c) => c.status !== 'delete');
  const deletes = changes.filter((c) => c.status === 'delete');
  let refKind = kind;

  for (const c of upserts) {
    if (c.mode !== '120000') continue;
    let target;
    try {
      target = decodeUtf8(c.bytes);
    } catch {
      throw unsafeSymlink(c.path, 'target is not valid UTF-8');
    }
    const checked = validateSymlink(c.path, target);
    if (checked.error) throw unsafeSymlink(c.path, checked.error);
  }

  if (kind === 'empty') {
    // The Git Data API rejects empty repos, so seed the default branch via the Contents API.
    const idx = upserts.findIndex((c) => c.mode === '100644');
    if (idx < 0) throw new Error('Cannot initialise an empty repository without a regular file');
    const [seed] = upserts.splice(idx, 1);
    onProgress('Initialising empty repository…');
    const res = await request(`${base}/contents/${seg(seed.path)}`, { token, method: 'PUT', body: { message, content: toBase64(seed.bytes) }, signal });
    headSha = res.commit.sha;
    baseTreeSha = res.commit.tree.sha;
    refKind = 'existing';
    if (!upserts.length && !deletes.length) return { sha: headSha, url: `https://github.com/${owner}/${repo}/commit/${headSha}` };
  }

  const entries = [];
  let n = 0;
  for (const c of upserts) {
    onProgress(`Uploading ${++n}/${upserts.length}: ${c.path}`);
    const blob = await request(`${base}/git/blobs`, { token, method: 'POST', body: { content: toBase64(c.bytes), encoding: 'base64' }, signal });
    entries.push({ path: c.path, mode: c.mode, type: 'blob', sha: blob.sha });
  }
  for (const c of deletes) entries.push({ path: c.path, mode: c.mode || '100644', type: 'blob', sha: null });

  onProgress('Creating commit…');
  const tree = await request(`${base}/git/trees`, { token, method: 'POST', body: { base_tree: baseTreeSha, tree: entries }, signal });
  const commit = await request(`${base}/git/commits`, { token, method: 'POST', body: { message, tree: tree.sha, parents: [headSha] }, signal });
  if (refKind === 'newBranch') {
    await request(`${base}/git/refs`, { token, method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha }, signal });
  } else {
    await request(`${base}/git/refs/heads/${seg(branch)}`, { token, method: 'PATCH', body: { sha: commit.sha, force: false }, signal });
  }
  return { sha: commit.sha, url: `https://github.com/${owner}/${repo}/commit/${commit.sha}` };
}
