// The MCP endpoint: JSON-RPC 2.0 over Streamable HTTP at POST /mcp, application/json replies.
//
// Two protocol eras, both served statelessly (no session header is ever issued):
//   - modern 2026-07-28: `server/discover` answers the server's identity, capabilities and
//     supportedVersions in one result; every later request stands alone.
//   - legacy 2025-11-25 and earlier: `initialize` negotiates the revision, `notifications/initialized`
//     is acknowledged with a bare 202, and the same tools/list + tools/call surface answers.
// The tools act on the same store as REST and GraphQL — a repository or issue created here is the same
// object there, ids unchanged. Tool arguments use github-mcp-server's names (owner, repo, title, body,
// head, base, pull_number, name, description, private, state). Nothing reads a clock or a random source:
// timestamps come from the store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson, nextRequestId } from './util.ts';
import { VIEWER } from './store.ts';

type Rec = Record<string, any>;

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loginOf(user: unknown): string {
  if (typeof user === 'string' && user !== '') return user;
  if (isRecord(user) && typeof user.login === 'string') return user.login;
  return VIEWER.login;
}

// ---------------------------------------------------------------------------------------------------------
// The git object store, read defensively — the same primitives graphql.ts uses, duplicated on purpose:
// the brief keeps this file decoupled from the REST and GraphQL modules, merging from gitdb alone.
// ---------------------------------------------------------------------------------------------------------

function gitRefTip(git: any, refName: string): string | null {
  if (!git) return null;
  const names = [refName, refName.startsWith('refs/') ? refName.slice(5) : `refs/${refName}`];
  for (const name of names) {
    try {
      if (typeof git.getRef === 'function') {
        const value = git.getRef(name);
        if (typeof value === 'string' && value !== '') return value;
      }
    } catch { /* try the next shape */ }
    try {
      if (typeof git.resolveRef === 'function') {
        const value = git.resolveRef(name);
        if (typeof value === 'string' && value !== '') return value;
      }
    } catch { /* try the next shape */ }
    const refs = git.refs;
    if (refs instanceof Map) {
      const value = refs.get(name);
      if (typeof value === 'string' && value !== '') return value;
    } else if (isRecord(refs)) {
      const value = refs[name];
      if (typeof value === 'string' && value !== '') return value;
    }
  }
  return null;
}

function branchTip(git: any, branch: string): string | null {
  return gitRefTip(git, `refs/heads/${branch}`);
}

function gitCommit(git: any, sha: string): Rec | null {
  if (!git || typeof sha !== 'string' || sha === '') return null;
  try {
    const commit = git.commit(sha);
    if (isRecord(commit)) return commit;
  } catch { /* fall through to load */ }
  try {
    if (typeof git.load === 'function') {
      const loaded = git.load(sha);
      if (isRecord(loaded) && (loaded.type === 'commit' || loaded.tree !== undefined || loaded.parents !== undefined)) return loaded;
      const commit = git.commit(sha);
      if (isRecord(commit)) return commit;
    }
  } catch { /* no commit */ }
  return null;
}

function commitTreeSha(commit: Rec | null): string | null {
  if (commit === null) return null;
  const tree = commit.tree ?? commit.treeSha ?? commit.tree_sha;
  return typeof tree === 'string' && tree !== '' ? tree : null;
}

function flatTree(git: any, treeSha: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!git || treeSha === null) return out;
  let flat: unknown = null;
  try {
    flat = git.flattenTree(treeSha);
  } catch {
    flat = null;
  }
  if (flat === null || flat === undefined) return out;
  const entries: Array<[unknown, unknown]> = [];
  if (flat instanceof Map) {
    for (const [key, value] of flat) entries.push([key, value]);
  } else if (Array.isArray(flat)) {
    for (const entry of flat) {
      if (isRecord(entry)) entries.push([entry.path ?? entry.name, entry]);
    }
  } else if (isRecord(flat)) {
    for (const [key, value] of Object.entries(flat)) entries.push([key, value]);
  }
  for (const [path, value] of entries) {
    if (typeof path !== 'string' || path === '') continue;
    const sha = typeof value === 'string' ? value : isRecord(value) ? (value.sha ?? value.oid ?? value.id) : undefined;
    if (typeof sha === 'string' && sha !== '') out.set(path, sha);
  }
  return out;
}

function treeOfCommit(git: any, sha: string | null): Map<string, string> {
  if (sha === null) return new Map();
  return flatTree(git, commitTreeSha(gitCommit(git, sha)));
}

function gitMergeBase(git: any, a: string | null, b: string | null): string | null {
  if (!git || a === null || b === null) return null;
  try {
    const base = git.mergeBase(a, b);
    return typeof base === 'string' && base !== '' ? base : null;
  } catch {
    return null;
  }
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set<string>();
  for (const [path, sha] of after) if (before.get(path) !== sha) paths.add(path);
  for (const path of before.keys()) if (!after.has(path)) paths.add(path);
  return [...paths].sort();
}

/** flattenTree(treeSha) with modes kept: path -> {sha, mode}, whatever shape gitdb returns. */
function flatTreeModes(git: any, treeSha: string | null): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  if (!git || treeSha === null) return out;
  let flat: unknown = null;
  try {
    flat = git.flattenTree(treeSha);
  } catch {
    flat = null;
  }
  if (flat === null || flat === undefined) return out;
  const entries: Array<[unknown, unknown]> = [];
  if (flat instanceof Map) {
    for (const [key, value] of flat) entries.push([key, value]);
  } else if (Array.isArray(flat)) {
    for (const entry of flat) {
      if (isRecord(entry)) entries.push([entry.path ?? entry.name, entry]);
    }
  } else if (isRecord(flat)) {
    for (const [key, value] of Object.entries(flat)) entries.push([key, value]);
  }
  for (const [path, value] of entries) {
    if (typeof path !== 'string' || path === '') continue;
    if (typeof value === 'string') {
      out.set(path, { sha: value, mode: '100644' });
      continue;
    }
    if (isRecord(value)) {
      const sha = value.sha ?? value.oid ?? value.id;
      if (typeof sha === 'string' && sha !== '') out.set(path, { sha, mode: typeof value.mode === 'string' ? value.mode : '100644' });
    }
  }
  return out;
}

function treeModesOfCommit(git: any, sha: string | null): Map<string, { sha: string; mode: string }> {
  if (sha === null) return new Map();
  return flatTreeModes(git, commitTreeSha(gitCommit(git, sha)));
}

/** The sha projection of a mode-carrying flat tree, for diffing. */
function shaMap(flat: Map<string, { sha: string; mode: string }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, value] of flat) out.set(path, value.sha);
  return out;
}

/**
 * Persist a flat path -> {sha, mode} map as nested git trees. gitdb's buildTree takes one level's
 * entries, so directories are grouped and built bottom-up; other writeTree-shaped verbs are the
 * fallback. Null when the store offers no way to write a tree.
 */
function buildTreeFromFlat(git: any, flat: Map<string, { sha: string; mode: string }>): string | null {
  if (!git) return null;
  if (typeof git.buildTree === 'function') {
    interface Item {
      rest: string[];
      sha: string;
      mode: string;
    }
    const buildLevel = (items: Item[]): string => {
      const entries: Array<{ mode: string; name: string; sha: string }> = [];
      const dirs = new Map<string, Item[]>();
      for (const item of items) {
        if (item.rest.length === 1) {
          entries.push({ mode: item.mode, name: item.rest[0]!, sha: item.sha });
        } else {
          const head = item.rest[0]!;
          const group = dirs.get(head) ?? [];
          group.push({ rest: item.rest.slice(1), sha: item.sha, mode: item.mode });
          dirs.set(head, group);
        }
      }
      for (const [name, group] of dirs) entries.push({ mode: '40000', name, sha: buildLevel(group) });
      return git.buildTree(entries);
    };
    try {
      return buildLevel([...flat].map(([path, value]) => ({ rest: path.split('/'), sha: value.sha, mode: value.mode })));
    } catch {
      return null;
    }
  }
  const list = [...flat].map(([path, value]) => ({ path, sha: value.sha, mode: value.mode, type: 'blob' }));
  for (const name of ['writeTree', 'createTree', 'storeTree', 'putTree']) {
    if (typeof git[name] !== 'function') continue;
    for (const arg of [list, flat]) {
      try {
        const made = git[name](arg);
        if (typeof made === 'string' && made !== '') return made;
        if (isRecord(made) && typeof made.sha === 'string') return made.sha;
      } catch { /* try the next shape */ }
    }
  }
  return null;
}

function gitWriteCommit(git: any, spec: { tree: string; parents: string[]; message: string; authorLine: string; when: string }): string | null {
  if (!git) return null;
  if (typeof git.makeCommit === 'function') {
    try {
      const made = git.makeCommit(spec.tree, spec.parents, spec.message, spec.authorLine);
      if (typeof made === 'string' && made !== '') return made;
    } catch { /* fall through to the duck-typed verbs */ }
  }
  const person = { name: VIEWER.name, email: VIEWER.email, date: spec.when };
  const rich: Rec = {
    tree: spec.tree,
    parents: spec.parents,
    message: spec.message,
    author: person,
    committer: person,
    authorName: VIEWER.name,
    authorEmail: VIEWER.email,
    committerName: VIEWER.name,
    committerEmail: VIEWER.email,
    when: spec.when,
  };
  for (const name of ['writeCommit', 'createCommit', 'storeCommit', 'putCommit', 'addCommit']) {
    if (typeof git[name] !== 'function') continue;
    try {
      const made = git[name](rich);
      if (typeof made === 'string' && made !== '') return made;
      if (isRecord(made) && typeof made.sha === 'string') return made.sha;
    } catch { /* try the next shape */ }
    try {
      const made = git[name](spec.tree, spec.parents, spec.message);
      if (typeof made === 'string' && made !== '') return made;
      if (isRecord(made) && typeof made.sha === 'string') return made.sha;
    } catch { /* try the next verb */ }
  }
  return null;
}

function gitSetRef(git: any, refName: string, sha: string): boolean {
  if (!git) return false;
  for (const name of ['setRef', 'updateRef', 'writeRef', 'createRef']) {
    if (typeof git[name] !== 'function') continue;
    try {
      git[name](refName, sha);
      return true;
    } catch { /* try the next shape */ }
  }
  const refs = git.refs;
  if (refs instanceof Map) {
    refs.set(refName, sha);
    return true;
  }
  if (isRecord(refs)) {
    refs[refName] = sha;
    return true;
  }
  return false;
}

/**
 * Squash-merge one pull request record from gitdb primitives alone: the head's changes since the merge
 * base applied onto the base tip as one commit, the base ref moved, the record marked merged. When the
 * git store offers no write verbs the record still merges with the head tip as its merge commit, which
 * is the state every surface reads. Throws an Error with a human message on a real conflict.
 */
function squashMerge(store: any, repo: Rec, issue: Rec): void {
  const pull = issue.pull as Rec;
  const git = repo.git;
  const now = store.nowIso();
  // The live branch tip is what merges; the record's stored head sha is only the fallback for
  // a head branch deleted after the pull request opened (the same rule the REST merge applies).
  const headSha = branchTip(git, String(pull.headRef ?? '')) ?? (typeof pull.headSha === 'string' ? pull.headSha : null);
  const baseTip = branchTip(git, String(pull.baseRef ?? '')) ?? (typeof pull.baseSha === 'string' ? pull.baseSha : null);
  let mergeCommitSha: string | null = headSha;
  if (git && headSha !== null && baseTip !== null) {
    const base = gitMergeBase(git, baseTip, headSha) ?? baseTip;
    const baseTree = treeModesOfCommit(git, base);
    const headTree = treeModesOfCommit(git, headSha);
    const tipTree = treeModesOfCommit(git, baseTip);
    const merged = new Map(tipTree);
    for (const path of changedPaths(shaMap(baseTree), shaMap(headTree))) {
      const tipValue = tipTree.get(path)?.sha;
      const baseValue = baseTree.get(path)?.sha;
      const headValue = headTree.get(path);
      if (tipValue !== baseValue && tipValue !== headValue?.sha) {
        throw new Error(`merge conflict in ${path}`);
      }
      if (headValue === undefined) merged.delete(path);
      else merged.set(path, headValue);
    }
    const treeSha = buildTreeFromFlat(git, merged);
    if (treeSha !== null) {
      const epoch = typeof store.epochSec === 'function' ? store.epochSec() : 0;
      const authorLine = `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
      const message = `${issue.title} (#${issue.number})`;
      const commitSha = gitWriteCommit(git, { tree: treeSha, parents: [baseTip], message, authorLine, when: now });
      if (commitSha !== null) {
        gitSetRef(git, `refs/heads/${String(pull.baseRef)}`, commitSha);
        mergeCommitSha = commitSha;
      }
    }
  }
  pull.merged = true;
  pull.mergedAt = now;
  if (mergeCommitSha !== null) pull.mergeCommitSha = mergeCommitSha;
  pull.mergeable = true;
  issue.state = 'closed';
  issue.updated_at = now;
}

// ---------------------------------------------------------------------------------------------------------
// The REST-shaped views the tool results carry: the same objects /api/v3 serves, from the same records.
// ---------------------------------------------------------------------------------------------------------

function repoView(repo: Rec): Rec {
  return {
    id: repo.id,
    name: repo.name,
    full_name: typeof repo.full_name === 'string' ? repo.full_name : `${repo.owner}/${repo.name}`,
    owner: { login: String(repo.owner ?? VIEWER.login), id: VIEWER.id, type: 'User' },
    private: repo.private === true,
    description: typeof repo.description === 'string' ? repo.description : null,
    default_branch: typeof repo.default_branch === 'string' ? repo.default_branch : 'main',
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
}

function issueView(issue: Rec): Rec {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: typeof issue.body === 'string' ? issue.body : null,
    state: issue.state,
    labels: (Array.isArray(issue.labels) ? issue.labels : []).map((label: unknown) => (typeof label === 'string' ? { name: label } : label)),
    user: { login: loginOf(issue.user), id: VIEWER.id, type: 'User' },
    comments: Array.isArray(issue.comments) ? issue.comments.length : 0,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

function pullView(issue: Rec): Rec {
  const pull = (issue.pull ?? {}) as Rec;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: typeof issue.body === 'string' ? issue.body : null,
    state: issue.state,
    merged: pull.merged === true,
    head: { ref: String(pull.headRef ?? ''), sha: typeof pull.headSha === 'string' ? pull.headSha : null },
    base: { ref: String(pull.baseRef ?? ''), sha: typeof pull.baseSha === 'string' ? pull.baseSha : null },
    user: { login: loginOf(issue.user), id: VIEWER.id, type: 'User' },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Identity, discovery and the tool list — built once and frozen, so two tools/list answers are the
// same bytes and the discover result never changes under a client.
// ---------------------------------------------------------------------------------------------------------

const SERVER_INFO = Object.freeze({ name: 'github-core-clone', version: '1.0.0' });
const CAPABILITIES = Object.freeze({ tools: Object.freeze({ listChanged: false }) });
const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const DISCOVER_RESULT = Object.freeze({
  resultType: 'complete',
  supportedVersions: SUPPORTED_VERSIONS,
  capabilities: CAPABILITIES,
  serverInfo: SERVER_INFO,
  _meta: Object.freeze({ 'io.modelcontextprotocol/serverInfo': SERVER_INFO }),
});

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Rec>;
    required: string[];
  };
}

function tool(name: string, description: string, properties: Record<string, Rec>, required: string[]): ToolDef {
  return Object.freeze({
    name,
    description,
    inputSchema: Object.freeze({ type: 'object' as const, properties: Object.freeze(properties), required: Object.freeze([...required]) as unknown as string[] }),
  }) as ToolDef;
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  tool(
    'create_repo',
    'Create a new repository for the authenticated user.',
    {
      name: { type: 'string', description: 'The name of the repository.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by its owner and name.',
    {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The body of the issue.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List the issues of a repository, optionally filtered by state (open, closed or all).',
    {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Create a pull request from a head branch into a base branch.',
    {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the pull request.' },
      body: { type: 'string', description: 'The body of the pull request.' },
      head: { type: 'string', description: 'The head branch the changes come from.' },
      base: { type: 'string', description: 'The base branch the changes go into.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Merge a pull request by its number.',
    {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      pull_number: { type: 'integer', description: 'The number of the pull request.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);

// ---------------------------------------------------------------------------------------------------------
// The tools. Argument validation failures are JSON-RPC -32602; domain failures (a repository that does
// not exist, a conflicting merge) are tool results with isError: true, the way github-mcp-server reports
// them. Repositories under an owner other than the viewer behave as nonexistent.
// ---------------------------------------------------------------------------------------------------------

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

function toolResult(view: unknown): Rec {
  return { content: [{ type: 'text', text: JSON.stringify(view) }], structuredContent: view };
}

function toolFailure(message: string): Rec {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** store.createRepo's input shape, tolerated in the forms the store contract allows. */
async function createRepoCompat(store: any, input: { name: string; description?: string; private?: boolean }): Promise<Rec> {
  const existing = await store.getRepo(VIEWER.login, input.name);
  if (isRecord(existing)) return existing;
  const attempts: Array<() => Promise<unknown>> = [
    () => store.createRepo(VIEWER.login, input.name, input),
    () => store.createRepo(input),
    () => store.createRepo(input.name, input),
  ];
  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const repo = await attempt();
      if (isRecord(repo) && typeof repo.name === 'string') return repo;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('createRepo failed');
}

async function repoFor(store: any, args: Rec): Promise<Rec | null> {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== VIEWER.login || name === '') return null;
  const repo = await store.getRepo(owner, name);
  return isRecord(repo) ? repo : null;
}

async function callTool(store: any, params: unknown): Promise<Rec> {
  const request = isRecord(params) ? params : {};
  const name = request.name;
  if (typeof name !== 'string' || name === '') throw new RpcError(-32602, 'tools/call needs a tool name');
  const def = TOOLS.find((entry) => entry.name === name);
  if (def === undefined) throw new RpcError(-32602, `Unknown tool: ${name}`);
  const args: Rec = isRecord(request.arguments) ? { ...request.arguments } : {};
  // A full_name argument ("owner/repo") stands in for owner + repo when they were not sent separately.
  if (typeof args.full_name === 'string' && (args.repo === undefined || args.owner === undefined)) {
    const slash = args.full_name.indexOf('/');
    if (slash > 0) {
      if (args.owner === undefined) args.owner = args.full_name.slice(0, slash);
      if (args.repo === undefined) args.repo = args.full_name.slice(slash + 1);
    }
  }
  for (const required of def.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      throw new RpcError(-32602, `Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repo = await createRepoCompat(store, {
        name: String(args.name),
        description: typeof args.description === 'string' ? args.description : undefined,
        private: typeof args.private === 'boolean' ? args.private : undefined,
      });
      return toolResult(repoView(repo));
    }
    case 'get_repo': {
      const repo = await repoFor(store, args);
      if (repo === null) return toolFailure('Not Found: the repository does not exist');
      return toolResult(repoView(repo));
    }
    case 'create_issue': {
      const repo = await repoFor(store, args);
      if (repo === null) return toolFailure('Not Found: the repository does not exist');
      const issue = await store.addIssue(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : undefined,
      });
      return toolResult(issueView(issue));
    }
    case 'list_issues': {
      const repo = await repoFor(store, args);
      if (repo === null) return toolFailure('Not Found: the repository does not exist');
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const all = repo.issues instanceof Map ? [...repo.issues.values()].filter((issue: Rec) => !issue.isPull) : [];
      const filtered = state === 'all' ? all : all.filter((issue: Rec) => String(issue.state).toLowerCase() === state);
      filtered.sort((a: Rec, b: Rec) => (a.number ?? 0) - (b.number ?? 0));
      return toolResult(filtered.map((issue: Rec) => issueView(issue)));
    }
    case 'create_pull_request': {
      const repo = await repoFor(store, args);
      if (repo === null) return toolFailure('Not Found: the repository does not exist');
      // The REST surface refuses a pull request whose head or base branch does not exist (422);
      // the tool answers the same way instead of recording a pull request with no commits.
      if (branchTip(repo.git, String(args.head)) === null || branchTip(repo.git, String(args.base)) === null) {
        return toolFailure('Validation Failed: head or base branch does not exist');
      }
      try {
        const pull = await store.addPull(repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : undefined,
          headRef: String(args.head),
          baseRef: String(args.base),
        });
        return toolResult(pullView(pull));
      } catch (err) {
        return toolFailure(err instanceof Error ? err.message : String(err));
      }
    }
    case 'merge_pull_request': {
      const repo = await repoFor(store, args);
      if (repo === null) return toolFailure('Not Found: the repository does not exist');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const issue = repo.issues instanceof Map ? repo.issues.get(number) : undefined;
      if (!isRecord(issue) || !issue.isPull) return toolFailure('Not Found: the pull request does not exist');
      // The REST merge answers 405 for a pull request that is already merged or closed; the
      // tool surfaces the same refusal instead of reporting a second, phantom merge.
      if ((issue.pull as Rec)?.merged === true) return toolFailure('Pull Request is not mergeable: already merged');
      if (issue.state === 'closed') return toolFailure('Pull Request is not mergeable: closed');
      try {
        squashMerge(store, repo, issue);
      } catch (err) {
        return toolFailure(err instanceof Error ? err.message : String(err));
      }
      return toolResult(pullView(issue));
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// JSON-RPC dispatch and the HTTP handler. Authentication was enforced before dispatch. A body that is
// not JSON is HTTP 400 with -32700; every other answer is HTTP 200 application/json, except
// notifications, which are a bare 202.
// ---------------------------------------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): Rec {
  return { jsonrpc: '2.0', id, result };
}

function rpcFailure(id: unknown, code: number, message: string): Rec {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function dispatch(store: any, method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'server/discover':
      return DISCOVER_RESULT;
    case 'initialize': {
      const requested = isRecord(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return { protocolVersion: chosen, capabilities: CAPABILITIES, serverInfo: SERVER_INFO };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return callTool(store, params);
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

/** One request object to its response object, or null for a notification (no answer is owed). */
async function handleRpcMessage(store: any, message: Rec): Promise<Rec | null> {
  const method = typeof message.method === 'string' ? message.method : '';
  if (!('id' in message)) {
    // A notification (notifications/initialized and friends): accepted, never answered.
    return null;
  }
  const id = message.id ?? null;
  if (method === '') return rpcFailure(id, -32600, 'Invalid Request: no method');
  try {
    const result = await dispatch(store, method, message.params);
    return rpcResult(id, result);
  } catch (err) {
    if (err instanceof RpcError) return rpcFailure(id, err.code, err.message);
    return rpcFailure(id, -32603, err instanceof Error ? err.message : String(err));
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: any, url: URL): Promise<boolean> {
  if (url.pathname !== '/mcp') return false;
  const requestId = nextRequestId();
  if (req.method === 'DELETE') {
    // Session termination: the endpoint is stateless, so there is nothing to forget; acknowledge.
    sendJson(res, 200, {}, requestId);
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, rpcFailure(null, -32601, 'Method not found: the MCP endpoint answers POST'), requestId);
    return true;
  }
  const raw = await readBody(req);
  const text = typeof raw === 'string' ? raw : Buffer.from(raw as any).toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    sendJson(res, 400, rpcFailure(null, -32700, 'Parse error'), requestId);
    return true;
  }
  if (Array.isArray(body)) {
    const responses: Rec[] = [];
    for (const entry of body) {
      if (!isRecord(entry)) {
        responses.push(rpcFailure(null, -32600, 'Invalid Request'));
        continue;
      }
      const response = await handleRpcMessage(store, entry);
      if (response !== null) responses.push(response);
    }
    if (responses.length === 0) {
      res.writeHead(202, { 'x-github-request-id': requestId });
      res.end();
      return true;
    }
    sendJson(res, 200, responses, requestId);
    return true;
  }
  if (!isRecord(body)) {
    sendJson(res, 200, rpcFailure(null, -32600, 'Invalid Request'), requestId);
    return true;
  }
  const response = await handleRpcMessage(store, body);
  if (response === null) {
    res.writeHead(202, { 'x-github-request-id': requestId });
    res.end();
    return true;
  }
  sendJson(res, 200, response, requestId);
  return true;
}
