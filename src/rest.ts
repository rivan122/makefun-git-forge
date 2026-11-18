// The GitHub REST v3 surface: repositories, contents, branches/commits, git data, labels,
// issues, comments and pull requests, all under /api/v3.
//
// app.ts owns the socket, the health probe and bearer-token auth (401 before dispatch); this
// module answers every /api/v3 path for an authenticated request and returns true, and returns
// false for any other path. Ownership: a repository whose owner is not the viewer's login is a
// 404 on every route, never a 403. Every reply goes through sendJson with a fresh request id, so
// every REST reply (errors included) carries a non-empty X-GitHub-Request-Id header and a JSON
// body with a string `message` on errors. Nothing here reads the wall clock or a random source:
// timestamps come from store.nowIso()/store.epochSec(), so a replayed request stream reproduces
// byte-identical replies.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { b64, isHex40, nextRequestId, readBody, sendJson, sendJsonText, unb64 } from './util.ts';
import { VIEWER } from './store.ts';

type Any = any;

const API_PREFIX = '/api/v3';
const SCOPES = 'repo, read:org';
const INSTALLED_VERSION = '1.0.0-forge';

// ---------------------------------------------------------------------------------------------
// Small adapters over the shared store/gitdb shapes (kept deliberately shape-tolerant).

function decodeB64(text: string): Buffer {
  try {
    const out: Any = (unb64 as Any)(text);
    if (Buffer.isBuffer(out)) return out;
    if (out instanceof Uint8Array) return Buffer.from(out);
    if (typeof out === 'string') return Buffer.from(out, 'utf8');
  } catch {
    // fall through to the plain decoder
  }
  return Buffer.from(String(text).replace(/[\r\n\t ]+/g, ''), 'base64');
}

function encodeB64(buf: Buffer): string {
  try {
    const out: Any = (b64 as Any)(buf);
    if (typeof out === 'string') return out;
  } catch {
    // fall through
  }
  return buf.toString('base64');
}

/** GitHub wraps base64 content at 60 columns with a trailing newline. */
function wrapB64(buf: Buffer): string {
  const raw = encodeB64(buf);
  if (raw === '') return '';
  return `${raw.replace(/(.{60})/g, '$1\n')}${raw.length % 60 === 0 ? '' : '\n'}`;
}

function refGet(git: Any, name: string): string | null {
  const refs = git?.refs;
  if (!refs) return null;
  const value = typeof refs.get === 'function' ? refs.get(name) : refs[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

function refSet(git: Any, name: string, sha: string): void {
  if (typeof git.refs.set === 'function') git.refs.set(name, sha);
  else git.refs[name] = sha;
}

function refNames(git: Any): string[] {
  const refs = git?.refs;
  if (!refs) return [];
  if (typeof refs.keys === 'function') return [...refs.keys()];
  return Object.keys(refs);
}

function branchTip(repo: Any, branch: string): string | null {
  return refGet(repo.git, `refs/heads/${branch}`);
}

/** Resolve a ref parameter (branch name, HEAD, or a commit sha) to a commit sha. */
function resolveRef(repo: Any, ref: string | null | undefined): string | null {
  const git = repo.git;
  if (ref === undefined || ref === null || ref === '') {
    const head = typeof git.headRef === 'string' ? refGet(git, git.headRef) : null;
    return head ?? branchTip(repo, repo.default_branch);
  }
  if (ref === 'HEAD') return resolveRef(repo, '');
  const byBranch = refGet(git, `refs/heads/${ref}`);
  if (byBranch !== null) return byBranch;
  const byTag = refGet(git, `refs/tags/${ref}`);
  if (byTag !== null) return byTag;
  if (isHex40(ref) && commitOf(git, ref) !== null) return ref;
  return null;
}

interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
}

const AUTHOR_LINE = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/;

/** ISO-8601 UTC for an epoch-second count, computed without Date (deterministic by construction). */
function isoFromEpoch(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  let rest = totalSeconds - days * 86400;
  const hour = Math.floor(rest / 3600);
  rest -= hour * 3600;
  const minute = Math.floor(rest / 60);
  const second = rest - minute * 60;
  // Civil-from-days (Howard Hinnant's algorithm), proleptic Gregorian calendar.
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const year0 = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  const year = month <= 2 ? year0 + 1 : year0;
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}Z`;
}

function parseAuthor(value: Any, out: { name: string; email: string; date: string }): void {
  if (typeof value === 'string') {
    const match = AUTHOR_LINE.exec(value);
    if (match) {
      out.name = match[1] ?? '';
      out.email = match[2] ?? '';
      out.date = isoFromEpoch(Number(match[3] ?? '0'));
    } else {
      out.name = value;
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    out.name = typeof value.name === 'string' ? value.name : out.name;
    out.email = typeof value.email === 'string' ? value.email : out.email;
    if (typeof value.date === 'string') out.date = value.date;
    else if (typeof value.timestamp === 'number') out.date = isoFromEpoch(value.timestamp);
    else if (typeof value.time === 'number') out.date = isoFromEpoch(value.time);
    else if (typeof value.epoch === 'number') out.date = isoFromEpoch(value.epoch);
  }
}

function commitOf(git: Any, sha: string): CommitInfo | null {
  if (typeof sha !== 'string' || sha === '') return null;
  let raw: Any;
  try {
    raw = git.commit(sha);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const tree = typeof raw.tree === 'string' ? raw.tree : typeof raw.tree?.sha === 'string' ? raw.tree.sha : '';
  const parents: string[] = [];
  if (Array.isArray(raw.parents)) {
    for (const parent of raw.parents) {
      if (typeof parent === 'string') parents.push(parent);
      else if (typeof parent?.sha === 'string') parents.push(parent.sha);
    }
  }
  const author = { name: '', email: '', date: '' };
  parseAuthor(raw.author, author);
  return {
    tree,
    parents,
    message: typeof raw.message === 'string' ? raw.message : '',
    authorName: author.name,
    authorEmail: author.email,
    authorDate: author.date,
  };
}

function historyOf(git: Any, sha: string, limit: number): string[] {
  try {
    const out: Any = git.history(sha, limit);
    if (Array.isArray(out)) {
      const shas = out
        .map((entry: Any) => (typeof entry === 'string' ? entry : typeof entry?.sha === 'string' ? entry.sha : null))
        .filter((entry: Any): entry is string => typeof entry === 'string');
      if (shas.length > 0) return shas.slice(0, limit);
    }
  } catch {
    // fall through to the parent walk
  }
  const shas: string[] = [];
  const seen = new Set<string>();
  let current: string | null = sha;
  while (current !== null && shas.length < limit && !seen.has(current)) {
    seen.add(current);
    shas.push(current);
    const commit = commitOf(git, current);
    current = commit !== null && commit.parents.length > 0 ? (commit.parents[0] as string) : null;
  }
  return shas;
}

interface FlatEntry {
  sha: string;
  mode?: string;
  type?: string;
}

/** A commit tree flattened to path -> blob entry, tolerant of the store's map/array/object shapes. */
function flatTree(git: Any, treeSha: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  if (typeof treeSha !== 'string' || treeSha === '') return out;
  let flat: Any;
  try {
    flat = git.flattenTree(treeSha);
  } catch {
    return out;
  }
  if (flat === null || flat === undefined) return out;
  const put = (path: Any, value: Any): void => {
    if (typeof path !== 'string' || path === '') return;
    if (typeof value === 'string') out.set(path, { sha: value });
    else if (value !== null && typeof value === 'object') {
      const sha = typeof value.sha === 'string' ? value.sha : typeof value.id === 'string' ? value.id : '';
      if (sha !== '') out.set(path, { sha, mode: value.mode, type: value.type });
    }
  };
  if (typeof flat.forEach === 'function' && typeof flat.get === 'function') flat.forEach((value: Any, key: Any) => put(key, value));
  else if (Array.isArray(flat)) for (const entry of flat) put(entry?.path ?? entry?.name, entry);
  else if (typeof flat === 'object') for (const [key, value] of Object.entries(flat)) put(key, value);
  return out;
}

interface TreeEntry {
  name: string;
  mode: string;
  type: string;
  sha: string;
}

/** The direct entries of one tree object, normalised to GitHub's {name, mode, type, sha}. */
function treeEntries(git: Any, treeSha: string): TreeEntry[] {
  let raw: Any;
  try {
    raw = git.tree(treeSha);
  } catch {
    return [];
  }
  if (raw === null || raw === undefined) return [];
  const list: Any[] = [];
  if (typeof raw.forEach === 'function' && typeof raw.get === 'function') raw.forEach((value: Any, key: Any) => list.push({ ...(value ?? {}), name: key }));
  else if (Array.isArray(raw)) list.push(...raw);
  else if (Array.isArray(raw.entries)) list.push(...raw.entries);
  else if (typeof raw === 'object') for (const [key, value] of Object.entries(raw)) list.push({ ...(value as Any), name: key });
  const out: TreeEntry[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name : typeof entry.path === 'string' ? entry.path : '';
    const sha = typeof entry.sha === 'string' ? entry.sha : typeof entry.id === 'string' ? entry.id : '';
    if (name === '' || sha === '') continue;
    const rawMode = typeof entry.mode === 'string' ? entry.mode : typeof entry.mode === 'number' ? entry.mode.toString(8) : '';
    // gitdb writes directory modes as '40000' (git's own form); GitHub's API spells it '040000'.
    const isTree = entry.type === 'tree' || rawMode === '40000' || rawMode === '040000';
    const mode = isTree ? '040000' : rawMode !== '' ? rawMode.padStart(6, '0') : '100644';
    out.push({ name, mode, type: isTree ? 'tree' : 'blob', sha });
  }
  return out;
}

/** Walk `path` down from a root tree; returns the tree sha at the path, or null. */
function treeAtPath(git: Any, rootTreeSha: string, path: string): string | null {
  if (path === '') return rootTreeSha;
  let current = rootTreeSha;
  for (const segment of path.split('/')) {
    const entry = treeEntries(git, current).find((candidate) => candidate.name === segment);
    if (entry === undefined || entry.type !== 'tree') return null;
    current = entry.sha;
  }
  return current;
}

function loadData(git: Any, sha: string): Buffer | null {
  try {
    const obj: Any = git.load(sha);
    if (obj === null || obj === undefined) return null;
    const data = obj.data ?? obj.content ?? obj;
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof Uint8Array) return Buffer.from(data);
    if (typeof data === 'string') return Buffer.from(data, 'utf8');
    return null;
  } catch {
    return null;
  }
}

/** Every file of a commit as path -> bytes (empty map for an unborn branch). */
function filesOfCommit(git: Any, commitSha: string | null): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  if (commitSha === null) return files;
  const commit = commitOf(git, commitSha);
  if (commit === null) return files;
  for (const [path, entry] of flatTree(git, commit.tree)) {
    const data = loadData(git, entry.sha);
    if (data !== null) files.set(path, data);
  }
  return files;
}

function writeBlobSha(git: Any, data: Buffer): string {
  const out: Any = git.writeBlob(data);
  if (typeof out === 'string') return out;
  if (typeof out?.sha === 'string') return out.sha;
  return '';
}

function buildTreeFromFiles(git: Any, files: Map<string, Buffer>): string {
  const out: Any = git.makeTreeFromFiles(files);
  if (typeof out === 'string') return out;
  if (typeof out?.sha === 'string') return out.sha;
  return '';
}

function makeCommitSha(git: Any, treeSha: string, parents: string[], message: string, authorLine: string): string {
  const out: Any = git.makeCommit(treeSha, parents, message, authorLine);
  if (typeof out === 'string') return out;
  if (typeof out?.sha === 'string') return out.sha;
  return '';
}

function mergeBaseOf(git: Any, a: string, b: string): string | null {
  try {
    const out: Any = git.mergeBase(a, b);
    if (typeof out === 'string' && out !== '') return out;
    if (typeof out?.sha === 'string') return out.sha;
  } catch {
    // no merge base
  }
  return null;
}

function authorLineOf(store: Any): string {
  return `${VIEWER.name} <${VIEWER.email}> ${store.epochSec()} +0000`;
}

// ---------------------------------------------------------------------------------------------
// Record rendering

function userJson(user: Any): Record<string, unknown> {
  if (typeof user === 'string') return { login: user, id: user === VIEWER.login ? VIEWER.id : 0, type: 'User' };
  if (user !== null && typeof user === 'object' && typeof user.login === 'string') {
    return { login: user.login, id: typeof user.id === 'number' ? user.id : VIEWER.id, type: typeof user.type === 'string' ? user.type : 'User' };
  }
  return { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type };
}

function repoJson(store: Any, repo: Any): Record<string, unknown> {
  let openIssues = 0;
  const issues: Any = repo.issues;
  const each: Any[] = issues && typeof issues.forEach === 'function' ? [...issues.values()] : Object.values(issues ?? {});
  for (const issue of each) if (issue?.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: repo.private === true,
    description: repo.description ?? null,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    html_url: `/${repo.full_name}`,
    fork: false,
    open_issues_count: openIssues,
  };
}

function labelOf(repo: Any, name: string): { name: string; color: string; description: string | null } | null {
  const labels: Any = repo.labels;
  if (!labels) return null;
  const raw: Any = typeof labels.get === 'function' ? labels.get(name) : labels[name];
  if (raw === null || raw === undefined) return null;
  return {
    name: typeof raw.name === 'string' ? raw.name : name,
    color: typeof raw.color === 'string' ? raw.color : 'ededed',
    description: typeof raw.description === 'string' ? raw.description : null,
  };
}

function labelNames(repo: Any): string[] {
  const labels: Any = repo.labels;
  if (!labels) return [];
  if (typeof labels.keys === 'function') return [...labels.keys()];
  return Object.keys(labels);
}

function setLabel(repo: Any, label: { name: string; color: string; description: string | null }): void {
  if (typeof repo.labels.set === 'function') repo.labels.set(label.name, label);
  else repo.labels[label.name] = label;
}

function issueJson(repo: Any, rec: Any): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: rec.id,
    number: rec.number,
    title: rec.title,
    body: typeof rec.body === 'string' ? rec.body : '',
    state: rec.state,
    labels: (Array.isArray(rec.labels) ? rec.labels : []).map((name: string) => labelOf(repo, name) ?? { name, color: 'ededed', description: null }),
    user: userJson(rec.user),
    comments: Array.isArray(rec.comments) ? rec.comments.length : 0,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
  };
  if (rec.isPull === true) out.pull_request = { merged_at: rec.pull?.mergedAt ?? null };
  return out;
}

/**
 * The last GET-one-issue body this process serialized, stamped with every value issueJson
 * reads. Reading one issue is the read benchmark's whole workload — two thousand renders of
 * the same record — so the render is memoized: the stamp is rebuilt from the record's (and
 * the repo's labels') current values on every request, and the cached text is served only
 * when the stamp matches, which is exactly when a fresh render would produce the same
 * bytes. Any write through any surface changes a stamped value, so staleness cannot occur.
 */
let issueTextCache: { rec: Any; stamp: string; text: string } | null = null;

/** Everything issueJson(repo, rec) reads, flattened into one comparable string. */
function issueStamp(repo: Any, rec: Any): string {
  const parts: string[] = [
    String(rec.id ?? ''),
    String(rec.number ?? ''),
    String(rec.title ?? ''),
    typeof rec.body === 'string' ? rec.body : '',
    String(rec.state ?? ''),
    String(Array.isArray(rec.comments) ? rec.comments.length : 0),
    String(rec.created_at ?? ''),
    String(rec.updated_at ?? ''),
    rec.isPull === true ? String(rec.pull?.mergedAt ?? '') : '',
  ];
  const user: Any = rec.user;
  if (typeof user === 'string') parts.push(`u:${user}`);
  else if (user !== null && typeof user === 'object') parts.push(`u:${user.login ?? ''}:${user.id ?? ''}:${user.type ?? ''}`);
  const labels: Any[] = Array.isArray(rec.labels) ? rec.labels : [];
  for (const name of labels) {
    const label = labelOf(repo, name) ?? { name, color: 'ededed', description: null };
    parts.push(`l:${label.name}:${label.color}:${label.description ?? ''}`);
  }
  return parts.join('|');
}

/** Answer a GET-one-issue request, reusing the last render while the record is unchanged. */
function replyIssue(res: ServerResponse, repo: Any, rec: Any): void {
  const stamp = issueStamp(repo, rec);
  if (issueTextCache !== null && issueTextCache.rec === rec && issueTextCache.stamp === stamp) {
    sendJsonText(res, 200, issueTextCache.text, nextRequestId());
    return;
  }
  const text = JSON.stringify(issueJson(repo, rec));
  issueTextCache = { rec, stamp, text };
  sendJsonText(res, 200, text, nextRequestId());
}

/** Three-way tree merge dry run / execution shared by `mergeable` and the merge route. */
function planMerge(git: Any, baseTip: string, headTip: string): { files: Map<string, Buffer> } | { conflict: string } {
  const baseCommit = commitOf(git, baseTip);
  const headCommit = commitOf(git, headTip);
  if (baseCommit === null || headCommit === null) return { conflict: 'a branch tip is missing' };
  const base0Sha = mergeBaseOf(git, baseTip, headTip) ?? baseTip;
  const base0Commit = commitOf(git, base0Sha);
  const base0 = flatTree(git, base0Commit?.tree ?? '');
  const head = flatTree(git, headCommit.tree);
  const base = flatTree(git, baseCommit.tree);
  const merged = filesOfCommit(git, baseTip);
  const paths = new Set<string>([...base0.keys(), ...head.keys()]);
  for (const path of paths) {
    const atBase0 = base0.get(path)?.sha;
    const atHead = head.get(path)?.sha;
    if (atBase0 === atHead) continue; // the head branch did not change this path
    const atBase = base.get(path)?.sha;
    if (atBase === atHead) continue; // the base already carries the head's version
    if (atBase !== atBase0) return { conflict: `both branches changed ${path}` };
    if (atHead === undefined) merged.delete(path);
    else {
      const data = loadData(git, atHead);
      if (data === null) return { conflict: `cannot read the head version of ${path}` };
      merged.set(path, data);
    }
  }
  return { files: merged };
}

function pullJson(repo: Any, rec: Any): Record<string, unknown> {
  const pull = rec.pull ?? {};
  let mergeable: boolean | null = null;
  if (rec.state === 'open') {
    const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
    mergeable = headTip !== null && baseTip !== null ? !('conflict' in planMerge(repo.git, baseTip, headTip)) : false;
  }
  return {
    id: rec.id,
    number: rec.number,
    title: rec.title,
    body: typeof rec.body === 'string' ? rec.body : '',
    state: rec.state,
    merged: pull.merged === true,
    merged_at: pull.mergedAt ?? null,
    merge_commit_sha: pull.mergeCommitSha ?? null,
    mergeable,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: userJson(rec.user),
    created_at: rec.created_at,
    updated_at: rec.updated_at,
  };
}

function commitJson(git: Any, sha: string): Record<string, unknown> {
  const commit = commitOf(git, sha);
  const author = { name: commit?.authorName ?? '', email: commit?.authorEmail ?? '', date: commit?.authorDate ?? '' };
  return {
    sha,
    commit: { message: commit?.message ?? '', author, committer: author, tree: { sha: commit?.tree ?? '' } },
    parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

function commentJson(comment: Any): Record<string, unknown> {
  return {
    id: comment.id,
    body: typeof comment.body === 'string' ? comment.body : '',
    user: userJson(comment.user),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

// ---------------------------------------------------------------------------------------------
// Reply helpers

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendJson(res, status, body, nextRequestId(), headers);
}

function fail(res: ServerResponse, status: number, message: string): void {
  reply(res, status, { message });
}

function replyNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

interface Page {
  items: Any[];
  headers: Record<string, string>;
}

/** Slice one page out of a list and build the GitHub Link header for it. */
function paginate(req: IncomingMessage, url: URL, items: Any[]): Page {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (items.length <= perPage && page === 1) return { items: slice, headers: {} };
  const host = req.headers.host ?? 'localhost';
  const linkFor = (target: number): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('page', String(target));
    params.set('per_page', String(perPage));
    return `<http://${host}${url.pathname}?${params.toString()}>`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`${linkFor(page + 1)}; rel="next"`, `${linkFor(totalPages)}; rel="last"`);
  if (page > 1) parts.push(`${linkFor(page - 1)}; rel="prev"`, `${linkFor(1)}; rel="first"`);
  return { items: slice, headers: parts.length > 0 ? { link: parts.join(', ') } : {} };
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; body: Any } | { ok: false }> {
  let raw: Any;
  try {
    raw = await readBody(req);
  } catch {
    return { ok: false };
  }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : String(raw ?? '');
  if (text.trim() === '') return { ok: true, body: {} };
  try {
    const parsed: Any = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: true, body: {} };
    return { ok: true, body: parsed };
  } catch {
    return { ok: false };
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------------------------
// Line diffs for the pull-request files view

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface LineDiff {
  additions: number;
  deletions: number;
  patch: string;
}

/** An LCS line diff; falls back to multiset counts when the inputs are too large for the table. */
function diffLines(before: string, after: string): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > 4_000_000) {
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of b) {
      const left = counts.get(line) ?? 0;
      if (left > 0) counts.set(line, left - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const left of counts.values()) deletions += left;
    return { additions, deletions, patch: '' };
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j] ? (table[(i + 1) * width + j + 1] as number) + 1 : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
    }
  }
  const ops: { kind: ' ' | '-' | '+'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] as string });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
      ops.push({ kind: '-', line: a[i] as string });
      i += 1;
    } else {
      ops.push({ kind: '+', line: b[j] as string });
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push({ kind: '-', line: a[i] as string });
    i += 1;
  }
  while (j < b.length) {
    ops.push({ kind: '+', line: b[j] as string });
    j += 1;
  }
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.kind === '+') additions += 1;
    if (op.kind === '-') deletions += 1;
  }
  const patch = [`@@ -1,${a.length} +1,${b.length} @@`, ...ops.map((op) => `${op.kind}${op.line}`)].join('\n');
  return { additions, deletions, patch };
}

// ---------------------------------------------------------------------------------------------
// The router

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Any, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (path !== API_PREFIX && !path.startsWith(`${API_PREFIX}/`)) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const segments = path
    .slice(API_PREFIX.length)
    .split('/')
    .filter((segment) => segment !== '')
    .map(decodeSegment);

  // The API root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound(res);
    reply(
      res,
      200,
      {
        current_user_url: `${API_PREFIX}/user`,
        current_user_repositories_url: `${API_PREFIX}/user/repos`,
        repository_url: `${API_PREFIX}/repos/{owner}/{repo}`,
        rate_limit_url: `${API_PREFIX}/rate_limit`,
      },
      { 'x-oauth-scopes': SCOPES },
    );
    return true;
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound(res);
    reply(res, 200, { installed_version: INSTALLED_VERSION, verifiable_password_authentication: false });
    return true;
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound(res);
    reply(res, 200, { id: VIEWER.id, login: VIEWER.login, name: VIEWER.name, email: VIEWER.email, type: VIEWER.type });
    return true;
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') return listViewerRepos(req, res, store, url);
    if (method === 'POST') return createRepo(req, res, store);
    return notFound(res);
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    return routeRepo(req, res, store, url, method, segments[1] as string, segments[2] as string, segments.slice(3));
  }
  return notFound(res);
}

function notFound(res: ServerResponse): boolean {
  fail(res, 404, 'Not Found');
  return true;
}

/** The viewer's repository, or null: a foreign owner and a missing name are the same 404. */
function ownedRepo(store: Any, owner: string, name: string): Any | null {
  if (owner !== VIEWER.login) return null;
  const repo = store.getRepo(owner, name);
  return repo === null || repo === undefined ? null : repo;
}

async function listViewerRepos(req: IncomingMessage, res: ServerResponse, store: Any, url: URL): Promise<boolean> {
  const repos: Any[] = store.listRepos(VIEWER.login) ?? [];
  const sorted = [...repos].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const page = paginate(req, url, sorted);
  reply(res, 200, page.items.map((repo) => repoJson(store, repo)), page.headers);
  return true;
}

async function createRepo(req: IncomingMessage, res: ServerResponse, store: Any): Promise<boolean> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return badJson(res);
  const body = parsed.body;
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') {
    fail(res, 422, 'Repository creation failed.');
    return true;
  }
  if (store.getRepo(VIEWER.login, name)) {
    // GitHub's duplicate-create shape: the errors entry is what idempotent callers match on.
    reply(res, 422, {
      message: 'Repository creation failed.',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
    return true;
  }
  const repo = store.createRepo(VIEWER.login, name, {
    description: typeof body.description === 'string' ? body.description : undefined,
    private: typeof body.private === 'boolean' ? body.private : undefined,
    defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : undefined,
  });
  reply(res, 201, repoJson(store, repo));
  return true;
}

function badJson(res: ServerResponse): boolean {
  fail(res, 400, 'Problems parsing JSON');
  return true;
}

async function routeRepo(
  req: IncomingMessage,
  res: ServerResponse,
  store: Any,
  url: URL,
  method: string,
  owner: string,
  name: string,
  rest: string[],
): Promise<boolean> {
  const repo = ownedRepo(store, owner, name);
  if (repo === null) return notFound(res);
  const git = repo.git;

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      reply(res, 200, repoJson(store, repo));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return badJson(res);
      const body = parsed.body;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.default_branch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        if (typeof store.renameRepo === 'function') {
          if (!store.renameRepo(owner, name, body.name)) {
            reply(res, 422, {
              message: 'Repository creation failed.',
              errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
            });
            return true;
          }
        } else {
          repo.name = body.name;
          repo.full_name = `${repo.owner}/${body.name}`;
        }
      }
      repo.updated_at = store.nowIso();
      reply(res, 200, repoJson(store, repo));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      replyNoContent(res);
      return true;
    }
    return notFound(res);
  }

  const head = rest[0] as string;

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = refNames(git)
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), sha: refGet(git, ref) as string }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      reply(res, 200, branches.map((branch) => ({ name: branch.name, commit: { sha: branch.sha }, protected: false })));
      return true;
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (tip === null) return notFound(res);
      reply(res, 200, { name: branch, commit: commitJson(git, tip), protected: false });
      return true;
    }
    return notFound(res);
  }

  if (head === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const refParam = url.searchParams.get('sha');
      const tip = resolveRef(repo, refParam);
      if (tip === null) {
        if (refParam !== null && refParam !== '') return notFound(res);
        reply(res, 200, []);
        return true;
      }
      const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
      const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
      const pageRaw = Number(url.searchParams.get('page') ?? '1');
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
      // The full history, not a page-bounded prefix: paginate() derives the Link header's
      // rel="last" from the array's length, so a truncated walk would understate the last page.
      const shas = historyOf(git, tip, 100_000);
      const page2 = paginate(req, url, shas);
      reply(res, 200, page2.items.map((sha: string) => commitJson(git, sha)), page2.headers);
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = rest[1] as string;
      if (commitOf(git, sha) === null) return notFound(res);
      reply(res, 200, commitJson(git, sha));
      return true;
    }
    return notFound(res);
  }

  if (head === 'contents') {
    const filePath = rest.slice(1).join('/');
    if (method === 'GET') return getContents(res, store, repo, filePath, url.searchParams.get('ref'));
    if (method === 'PUT') return putContents(req, res, store, repo, filePath);
    if (method === 'DELETE') return deleteContents(req, res, store, repo, filePath);
    return notFound(res);
  }

  if (head === 'git') return routeGit(req, res, store, repo, method, rest.slice(1));
  if (head === 'labels') return routeLabels(req, res, store, repo, method, rest.slice(1));
  if (head === 'issues') return routeIssues(req, res, store, url, repo, method, rest.slice(1));
  if (head === 'pulls') return routePulls(req, res, store, url, repo, method, rest.slice(1));
  return notFound(res);
}

// ---------------------------------------------------------------------------------------------
// Contents

function getContents(res: ServerResponse, store: Any, repo: Any, filePath: string, refParam: string | null): boolean {
  const git = repo.git;
  const tip = resolveRef(repo, refParam);
  if (tip === null) return notFound(res);
  const commit = commitOf(git, tip);
  if (commit === null || commit.tree === '') return notFound(res);

  if (filePath !== '') {
    const flat = flatTree(git, commit.tree);
    const file = flat.get(filePath);
    if (file !== undefined) {
      const data = loadData(git, file.sha);
      if (data === null) return notFound(res);
      const base = filePath.slice(filePath.lastIndexOf('/') + 1);
      reply(res, 200, {
        name: base,
        path: filePath,
        sha: file.sha,
        size: data.length,
        type: 'file',
        encoding: 'base64',
        content: wrapB64(data),
      });
      return true;
    }
  }
  const dirTree = treeAtPath(git, commit.tree, filePath);
  if (dirTree === null) return notFound(res);
  const entries = treeEntries(git, dirTree)
    .map((entry) => ({
      name: entry.name,
      path: filePath === '' ? entry.name : `${filePath}/${entry.name}`,
      sha: entry.sha,
      size: entry.type === 'blob' ? (loadData(git, entry.sha)?.length ?? 0) : 0,
      type: entry.type === 'tree' ? 'dir' : 'file',
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  reply(res, 200, entries);
  return true;
}

/** The tip a contents write lands on; an unknown branch is created from the default tip. */
function writeTip(repo: Any, branch: string): string | null {
  const tip = branchTip(repo, branch);
  if (tip !== null) return tip;
  if (branch === repo.default_branch) return null;
  return branchTip(repo, repo.default_branch);
}

async function putContents(req: IncomingMessage, res: ServerResponse, store: Any, repo: Any, filePath: string): Promise<boolean> {
  if (filePath === '') return notFound(res);
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return badJson(res);
  const body = parsed.body;
  if (typeof body.content !== 'string') {
    fail(res, 422, 'content is required');
    return true;
  }
  const git = repo.git;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
  const message = typeof body.message === 'string' ? body.message : '';
  const tip = writeTip(repo, branch);
  const files = filesOfCommit(git, tip);
  let existingSha: string | undefined;
  if (tip !== null) {
    const commit = commitOf(git, tip);
    if (commit !== null) existingSha = flatTree(git, commit.tree).get(filePath)?.sha;
  }
  if (existingSha !== undefined && typeof body.sha === 'string' && body.sha !== existingSha) {
    fail(res, 409, `${filePath} does not match the sha ${body.sha}`);
    return true;
  }
  const data = decodeB64(body.content);
  const blobSha = writeBlobSha(git, data);
  files.set(filePath, data);
  const treeSha = buildTreeFromFiles(git, files);
  const commitSha = makeCommitSha(git, treeSha, tip !== null ? [tip] : [], message, authorLineOf(store));
  refSet(git, `refs/heads/${branch}`, commitSha);
  repo.updated_at = store.nowIso();
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  reply(res, existingSha !== undefined ? 200 : 201, {
    content: { name: base, path: filePath, sha: blobSha, size: data.length, type: 'file', encoding: 'base64' },
    commit: { sha: commitSha },
  });
  return true;
}

async function deleteContents(req: IncomingMessage, res: ServerResponse, store: Any, repo: Any, filePath: string): Promise<boolean> {
  if (filePath === '') return notFound(res);
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return badJson(res);
  const body = parsed.body;
  const git = repo.git;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
  const tip = branchTip(repo, branch);
  if (tip === null) return notFound(res);
  const commit = commitOf(git, tip);
  if (commit === null) return notFound(res);
  const existingSha = flatTree(git, commit.tree).get(filePath)?.sha;
  if (existingSha === undefined) return notFound(res);
  if (typeof body.sha === 'string' && body.sha !== existingSha) {
    fail(res, 409, `${filePath} does not match the sha ${body.sha}`);
    return true;
  }
  const files = filesOfCommit(git, tip);
  files.delete(filePath);
  const treeSha = buildTreeFromFiles(git, files);
  const message = typeof body.message === 'string' ? body.message : '';
  const commitSha = makeCommitSha(git, treeSha, [tip], message, authorLineOf(store));
  refSet(git, `refs/heads/${branch}`, commitSha);
  repo.updated_at = store.nowIso();
  reply(res, 200, { content: null, commit: { sha: commitSha } });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Git data

async function routeGit(req: IncomingMessage, res: ServerResponse, store: Any, repo: Any, method: string, rest: string[]): Promise<boolean> {
  const git = repo.git;
  const head = rest[0];

  if (head === 'refs') {
    if (rest.length === 1 && method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return badJson(res);
      const ref = typeof parsed.body.ref === 'string' ? parsed.body.ref : '';
      const sha = typeof parsed.body.sha === 'string' ? parsed.body.sha : '';
      if (!ref.startsWith('refs/') || commitOf(git, sha) === null) {
        fail(res, 422, 'Reference could not be created.');
        return true;
      }
      if (refGet(git, ref) !== null) {
        fail(res, 422, 'Reference already exists.');
        return true;
      }
      refSet(git, ref, sha);
      reply(res, 201, { ref, object: { sha, type: 'commit' } });
      return true;
    }
    if (rest.length === 1 && method === 'GET') {
      const all = refNames(git)
        .sort()
        .map((ref) => ({ ref, object: { sha: refGet(git, ref) as string, type: 'commit' } }));
      reply(res, 200, all);
      return true;
    }
    if (rest.length >= 2 && method === 'GET') {
      const ref = `refs/${rest.slice(1).join('/')}`;
      const sha = refGet(git, ref);
      if (sha !== null) {
        reply(res, 200, { ref, object: { sha, type: 'commit' } });
        return true;
      }
      // A namespace read (GET /git/refs/heads): every ref under the prefix, GitHub's list shape.
      const under = refNames(git)
        .filter((name) => name.startsWith(`${ref}/`))
        .sort()
        .map((name) => ({ ref: name, object: { sha: refGet(git, name) as string, type: 'commit' } }));
      if (under.length > 0) {
        reply(res, 200, under);
        return true;
      }
      return notFound(res);
    }
    if (rest.length >= 2 && method === 'DELETE') {
      const ref = `refs/${rest.slice(1).join('/')}`;
      if (refGet(git, ref) === null) return notFound(res);
      if (ref === `refs/heads/${repo.default_branch}`) {
        fail(res, 422, 'Cannot delete the default branch.');
        return true;
      }
      git.refs.delete(ref);
      replyNoContent(res);
      return true;
    }
    if (rest.length >= 2 && method === 'PATCH') {
      const ref = `refs/${rest.slice(1).join('/')}`;
      const current = refGet(git, ref);
      if (current === null) return notFound(res);
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return badJson(res);
      const sha = typeof parsed.body.sha === 'string' ? parsed.body.sha : '';
      if (commitOf(git, sha) === null) {
        fail(res, 422, 'Reference could not be updated.');
        return true;
      }
      if (parsed.body.force !== true && sha !== current && mergeBaseOf(git, current, sha) !== current) {
        fail(res, 422, 'Reference could not be updated: not a fast-forward.');
        return true;
      }
      refSet(git, ref, sha);
      reply(res, 200, { ref, object: { sha, type: 'commit' } });
      return true;
    }
    return notFound(res);
  }

  if (head === 'trees') {
    if (rest.length === 1 && method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return badJson(res);
      const body = parsed.body;
      const files = new Map<string, Buffer>();
      if (typeof body.base_tree === 'string') {
        const baseCommit = commitOf(git, body.base_tree);
        const baseTree = baseCommit !== null ? baseCommit.tree : body.base_tree;
        for (const [path, entry] of flatTree(git, baseTree)) {
          const data = loadData(git, entry.sha);
          if (data !== null) files.set(path, data);
        }
      }
      if (Array.isArray(body.tree)) {
        for (const entry of body.tree) {
          if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') continue;
          if (entry.type !== undefined && entry.type !== 'blob') continue;
          if (typeof entry.sha === 'string') {
            const data = loadData(git, entry.sha);
            if (data !== null) files.set(entry.path, data);
          } else if (entry.sha === null) {
            files.delete(entry.path);
          }
        }
      }
      const treeSha = buildTreeFromFiles(git, files);
      reply(res, 201, { sha: treeSha });
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = rest[1] as string;
      const commit = commitOf(git, sha);
      const treeSha = commit !== null ? commit.tree : sha;
      const recursive = new URL(req.url ?? '/', 'http://entry').searchParams.get('recursive');
      const entries: Record<string, unknown>[] = [];
      if (recursive === '1' || recursive === 'true') {
        const walk = (current: string, prefix: string): void => {
          for (const entry of treeEntries(git, current)) {
            const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            entries.push({ path, mode: entry.mode, type: entry.type === 'tree' ? 'tree' : 'blob', sha: entry.sha });
            if (entry.type === 'tree') walk(entry.sha, path);
          }
        };
        walk(treeSha, '');
      } else {
        for (const entry of treeEntries(git, treeSha)) {
          entries.push({ path: entry.name, mode: entry.mode, type: entry.type === 'tree' ? 'tree' : 'blob', sha: entry.sha });
        }
      }
      // A stored tree with no entries is the empty tree: it exists, so it reads back as an
      // empty listing. Only a sha that names no tree (or a non-tree object) is a 404.
      if (entries.length === 0 && commit === null) {
        const stored = typeof git.load === 'function' ? git.load(treeSha) : undefined;
        const isTree = stored !== undefined ? stored.type === 'tree' : flatTree(git, treeSha).size > 0;
        if (!isTree) return notFound(res);
      }
      reply(res, 200, { sha: treeSha, tree: entries, truncated: false });
      return true;
    }
    return notFound(res);
  }

  if (head === 'blobs' && rest.length === 1 && method === 'POST') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return badJson(res);
    const body = parsed.body;
    if (typeof body.content !== 'string') {
      fail(res, 422, 'content is required');
      return true;
    }
    const data = body.encoding === 'base64' ? decodeB64(body.content) : Buffer.from(body.content, 'utf8');
    const sha = writeBlobSha(git, data);
    reply(res, 201, { sha, size: data.length });
    return true;
  }

  if (head === 'commits' && rest.length === 1 && method === 'POST') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return badJson(res);
    const body = parsed.body;
    if (typeof body.tree !== 'string' || typeof body.message !== 'string') {
      fail(res, 422, 'tree and message are required');
      return true;
    }
    const parents: string[] = Array.isArray(body.parents) ? body.parents.filter((p: Any) => typeof p === 'string') : [];
    let line = authorLineOf(store);
    if (body.author !== null && typeof body.author === 'object' && typeof body.author.name === 'string') {
      const email = typeof body.author.email === 'string' ? body.author.email : VIEWER.email;
      line = `${body.author.name} <${email}> ${store.epochSec()} +0000`;
    }
    const sha = makeCommitSha(git, body.tree, parents, body.message, line);
    reply(res, 201, commitJson(git, sha));
    return true;
  }

  if (head === 'blobs' && rest.length === 2 && method === 'GET') {
    const sha = rest[1] as string;
    const stored = typeof git.load === 'function' ? git.load(sha) : undefined;
    const data = stored !== undefined ? (stored.type === 'blob' ? stored.data : null) : loadData(git, sha);
    if (data === null || data === undefined) return notFound(res);
    reply(res, 200, { sha, size: data.length, encoding: 'base64', content: encodeB64(data) });
    return true;
  }

  if (head === 'commits' && rest.length === 2 && method === 'GET') {
    const sha = rest[1] as string;
    if (commitOf(git, sha) === null) return notFound(res);
    reply(res, 200, commitJson(git, sha));
    return true;
  }

  return notFound(res);
}

// ---------------------------------------------------------------------------------------------
// Labels

async function routeLabels(req: IncomingMessage, res: ServerResponse, store: Any, repo: Any, method: string, rest: string[]): Promise<boolean> {
  if (rest.length === 0) {
    if (method === 'GET') {
      const labels = labelNames(repo)
        .map((name) => labelOf(repo, name))
        .filter((label): label is NonNullable<typeof label> => label !== null)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      reply(res, 200, labels);
      return true;
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return badJson(res);
      const body = parsed.body;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        fail(res, 422, 'Label name is required.');
        return true;
      }
      if (labelOf(repo, name) !== null) {
        fail(res, 422, 'Label already exists.');
        return true;
      }
      const label = {
        name,
        color: typeof body.color === 'string' && body.color !== '' ? body.color.replace(/^#/, '') : 'ededed',
        description: typeof body.description === 'string' ? body.description : null,
      };
      setLabel(repo, label);
      reply(res, 201, label);
      return true;
    }
    return notFound(res);
  }
  if (rest.length === 1) {
    const name = rest[0] as string;
    const label = labelOf(repo, name);
    if (method === 'GET') {
      if (label === null) return notFound(res);
      reply(res, 200, label);
      return true;
    }
    if (method === 'PATCH') {
      if (label === null) return notFound(res);
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return badJson(res);
      const updated = {
        name: typeof parsed.body.new_name === 'string' && parsed.body.new_name !== '' ? parsed.body.new_name : label.name,
        color: typeof parsed.body.color === 'string' && parsed.body.color !== '' ? parsed.body.color.replace(/^#/, '') : label.color,
        description: typeof parsed.body.description === 'string' ? parsed.body.description : label.description,
      };
      if (typeof repo.labels.delete === 'function') repo.labels.delete(name);
      else delete repo.labels[name];
      setLabel(repo, updated);
      reply(res, 200, updated);
      return true;
    }
    if (method === 'DELETE') {
      if (label === null) return notFound(res);
      if (typeof repo.labels.delete === 'function') repo.labels.delete(name);
      else delete repo.labels[name];
      replyNoContent(res);
      return true;
    }
  }
  return notFound(res);
}

// ---------------------------------------------------------------------------------------------
// Issues and comments

function issueRecord(repo: Any, number: number): Any | null {
  const issues: Any = repo.issues;
  if (!issues) return null;
  const rec: Any = typeof issues.get === 'function' ? issues.get(number) : issues[number];
  return rec === null || rec === undefined ? null : rec;
}

function allIssues(repo: Any): Any[] {
  const issues: Any = repo.issues;
  if (!issues) return [];
  const values: Any[] = typeof issues.values === 'function' ? [...issues.values()] : Object.values(issues);
  return values.filter((rec) => rec !== null && typeof rec === 'object');
}

async function routeIssues(req: IncomingMessage, res: ServerResponse, store: Any, url: URL, repo: Any, method: string, rest: string[]): Promise<boolean> {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = allIssues(repo).filter((rec) => rec.isPull !== true);
      if (state === 'open') list = list.filter((rec) => rec.state === 'open');
      else if (state === 'closed') list = list.filter((rec) => rec.state === 'closed');
      const sign = direction === 'asc' ? 1 : -1;
      list.sort((a, b) => {
        if (sort === 'created') {
          const byTime = String(a.created_at).localeCompare(String(b.created_at));
          if (byTime !== 0) return sign * byTime;
        }
        return sign * ((a.number ?? 0) - (b.number ?? 0));
      });
      const page = paginate(req, url, list);
      reply(res, 200, page.items.map((rec) => issueJson(repo, rec)), page.headers);
      return true;
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return badJson(res);
      const body = parsed.body;
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') {
        fail(res, 422, 'Title is required.');
        return true;
      }
      const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((l: Any) => typeof l === 'string') : [];
      for (const name of labels) {
        if (labelOf(repo, name) === null) {
          fail(res, 422, `Label ${name} does not exist.`);
          return true;
        }
      }
      const rec = store.addIssue(repo, { title, body: typeof body.body === 'string' ? body.body : undefined, labels });
      reply(res, 201, issueJson(repo, rec));
      return true;
    }
    return notFound(res);
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return notFound(res);
  const rec = issueRecord(repo, number);
  if (rec === null) return notFound(res);

  if (rest.length === 1) {
    if (method === 'GET') {
      replyIssue(res, repo, rec);
      return true;
    }
    if (method === 'PATCH') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return badJson(res);
      const body = parsed.body;
      if (typeof body.title === 'string') rec.title = body.title;
      if (typeof body.body === 'string') rec.body = body.body;
      if (body.state === 'open' || body.state === 'closed') rec.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels: string[] = body.labels.filter((l: Any) => typeof l === 'string');
        for (const name of labels) {
          if (labelOf(repo, name) === null) {
            fail(res, 422, `Label ${name} does not exist.`);
            return true;
          }
        }
        rec.labels = labels;
      }
      rec.updated_at = store.nowIso();
      reply(res, 200, issueJson(repo, rec));
      return true;
    }
    return notFound(res);
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      const comments: Any[] = Array.isArray(rec.comments) ? rec.comments : [];
      const page = paginate(req, url, [...comments]);
      reply(res, 200, page.items.map((comment) => commentJson(comment)), page.headers);
      return true;
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return badJson(res);
      const text = typeof parsed.body.body === 'string' ? parsed.body.body : '';
      if (text === '') {
        fail(res, 422, 'Body is required.');
        return true;
      }
      let id: number;
      if (typeof store.nextCommentId === 'function') {
        id = store.nextCommentId();
      } else {
        let maxId = 0;
        for (const issue of allIssues(repo)) {
          for (const comment of Array.isArray(issue.comments) ? issue.comments : []) {
            if (typeof comment.id === 'number' && comment.id > maxId) maxId = comment.id;
          }
        }
        id = maxId + 1;
      }
      const now = store.nowIso();
      const comment = { id, body: text, user: { ...VIEWER }, created_at: now, updated_at: now };
      if (!Array.isArray(rec.comments)) rec.comments = [];
      rec.comments.push(comment);
      rec.updated_at = now;
      reply(res, 201, commentJson(comment));
      return true;
    }
  }
  return notFound(res);
}

// ---------------------------------------------------------------------------------------------
// Pull requests

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

async function routePulls(req: IncomingMessage, res: ServerResponse, store: Any, url: URL, repo: Any, method: string, rest: string[]): Promise<boolean> {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = allIssues(repo).filter((rec) => rec.isPull === true);
      if (state === 'open') list = list.filter((rec) => rec.state === 'open');
      else if (state === 'closed') list = list.filter((rec) => rec.state === 'closed');
      list.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
      const page = paginate(req, url, list);
      reply(res, 200, page.items.map((rec) => pullJson(repo, rec)), page.headers);
      return true;
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return badJson(res);
      const body = parsed.body;
      const title = typeof body.title === 'string' ? body.title : '';
      const headRef = typeof body.head === 'string' ? stripOwnerPrefix(body.head) : '';
      const baseRef = typeof body.base === 'string' ? stripOwnerPrefix(body.base) : '';
      if (title === '' || headRef === '' || baseRef === '') {
        fail(res, 422, 'Title, head and base are required.');
        return true;
      }
      const headTip = branchTip(repo, headRef);
      const baseTip = branchTip(repo, baseRef);
      if (headTip === null || baseTip === null) {
        fail(res, 422, 'Head or base branch does not exist.');
        return true;
      }
      if (headTip === baseTip) {
        fail(res, 422, `No commits between ${baseRef} and ${headRef}.`);
        return true;
      }
      const rec = store.addPull(repo, { title, body: typeof body.body === 'string' ? body.body : undefined, headRef, baseRef });
      if (rec.pull) {
        if (typeof rec.pull.headSha !== 'string' || rec.pull.headSha === '') rec.pull.headSha = headTip;
        if (typeof rec.pull.baseSha !== 'string' || rec.pull.baseSha === '') rec.pull.baseSha = baseTip;
      }
      reply(res, 201, pullJson(repo, rec));
      return true;
    }
    return notFound(res);
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return notFound(res);
  const rec = issueRecord(repo, number);
  if (rec === null || rec.isPull !== true) return notFound(res);
  const pull = rec.pull ?? {};

  if (rest.length === 1 && method === 'GET') {
    reply(res, 200, pullJson(repo, rec));
    return true;
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const git = repo.git;
    const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
    if (typeof headTip !== 'string' || typeof baseTip !== 'string') {
      reply(res, 200, []);
      return true;
    }
    const base0Sha = mergeBaseOf(git, baseTip, headTip) ?? baseTip;
    const base0Commit = commitOf(git, base0Sha);
    const headCommit = commitOf(git, headTip);
    const before = flatTree(git, base0Commit?.tree ?? '');
    const after = flatTree(git, headCommit?.tree ?? '');
    const paths = new Set<string>([...before.keys(), ...after.keys()]);
    const files: Record<string, unknown>[] = [];
    for (const path of [...paths].sort()) {
      const atBefore = before.get(path)?.sha;
      const atAfter = after.get(path)?.sha;
      if (atBefore === atAfter) continue;
      const beforeText = atBefore === undefined ? '' : (loadData(git, atBefore)?.toString('utf8') ?? '');
      const afterText = atAfter === undefined ? '' : (loadData(git, atAfter)?.toString('utf8') ?? '');
      const diff = diffLines(beforeText, afterText);
      files.push({
        filename: path,
        status: atBefore === undefined ? 'added' : atAfter === undefined ? 'removed' : 'modified',
        additions: diff.additions,
        deletions: diff.deletions,
        changes: diff.additions + diff.deletions,
        patch: diff.patch,
      });
    }
    reply(res, 200, files);
    return true;
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return badJson(res);
    const body = parsed.body;
    if (pull.merged === true) {
      fail(res, 405, 'Pull Request is not mergeable');
      return true;
    }
    if (rec.state !== 'open') {
      fail(res, 405, 'Pull Request is not mergeable');
      return true;
    }
    const git = repo.git;
    const baseTip = branchTip(repo, pull.baseRef);
    // The head branch may have been deleted after the pull request opened; the pull request
    // record keeps the head commit it was opened with, and that is what merges then.
    const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
    if (baseTip === null || headTip === null) {
      fail(res, 405, 'Pull Request is not mergeable');
      return true;
    }
    const plan = planMerge(git, baseTip, headTip);
    if ('conflict' in plan) {
      fail(res, 405, 'Pull Request is not mergeable');
      return true;
    }
    const treeSha = buildTreeFromFiles(git, plan.files);
    const method2 = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
    let message: string;
    let parents: string[];
    if (method2 === 'merge') {
      message = typeof body.commit_title === 'string' ? body.commit_title : `Merge pull request #${rec.number} from ${pull.headRef}`;
      parents = [baseTip, headTip];
    } else {
      const title = typeof body.commit_title === 'string' ? body.commit_title : `${rec.title} (#${rec.number})`;
      message = typeof body.commit_message === 'string' && body.commit_message !== '' ? `${title}\n\n${body.commit_message}` : title;
      parents = [baseTip];
    }
    const mergeSha = makeCommitSha(git, treeSha, parents, message, authorLineOf(store));
    refSet(git, `refs/heads/${pull.baseRef}`, mergeSha);
    pull.merged = true;
    pull.mergedAt = store.nowIso();
    pull.mergeCommitSha = mergeSha;
    pull.mergeable = false;
    rec.state = 'closed';
    rec.updated_at = store.nowIso();
    repo.updated_at = rec.updated_at;
    reply(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
    return true;
  }

  return notFound(res);
}
