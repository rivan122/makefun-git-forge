// GraphQL v4 for the forge: a small, real GraphQL engine (lexer, parser, schema validation, executor)
// plus the schema and resolvers for the documents gh and github-mcp-server send to POST /api/graphql.
//
// POSTed bodies are either one operation object {query, variables?, operationName?} or a JSON array of
// them (GitHub's operation batching), answered by one envelope per operation, in order. A GraphQL-level
// failure (an unknown field, a bad argument) is HTTP 200 with an `errors` array; an unknown repository is
// data.repository = null with no errors. Global ids are base64 of "Type:<store id>" and round-trip
// through node(id:) and every id argument. Nothing here reads a clock or a random source: timestamps and
// ids come from the store, so a replayed trial sees byte-identical answers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { b64, unb64, readBody, sendJson, nextRequestId } from './util.ts';
import { VIEWER } from './store.ts';

// ---------------------------------------------------------------------------------------------------------
// Small shared helpers (record shapes are normalized defensively: the store is the contract, not a class).
// ---------------------------------------------------------------------------------------------------------

type Rec = Record<string, any>;

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loginOf(user: unknown): string {
  if (typeof user === 'string' && user !== '') return user;
  if (isRecord(user) && typeof user.login === 'string') return user.login;
  return VIEWER.login;
}

/** The GraphQL global id for one stored object: base64 of "Type:<id>". */
function globalId(type: string, id: unknown): string {
  return b64(Buffer.from(`${type}:${String(id)}`, 'utf8'));
}

/** Decode a global id into its type and store id, or null when it is not one of ours. */
function parseGlobalId(raw: unknown): { type: string; id: string } | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let text = raw;
  try {
    text = unb64(raw).toString('utf8');
  } catch {
    text = raw;
  }
  const match = /^([A-Za-z]+):(.+)$/.exec(text);
  if (match === null) return null;
  return { type: match[1]!, id: match[2]! };
}

// ---------------------------------------------------------------------------------------------------------
// The git object store, read defensively (Agent A's gitdb is the contract: refs, load, commit, tree,
// flattenTree, isAncestor, mergeBase; write verbs are duck-typed so a merge can persist when they exist).
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

/** flattenTree(treeSha) normalized to a path -> blob sha map, whatever shape gitdb returns. */
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

/** Paths whose blob differs between two flat trees (added, changed or removed), sorted. */
function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set<string>();
  for (const [path, sha] of after) if (before.get(path) !== sha) paths.add(path);
  for (const path of before.keys()) if (!after.has(path)) paths.add(path);
  return [...paths].sort();
}

/** The paths a pull request changes: merge-base tree against head tree. */
function pullRequestPaths(repo: Rec, pull: Rec): string[] {
  const git = repo.git;
  const headSha = branchTip(git, String(pull.headRef ?? '')) ?? (typeof pull.headSha === 'string' ? pull.headSha : null);
  const baseSha = branchTip(git, String(pull.baseRef ?? '')) ?? (typeof pull.baseSha === 'string' ? pull.baseSha : null);
  const base = gitMergeBase(git, baseSha, headSha) ?? baseSha;
  return changedPaths(treeOfCommit(git, base), treeOfCommit(git, headSha));
}

/** MERGEABLE / CONFLICTING from a three-way tree comparison; UNKNOWN when the git store cannot say. */
function pullRequestMergeable(repo: Rec, pull: Rec): string {
  const git = repo.git;
  if (!git) return 'UNKNOWN';
  const headSha = branchTip(git, String(pull.headRef ?? '')) ?? (typeof pull.headSha === 'string' ? pull.headSha : null);
  const baseSha = branchTip(git, String(pull.baseRef ?? '')) ?? (typeof pull.baseSha === 'string' ? pull.baseSha : null);
  if (headSha === null || baseSha === null) return 'UNKNOWN';
  const base = gitMergeBase(git, baseSha, headSha);
  if (base === null) return 'UNKNOWN';
  const baseTree = treeOfCommit(git, base);
  const headTree = treeOfCommit(git, headSha);
  const tipTree = treeOfCommit(git, baseSha);
  for (const path of changedPaths(baseTree, headTree)) {
    const tipValue = tipTree.get(path);
    const baseValue = baseTree.get(path);
    const headValue = headTree.get(path);
    if (tipValue !== baseValue && tipValue !== headValue) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// --- git writes, duck-typed: a merge persists when gitdb offers write verbs, and degrades to a
// --- record-only merge (merged state on the pull request) when it does not.

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
 * Squash-merge one pull request record: apply the head's changes since the merge base onto the base
 * branch tip as one new commit, move the base ref, and mark the record merged. When the git store has
 * no write verbs the record still merges (its merge commit is the head tip), which is the state every
 * surface reads. Throws an Error with a human message on a real conflict.
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
// The schema: type and field definitions the validator walks and __type describes. Field type strings
// use GraphQL notation ("String!", "[Issue!]") and are parsed into __Type wrappers for introspection.
// ---------------------------------------------------------------------------------------------------------

interface FieldDef {
  type: string;
  args?: Record<string, string>;
}

interface TypeDef {
  kind: 'OBJECT' | 'INTERFACE' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  fields?: Record<string, FieldDef>;
  values?: string[];
  inputs?: Record<string, string>;
}

const SCHEMA: Record<string, TypeDef> = {
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User!' },
      repository: { type: 'Repository', args: { owner: 'String!', name: 'String!' } },
      node: { type: 'Node', args: { id: 'ID!' } },
      search: { type: 'SearchResultItemConnection!', args: { query: 'String!', type: 'SearchType!', first: 'Int', after: 'String' } },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: 'CreateIssuePayload', args: { input: 'CreateIssueInput!' } },
      closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput!' } },
      createPullRequest: { type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput!' } },
      mergePullRequest: { type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput!' } },
      addComment: { type: 'AddCommentPayload', args: { input: 'AddCommentInput!' } },
    },
  },
  Node: { kind: 'INTERFACE', fields: { id: { type: 'ID!' } } },
  User: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      login: { type: 'String!' },
      name: { type: 'String' },
      email: { type: 'String' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      prefix: { type: 'String!' },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int!' },
      name: { type: 'String!' },
      nameWithOwner: { type: 'String!' },
      owner: { type: 'User!' },
      description: { type: 'String' },
      isPrivate: { type: 'Boolean!' },
      defaultBranchRef: { type: 'Ref' },
      viewerPermission: { type: 'RepositoryPermission!' },
      hasIssuesEnabled: { type: 'Boolean!' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      issue: { type: 'Issue', args: { number: 'Int!' } },
      issues: {
        type: 'IssueConnection!',
        args: { first: 'Int', after: 'String', last: 'Int', before: 'String', states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]' },
      },
      pullRequest: { type: 'PullRequest', args: { number: 'Int!' } },
      pullRequests: {
        type: 'PullRequestConnection!',
        args: { first: 'Int', after: 'String', last: 'Int', before: 'String', states: '[PullRequestState!]' },
      },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      state: { type: 'IssueState!' },
      body: { type: 'String' },
      author: { type: 'User' },
      repository: { type: 'Repository!' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      closedAt: { type: 'DateTime' },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      body: { type: 'String' },
      state: { type: 'PullRequestState!' },
      merged: { type: 'Boolean!' },
      mergedAt: { type: 'DateTime' },
      mergeable: { type: 'MergeableState!' },
      headRefName: { type: 'String!' },
      baseRefName: { type: 'String!' },
      author: { type: 'User' },
      repository: { type: 'Repository!' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      closedAt: { type: 'DateTime' },
      files: { type: 'PullRequestChangedFileConnection', args: { first: 'Int', after: 'String' } },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      body: { type: 'String!' },
      author: { type: 'User' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean!' },
      hasPreviousPage: { type: 'Boolean!' },
      startCursor: { type: 'String' },
      endCursor: { type: 'String' },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Issue]' },
      edges: { type: '[IssueEdge]' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  IssueEdge: { kind: 'OBJECT', fields: { node: { type: 'Issue' }, cursor: { type: 'String!' } } },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequest]' },
      edges: { type: '[PullRequestEdge]' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  PullRequestEdge: { kind: 'OBJECT', fields: { node: { type: 'PullRequest' }, cursor: { type: 'String!' } } },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequestChangedFile]' },
      edges: { type: '[PullRequestChangedFileEdge]' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  PullRequestChangedFileEdge: { kind: 'OBJECT', fields: { node: { type: 'PullRequestChangedFile' }, cursor: { type: 'String!' } } },
  PullRequestChangedFile: { kind: 'OBJECT', fields: { path: { type: 'String!' } } },
  SearchResultItemConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[SearchResultItem]' },
      edges: { type: '[SearchResultItemEdge]' },
      pageInfo: { type: 'PageInfo!' },
      issueCount: { type: 'Int!' },
    },
  },
  SearchResultItemEdge: { kind: 'OBJECT', fields: { node: { type: 'SearchResultItem' }, cursor: { type: 'String!' } } },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } } },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: { commentEdge: { type: 'IssueCommentEdge' }, subject: { type: 'Node' }, clientMutationId: { type: 'String' } },
  },
  IssueCommentEdge: { kind: 'OBJECT', fields: { node: { type: 'IssueComment' }, cursor: { type: 'String!' } } },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', values: ['DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'] },
  IssueOrder: { kind: 'INPUT_OBJECT', inputs: { field: 'IssueOrderField!', direction: 'OrderDirection!' } },
  CreateIssueInput: { kind: 'INPUT_OBJECT', inputs: { repositoryId: 'ID!', title: 'String!', body: 'String', clientMutationId: 'String' } },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputs: { issueId: 'ID!', stateReason: 'String', clientMutationId: 'String' } },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputs: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', draft: 'Boolean', clientMutationId: 'String' },
  },
  MergePullRequestInput: { kind: 'INPUT_OBJECT', inputs: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', clientMutationId: 'String' } },
  AddCommentInput: { kind: 'INPUT_OBJECT', inputs: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' } },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      kind: { type: 'String!' },
      description: { type: 'String' },
      fields: { type: '[__Field]', args: { includeDeprecated: 'Boolean' } },
      enumValues: { type: '[__EnumValue]', args: { includeDeprecated: 'Boolean' } },
      possibleTypes: { type: '[__Type]' },
      inputFields: { type: '[__InputValue]' },
      ofType: { type: '__Type' },
      specifiedByURL: { type: 'String' },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      args: { type: '[__InputValue!]!' },
      type: { type: '__Type!' },
      isDeprecated: { type: 'Boolean!' },
      deprecationReason: { type: 'String' },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: { name: { type: 'String!' }, description: { type: 'String' }, isDeprecated: { type: 'Boolean!' }, deprecationReason: { type: 'String' } },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: { name: { type: 'String!' }, description: { type: 'String' }, type: { type: '__Type!' }, defaultValue: { type: 'String' } },
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      types: { type: '[__Type!]!' },
      queryType: { type: '__Type!' },
      mutationType: { type: '__Type' },
      subscriptionType: { type: '__Type' },
      directives: { type: '[__Directive!]!' },
    },
  },
  __Directive: {
    kind: 'OBJECT',
    fields: { name: { type: 'String!' }, description: { type: 'String' }, locations: { type: '[String!]!' }, args: { type: '[__InputValue!]!' } },
  },
};

/** The union SearchResultItem's members, for __Type.possibleTypes and fragment validation. */
const SEARCH_RESULT_TYPES = ['Issue', 'PullRequest', 'Repository', 'User'];
SCHEMA['SearchResultItem'] = { kind: 'INTERFACE', fields: { id: { type: 'ID!' } } };

/** A __Type reference parsed from a type string: a named type, or a LIST / NON_NULL wrapper. */
interface TypeRef {
  name: string | null;
  wrapper: 'LIST' | 'NON_NULL' | null;
  ofType: TypeRef | null;
}

function parseTypeRef(text: string): TypeRef {
  const trimmed = text.trim();
  if (trimmed.endsWith('!')) return { name: null, wrapper: 'NON_NULL', ofType: parseTypeRef(trimmed.slice(0, -1)) };
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return { name: null, wrapper: 'LIST', ofType: parseTypeRef(trimmed.slice(1, -1)) };
  return { name: trimmed, wrapper: null, ofType: null };
}

function namedTypeOf(text: string): string {
  return text.replace(/[[\]!]/g, '');
}

/** A runtime source value tagged with the GraphQL type it executes as. */
interface Src {
  t: string;
  v: any;
}

function src(t: string, v: any): Src {
  return { t, v };
}

function typeRefSrc(ref: TypeRef): Src {
  return src('__Type', { ref });
}

function namedTypeSrc(name: string): Src {
  return src('__Type', { ref: { name, wrapper: null, ofType: null } });
}

// ---------------------------------------------------------------------------------------------------------
// The lexer and parser: operations, variable definitions, fragments, inline fragments, directives and
// every value kind (variables, ints, floats, strings, block strings, booleans, null, enums, lists,
// objects). Enough of the language for the documents gh and github-mcp-server send, parsed for real.
// ---------------------------------------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
  value: string;
}

class GqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GqlError';
  }
}

function lex(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < text.length) {
    const c = text[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (text.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (text.startsWith('"""', i)) {
        const end = text.indexOf('"""', i + 3);
        if (end < 0) throw new GqlError('unterminated block string');
        tokens.push({ kind: 'string', value: text.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          const esc = text[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(text.slice(j + 2, j + 6), 16));
            j += 4;
          } else throw new GqlError(`invalid escape \\${esc ?? ''} in string`);
          j += 2;
          continue;
        }
        value += text[j];
        j += 1;
      }
      if (j >= text.length) throw new GqlError('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < text.length && isNameChar(text[j]!)) j += 1;
      tokens.push({ kind: 'name', value: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (text[j] === '-') j += 1;
      while (j < text.length && /[0-9]/.test(text[j]!)) j += 1;
      let kind: Token['kind'] = 'int';
      if (text[j] === '.') {
        kind = 'float';
        j += 1;
        while (j < text.length && /[0-9]/.test(text[j]!)) j += 1;
      }
      if (text[j] === 'e' || text[j] === 'E') {
        kind = 'float';
        j += 1;
        if (text[j] === '+' || text[j] === '-') j += 1;
        while (j < text.length && /[0-9]/.test(text[j]!)) j += 1;
      }
      tokens.push({ kind, value: text.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlError(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// --- the AST

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface DirectiveNode {
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
}

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string; directives: DirectiveNode[] }
  | { kind: 'inlineFragment'; typeCondition: string | null; directives: DirectiveNode[]; selectionSet: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expect(kind: Token['kind'], value?: string): Token {
    const token = this.next();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new GqlError(`expected ${value ?? kind}, found ${token.kind} ${JSON.stringify(token.value)}`);
    }
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private eatPunct(value: string): boolean {
    if (!this.atPunct(value)) return false;
    this.pos += 1;
    return true;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new GqlError(`unexpected ${token.kind} ${JSON.stringify(token.value)} at the top level`);
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({ operation: token.value, name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expect('name').value;
        const on = this.expect('name');
        if (on.value !== 'on') throw new GqlError(`expected "on" in a fragment definition, found ${JSON.stringify(on.value)}`);
        const typeCondition = this.expect('name').value;
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new GqlError(`unexpected definition ${JSON.stringify(token.value)}`);
    }
    if (operations.length === 0) throw new GqlError('the document holds no operation');
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    if (!this.eatPunct('(')) return;
    while (!this.atPunct(')')) {
      this.expect('punct', '$');
      this.expect('name');
      this.expect('punct', ':');
      this.parseType();
      if (this.eatPunct('=')) this.parseValue();
      this.parseDirectives();
    }
    this.expect('punct', ')');
  }

  private parseType(): void {
    if (this.eatPunct('[')) {
      this.parseType();
      this.expect('punct', ']');
    } else {
      this.expect('name');
    }
    this.eatPunct('!');
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.atPunct('@')) {
      this.next();
      const name = this.expect('name').value;
      directives.push({ name, args: this.parseArguments() });
    }
    return directives;
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!this.eatPunct('(')) return args;
    while (!this.atPunct(')')) {
      const name = this.expect('name').value;
      this.expect('punct', ':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect('punct', ')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expect('name').value };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expect('punct', ']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.atPunct('}')) {
        const name = this.expect('name').value;
        this.expect('punct', ':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('punct', '}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GqlError(`unexpected value token ${token.kind} ${JSON.stringify(token.value)}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('punct', '{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) selections.push(this.parseSelection());
    this.expect('punct', '}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expect('name').value;
        const directives = this.parseDirectives();
        return { kind: 'inlineFragment', typeCondition, directives, selectionSet: this.parseSelectionSet() };
      }
      if (this.atPunct('@')) {
        const directives = this.parseDirectives();
        return { kind: 'inlineFragment', typeCondition: null, directives, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expect('name').value;
      const directives = this.parseDirectives();
      return { kind: 'fragmentSpread', name, directives };
    }
    const first = this.expect('name').value;
    let alias: string | null = null;
    let name = first;
    if (this.eatPunct(':')) {
      alias = first;
      name = this.expect('name').value;
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, directives, selectionSet };
  }
}

/** Coerce one AST value against the request's variables into a plain JS value. */
function coerceValue(node: ValueNode, variables: Rec): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => coerceValue(value, variables));
    case 'object': {
      const out: Rec = {};
      for (const field of node.fields) out[field.name] = coerceValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Validation: every selected field must exist on its type (introspection fields included), fragments
// must name known types. The one check that sends an invalid field expects HTTP 200 with the errors
// array naming it, which is exactly what a validation failure produces.
// ---------------------------------------------------------------------------------------------------------

function validateSelections(typeName: string, selections: SelectionNode[], doc: DocumentNode, errors: Array<{ message: string }>): void {
  const def = SCHEMA[typeName];
  if (def === undefined) {
    errors.push({ message: `Unknown type "${typeName}".` });
    return;
  }
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      if (typeName === 'Query' && (selection.name === '__type' || selection.name === '__schema')) {
        if (selection.selectionSet !== null) validateSelections(selection.name === '__type' ? '__Type' : '__Schema', selection.selectionSet, doc, errors);
        continue;
      }
      const fieldDef = def.fields?.[selection.name];
      if (fieldDef === undefined) {
        errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
        continue;
      }
      if (selection.selectionSet !== null) validateSelections(namedTypeOf(fieldDef.type), selection.selectionSet, doc, errors);
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      const condition = selection.typeCondition ?? typeName;
      if (SCHEMA[condition] === undefined) {
        errors.push({ message: `Unknown type "${condition}".` });
        continue;
      }
      validateSelections(condition, selection.selectionSet, doc, errors);
      continue;
    }
    const fragment = doc.fragments.get(selection.name);
    if (fragment === undefined) {
      errors.push({ message: `Unknown fragment "${selection.name}".` });
      continue;
    }
    validateSelections(fragment.typeCondition, fragment.selectionSet, doc, errors);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Store access: find the viewer's repositories, issues and pull requests by their store ids.
// ---------------------------------------------------------------------------------------------------------

async function viewerRepos(store: any): Promise<Rec[]> {
  const repos = await store.listRepos(VIEWER.login);
  return Array.isArray(repos) ? repos : [];
}

async function findRepoById(store: any, id: string): Promise<Rec | null> {
  for (const repo of await viewerRepos(store)) {
    if (String(repo.id) === id) return repo;
  }
  return null;
}

async function findIssueById(store: any, id: string, wantPull: boolean | null): Promise<{ repo: Rec; issue: Rec } | null> {
  for (const repo of await viewerRepos(store)) {
    const issues = repo.issues instanceof Map ? [...repo.issues.values()] : [];
    for (const issue of issues) {
      if (String(issue.id) !== id) continue;
      if (wantPull === true && !issue.isPull) continue;
      if (wantPull === false && issue.isPull) continue;
      return { repo, issue };
    }
  }
  return null;
}

/** The wrapped sources the executor carries. */
function userSrc(user?: unknown): Src {
  return src('User', user ?? VIEWER);
}

function repoSrc(repo: Rec): Src {
  return src('Repository', repo);
}

function issueSrc(repo: Rec, issue: Rec): Src {
  return src('Issue', { repo, issue });
}

function pullSrc(repo: Rec, issue: Rec): Src {
  return src('PullRequest', { repo, issue });
}

function commentSrc(repo: Rec, issue: Rec, comment: Rec): Src {
  return src('IssueComment', { repo, issue, comment });
}

// ---------------------------------------------------------------------------------------------------------
// Connections: order, filter and page an already-materialized list with Relay cursors. A cursor is
// base64 of "cursor:<store id>", so a page boundary names the last node served, not a position.
// ---------------------------------------------------------------------------------------------------------

function cursorOf(id: unknown): string {
  return b64(Buffer.from(`cursor:${String(id)}`, 'utf8'));
}

interface Page<T> {
  items: T[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
  totalCount: number;
}

function pageOf<T extends { cursorId: unknown }>(items: T[], args: Rec): Page<T> {
  let start = 0;
  let end = items.length;
  if (typeof args.after === 'string' && args.after !== '') {
    const parsed = parseGlobalId(args.after);
    const wanted = parsed !== null && parsed.type === 'cursor' ? parsed.id : null;
    if (wanted !== null) {
      const index = items.findIndex((item) => String(item.cursorId) === wanted);
      if (index >= 0) start = index + 1;
    }
  }
  if (typeof args.before === 'string' && args.before !== '') {
    const parsed = parseGlobalId(args.before);
    const wanted = parsed !== null && parsed.type === 'cursor' ? parsed.id : null;
    if (wanted !== null) {
      const index = items.findIndex((item) => String(item.cursorId) === wanted);
      if (index >= 0) end = index;
    }
  }
  let slice = items.slice(start, end);
  let hasNextPage = false;
  let hasPreviousPage = start > 0;
  if (typeof args.first === 'number' && Number.isFinite(args.first)) {
    const first = Math.max(0, Math.trunc(args.first));
    if (slice.length > first) hasNextPage = true;
    slice = slice.slice(0, first);
  }
  if (typeof args.last === 'number' && Number.isFinite(args.last)) {
    const last = Math.max(0, Math.trunc(args.last));
    if (slice.length > last) hasPreviousPage = true;
    slice = slice.slice(slice.length - last);
  }
  return {
    items: slice,
    hasNextPage,
    hasPreviousPage,
    startCursor: slice.length > 0 ? cursorOf(slice[0]!.cursorId) : null,
    endCursor: slice.length > 0 ? cursorOf(slice[slice.length - 1]!.cursorId) : null,
    totalCount: items.length,
  };
}

function connectionSrc(type: string, page: Page<{ cursorId: unknown; node: Src }>): Src {
  const edgeType = type === 'IssueConnection' ? 'IssueEdge' : type === 'PullRequestConnection' ? 'PullRequestEdge' : 'PullRequestChangedFileEdge';
  return src(type, {
    nodes: page.items.map((item) => item.node),
    edges: page.items.map((item) => src(edgeType, { node: item.node, cursor: cursorOf(item.cursorId) })),
    pageInfo: src('PageInfo', {
      hasNextPage: page.hasNextPage,
      hasPreviousPage: page.hasPreviousPage,
      startCursor: page.startCursor,
      endCursor: page.endCursor,
    }),
    totalCount: page.totalCount,
  });
}

/** Sort issue records by an orderBy (default CREATED_AT ASC), ties broken by number in the same direction. */
function orderIssues(issues: Rec[], orderBy: unknown): Rec[] {
  const order = isRecord(orderBy) ? orderBy : {};
  const field = typeof order.field === 'string' ? order.field : 'CREATED_AT';
  const direction = typeof order.direction === 'string' ? order.direction : 'ASC';
  const keyOf = (issue: Rec): string | number => {
    if (field === 'UPDATED_AT') return String(issue.updated_at ?? '');
    if (field === 'COMMENTS') return Array.isArray(issue.comments) ? issue.comments.length : 0;
    return String(issue.created_at ?? '');
  };
  const sorted = [...issues];
  sorted.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    let cmp = 0;
    if (typeof ka === 'number' && typeof kb === 'number') cmp = ka - kb;
    else cmp = String(ka) < String(kb) ? -1 : String(ka) > String(kb) ? 1 : 0;
    if (cmp === 0) cmp = (a.number ?? 0) - (b.number ?? 0);
    return direction === 'DESC' ? -cmp : cmp;
  });
  return sorted;
}

function issueStateOf(issue: Rec): string {
  return String(issue.state ?? 'open').toUpperCase();
}

function pullStateOf(issue: Rec): string {
  if (isRecord(issue.pull) && issue.pull.merged === true) return 'MERGED';
  return issueStateOf(issue);
}

// ---------------------------------------------------------------------------------------------------------
// Resolvers. A resolver answers one field of one wrapped source; the executor below walks selection
// sets over whatever comes back (wrapped sources, plain objects, arrays, scalars).
// ---------------------------------------------------------------------------------------------------------

interface ExecCtx {
  store: any;
  variables: Rec;
  doc: DocumentNode;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

async function resolveField(ctx: ExecCtx, typeName: string, source: Src, field: FieldNode, args: Rec): Promise<unknown> {
  const { store } = ctx;
  const v = source.v;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return userSrc();
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER.login) return null;
        const repo = await store.getRepo(owner, name);
        return isRecord(repo) ? repoSrc(repo) : null;
      }
      if (field.name === 'node') return resolveNode(ctx, args.id);
      if (field.name === 'search') {
        const query = String(args.query ?? '');
        const type = typeof args.type === 'string' ? args.type : 'ISSUE';
        return searchSrc(ctx, query, type, args);
      }
      return null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') return mutateCreateIssue(ctx, args.input);
      if (field.name === 'closeIssue') return mutateCloseIssue(ctx, args.input);
      if (field.name === 'createPullRequest') return mutateCreatePullRequest(ctx, args.input);
      if (field.name === 'mergePullRequest') return mutateMergePullRequest(ctx, args.input);
      if (field.name === 'addComment') return mutateAddComment(ctx, args.input);
      return null;
    }
    case 'User': {
      const user = isRecord(v) ? v : VIEWER;
      if (field.name === 'id') return globalId('User', user.id ?? VIEWER.id);
      if (field.name === 'login') return loginOf(user);
      if (field.name === 'name') return typeof user.name === 'string' ? user.name : null;
      if (field.name === 'email') return typeof user.email === 'string' ? user.email : null;
      // The viewer's account predates the trial: answer the trial's start time without
      // advancing the shared logical clock (a read must not move every later timestamp).
      if (field.name === 'createdAt' || field.name === 'updatedAt') return typeof store.baseIso === 'function' ? store.baseIso() : store.nowIso();
      return null;
    }
    case 'Ref': {
      if (field.name === 'name') return v.name;
      if (field.name === 'prefix') return 'refs/heads/';
      return null;
    }
    // Connections, edges and page info are materialized by their parent resolver: read the property.
    case 'PageInfo':
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'SearchResultItemConnection':
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge':
    case 'SearchResultItemEdge':
    case 'IssueCommentEdge': {
      const value = (v as Rec)[field.name];
      return value === undefined ? null : value;
    }
    case 'Repository': {
      const repo = v as Rec;
      switch (field.name) {
        case 'id':
          return globalId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return typeof repo.full_name === 'string' ? repo.full_name : `${repo.owner}/${repo.name}`;
        case 'owner':
          return userSrc({ ...VIEWER, login: String(repo.owner ?? VIEWER.login) });
        case 'description':
          return typeof repo.description === 'string' ? repo.description : null;
        case 'isPrivate':
          return repo.private === true;
        case 'defaultBranchRef': {
          const branch = String(repo.default_branch ?? 'main');
          const tip = branchTip(repo.git, branch);
          return tip !== null ? src('Ref', { name: branch }) : null;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'createdAt':
          return repo.created_at;
        case 'updatedAt':
          return repo.updated_at;
        case 'issue': {
          const rec = repo.issues instanceof Map ? repo.issues.get(Number(args.number)) : undefined;
          return isRecord(rec) && !rec.isPull ? issueSrc(repo, rec) : null;
        }
        case 'issues': {
          const all = repo.issues instanceof Map ? [...repo.issues.values()].filter((rec: Rec) => !rec.isPull) : [];
          const states = Array.isArray(args.states) ? args.states.map((s: unknown) => String(s).toUpperCase()) : null;
          const filtered = states === null ? all : all.filter((rec: Rec) => states.includes(issueStateOf(rec)));
          const ordered = orderIssues(filtered, args.orderBy);
          const page = pageOf(ordered.map((rec: Rec) => ({ cursorId: rec.id, node: issueSrc(repo, rec) })), args);
          return connectionSrc('IssueConnection', page);
        }
        case 'pullRequest': {
          const rec = repo.issues instanceof Map ? repo.issues.get(Number(args.number)) : undefined;
          return isRecord(rec) && rec.isPull ? pullSrc(repo, rec) : null;
        }
        case 'pullRequests': {
          const all = repo.issues instanceof Map ? [...repo.issues.values()].filter((rec: Rec) => rec.isPull) : [];
          const states = Array.isArray(args.states) ? args.states.map((s: unknown) => String(s).toUpperCase()) : null;
          const filtered = states === null ? all : all.filter((rec: Rec) => states.includes(pullStateOf(rec)));
          const ordered = [...filtered].sort((a: Rec, b: Rec) => (b.number ?? 0) - (a.number ?? 0));
          const page = pageOf(ordered.map((rec: Rec) => ({ cursorId: rec.id, node: pullSrc(repo, rec) })), args);
          return connectionSrc('PullRequestConnection', page);
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const { repo, issue } = v as { repo: Rec; issue: Rec };
      switch (field.name) {
        case 'id':
          return globalId('Issue', issue.id);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueStateOf(issue);
        case 'body':
          return typeof issue.body === 'string' ? issue.body : null;
        case 'author':
          return userSrc(issue.user);
        case 'repository':
          return repoSrc(repo);
        case 'createdAt':
          return issue.created_at;
        case 'updatedAt':
          return issue.updated_at;
        case 'closedAt':
          return issueStateOf(issue) === 'CLOSED' ? issue.updated_at : null;
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const { repo, issue } = v as { repo: Rec; issue: Rec };
      const pull = (issue.pull ?? {}) as Rec;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', issue.id);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return typeof issue.body === 'string' ? issue.body : null;
        case 'state':
          return pullStateOf(issue);
        case 'merged':
          return pull.merged === true;
        case 'mergedAt':
          return typeof pull.mergedAt === 'string' ? pull.mergedAt : null;
        case 'mergeable':
          if (pull.merged === true) return 'MERGEABLE';
          return pullRequestMergeable(repo, pull);
        case 'headRefName':
          return String(pull.headRef ?? '');
        case 'baseRefName':
          return String(pull.baseRef ?? '');
        case 'author':
          return userSrc(issue.user);
        case 'repository':
          return repoSrc(repo);
        case 'createdAt':
          return issue.created_at;
        case 'updatedAt':
          return issue.updated_at;
        case 'closedAt':
          return pullStateOf(issue) !== 'OPEN' ? issue.updated_at : null;
        case 'files': {
          const paths = pullRequestPaths(repo, pull);
          const items = paths.map((path) => ({ cursorId: path, node: src('PullRequestChangedFile', { path }) }));
          return connectionSrc('PullRequestChangedFileConnection', pageOf(items, args));
        }
        default:
          return null;
      }
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return v.path;
      return null;
    }
    case 'IssueComment': {
      const { comment } = v as { comment: Rec };
      switch (field.name) {
        case 'id':
          return globalId('IssueComment', comment.id);
        case 'body':
          return comment.body;
        case 'author':
          return userSrc(comment.user);
        case 'createdAt':
          return comment.created_at;
        case 'updatedAt':
          return comment.updated_at ?? comment.created_at;
        default:
          return null;
      }
    }
    case '__Type': {
      const ref = (v as { ref: TypeRef }).ref;
      switch (field.name) {
        case 'name':
          return ref.name;
        case 'kind': {
          if (ref.wrapper !== null) return ref.wrapper;
          const def = ref.name !== null ? SCHEMA[ref.name] : undefined;
          return def?.kind ?? 'OBJECT';
        }
        case 'description':
          return null;
        case 'fields': {
          if (ref.wrapper !== null || ref.name === null) return null;
          const def = SCHEMA[ref.name];
          if (def === undefined || (def.kind !== 'OBJECT' && def.kind !== 'INTERFACE')) return null;
          return Object.entries(def.fields ?? {}).map(([name, fieldDef]) =>
            src('__Field', { name, type: fieldDef.type, args: fieldDef.args ?? {} }),
          );
        }
        case 'enumValues': {
          if (ref.wrapper !== null || ref.name === null) return null;
          const def = SCHEMA[ref.name];
          if (def === undefined || def.kind !== 'ENUM') return null;
          return (def.values ?? []).map((name) => src('__EnumValue', { name }));
        }
        case 'possibleTypes': {
          if (ref.name === 'Node') return ['Repository', 'User', 'Issue', 'PullRequest', 'IssueComment'].map(namedTypeSrc);
          if (ref.name === 'SearchResultItem') return SEARCH_RESULT_TYPES.map(namedTypeSrc);
          return null;
        }
        case 'inputFields': {
          if (ref.wrapper !== null || ref.name === null) return null;
          const def = SCHEMA[ref.name];
          if (def === undefined || def.kind !== 'INPUT_OBJECT') return null;
          return Object.entries(def.inputs ?? {}).map(([name, type]) => src('__InputValue', { name, type }));
        }
        case 'ofType':
          return ref.ofType !== null ? typeRefSrc(ref.ofType) : null;
        case 'specifiedByURL':
          return null;
        default:
          return null;
      }
    }
    case '__Field': {
      if (field.name === 'name') return v.name;
      if (field.name === 'description') return null;
      if (field.name === 'args') return Object.entries((v.args ?? {}) as Record<string, string>).map(([name, type]) => src('__InputValue', { name, type }));
      if (field.name === 'type') return typeRefSrc(parseTypeRef(String(v.type)));
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      return null;
    }
    case '__EnumValue': {
      if (field.name === 'name') return v.name;
      if (field.name === 'description') return null;
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      return null;
    }
    case '__InputValue': {
      if (field.name === 'name') return v.name;
      if (field.name === 'description') return null;
      if (field.name === 'type') return typeRefSrc(parseTypeRef(String(v.type)));
      if (field.name === 'defaultValue') return null;
      return null;
    }
    case '__Schema': {
      if (field.name === 'types') return Object.keys(SCHEMA).map(namedTypeSrc);
      if (field.name === 'queryType') return namedTypeSrc('Query');
      if (field.name === 'mutationType') return namedTypeSrc('Mutation');
      if (field.name === 'subscriptionType') return null;
      if (field.name === 'directives') return [];
      return null;
    }
    case '__Directive': {
      if (field.name === 'name') return v.name;
      if (field.name === 'description') return null;
      if (field.name === 'locations') return [];
      if (field.name === 'args') return [];
      return null;
    }
    default:
      return null;
  }
}

/** node(id:): decode the global id and wrap the stored object it names. */
async function resolveNode(ctx: ExecCtx, rawId: unknown): Promise<Src | null> {
  const parsed = parseGlobalId(rawId);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = await findRepoById(ctx.store, parsed.id);
    return repo !== null ? repoSrc(repo) : null;
  }
  if (parsed.type === 'User') {
    return String(VIEWER.id) === parsed.id ? userSrc() : null;
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const found = await findIssueById(ctx.store, parsed.id, parsed.type === 'PullRequest' ? true : null);
    if (found === null) return null;
    return found.issue.isPull ? pullSrc(found.repo, found.issue) : issueSrc(found.repo, found.issue);
  }
  if (parsed.type === 'IssueComment') {
    for (const repo of await viewerRepos(ctx.store)) {
      const issues = repo.issues instanceof Map ? [...repo.issues.values()] : [];
      for (const issue of issues) {
        const comments = Array.isArray(issue.comments) ? issue.comments : [];
        for (const comment of comments) {
          if (String(comment.id) === parsed.id) return commentSrc(repo, issue, comment);
        }
      }
    }
    return null;
  }
  return null;
}

/** A minimal search surface: issues (and pull requests) whose title or body mentions the query text. */
async function searchSrc(ctx: ExecCtx, query: string, type: string, args: Rec): Promise<Src> {
  const needle = query.toLowerCase();
  const nodes: Src[] = [];
  if (type === 'ISSUE' || type === 'REPOSITORY' || type === 'USER') {
    for (const repo of await viewerRepos(ctx.store)) {
      if (type === 'REPOSITORY' && String(repo.name).toLowerCase().includes(needle)) nodes.push(repoSrc(repo));
      const issues = repo.issues instanceof Map ? [...repo.issues.values()] : [];
      for (const issue of issues) {
        const text = `${issue.title ?? ''}\n${issue.body ?? ''}`.toLowerCase();
        if (!text.includes(needle)) continue;
        if (type === 'ISSUE') nodes.push(issue.isPull ? pullSrc(repo, issue) : issueSrc(repo, issue));
      }
    }
  }
  const items = nodes.map((node, index) => ({ cursorId: index, node }));
  const page = pageOf(items, args);
  const connection = connectionSrc('PullRequestConnection', page);
  connection.t = 'SearchResultItemConnection';
  connection.v.edges = page.items.map((item) => src('SearchResultItemEdge', { node: item.node, cursor: cursorOf(item.cursorId) }));
  connection.v.issueCount = nodes.length;
  return connection;
}

// ---------------------------------------------------------------------------------------------------------
// Mutations. Each returns the payload as a plain object holding wrapped sources.
// ---------------------------------------------------------------------------------------------------------

function inputObject(input: unknown): Rec {
  return isRecord(input) ? input : {};
}

async function mutateCreateIssue(ctx: ExecCtx, inputRaw: unknown): Promise<Rec> {
  const input = inputObject(inputRaw);
  const parsed = parseGlobalId(input.repositoryId);
  const repo = parsed !== null && parsed.type === 'Repository' ? await findRepoById(ctx.store, parsed.id) : null;
  if (repo === null) throw new GqlError('createIssue: the repository id does not name a repository');
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') throw new GqlError('createIssue: a title is required');
  const issue = await ctx.store.addIssue(repo, { title, body: typeof input.body === 'string' ? input.body : undefined });
  return { issue: issueSrc(repo, issue), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null };
}

async function mutateCloseIssue(ctx: ExecCtx, inputRaw: unknown): Promise<Rec> {
  const input = inputObject(inputRaw);
  const parsed = parseGlobalId(input.issueId);
  const found = parsed !== null ? await findIssueById(ctx.store, parsed.id, null) : null;
  if (found === null) throw new GqlError('closeIssue: the issue id does not name an issue');
  found.issue.state = 'closed';
  found.issue.updated_at = ctx.store.nowIso();
  return { issue: issueSrc(found.repo, found.issue), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null };
}

async function mutateCreatePullRequest(ctx: ExecCtx, inputRaw: unknown): Promise<Rec> {
  const input = inputObject(inputRaw);
  const parsed = parseGlobalId(input.repositoryId);
  const repo = parsed !== null && parsed.type === 'Repository' ? await findRepoById(ctx.store, parsed.id) : null;
  if (repo === null) throw new GqlError('createPullRequest: the repository id does not name a repository');
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') throw new GqlError('createPullRequest: a title is required');
  const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
  const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  if (headRef === '' || baseRef === '') throw new GqlError('createPullRequest: headRefName and baseRefName are required');
  // GitHub refuses a pull request whose head or base ref does not exist; the REST surface
  // answers 422 for the same input, so the mutation errors instead of recording a phantom.
  if (branchTip(repo.git, headRef) === null) throw new GqlError('createPullRequest: head ref does not exist');
  if (branchTip(repo.git, baseRef) === null) throw new GqlError('createPullRequest: base ref does not exist');
  const pull = await ctx.store.addPull(repo, { title, body: typeof input.body === 'string' ? input.body : undefined, headRef, baseRef });
  return { pullRequest: pullSrc(repo, pull), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null };
}

async function mutateMergePullRequest(ctx: ExecCtx, inputRaw: unknown): Promise<Rec> {
  const input = inputObject(inputRaw);
  const parsed = parseGlobalId(input.pullRequestId);
  const found = parsed !== null ? await findIssueById(ctx.store, parsed.id, true) : null;
  if (found === null) throw new GqlError('mergePullRequest: the pull request id does not name a pull request');
  if (!(found.issue.pull as Rec)?.merged) squashMerge(ctx.store, found.repo, found.issue);
  return { pullRequest: pullSrc(found.repo, found.issue), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null };
}

async function mutateAddComment(ctx: ExecCtx, inputRaw: unknown): Promise<Rec> {
  const input = inputObject(inputRaw);
  const parsed = parseGlobalId(input.subjectId);
  const found = parsed !== null ? await findIssueById(ctx.store, parsed.id, null) : null;
  if (found === null) throw new GqlError('addComment: the subject id does not name an issue or pull request');
  const body = typeof input.body === 'string' ? input.body : '';
  if (body === '') throw new GqlError('addComment: a body is required');
  const issue = found.issue;
  if (!Array.isArray(issue.comments)) issue.comments = [];
  let maxId = 0;
  for (const comment of issue.comments as Rec[]) {
    if (typeof comment.id === 'number' && comment.id > maxId) maxId = comment.id;
  }
  const now = ctx.store.nowIso();
  const comment: Rec = {
    id: typeof ctx.store.nextCommentId === 'function' ? ctx.store.nextCommentId() : maxId + 1,
    body,
    user: { id: VIEWER.id, login: VIEWER.login, name: VIEWER.name, email: VIEWER.email, type: 'User' },
    created_at: now,
    updated_at: now,
  };
  issue.comments.push(comment);
  issue.updated_at = now;
  const node = commentSrc(found.repo, issue, comment);
  return {
    commentEdge: src('IssueCommentEdge', { node, cursor: cursorOf(comment.id) }),
    subject: issue.isPull ? pullSrc(found.repo, issue) : issueSrc(found.repo, issue),
    clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The executor: collect fields (fragments merged, @skip/@include honored), resolve each against its
// type, and shape the answer to the selection. Resolver failures land in `errors` with their path and
// null the field, the way GitHub reports them.
// ---------------------------------------------------------------------------------------------------------

interface CollectedField {
  node: FieldNode;
  typeCondition: string | null;
}

function directiveAllows(ctx: ExecCtx, directives: DirectiveNode[]): boolean {
  for (const directive of directives) {
    const ifArg = directive.args.find((arg) => arg.name === 'if');
    const value = ifArg !== undefined ? coerceValue(ifArg.value, ctx.variables) : undefined;
    if (directive.name === 'skip' && value === true) return false;
    if (directive.name === 'include' && value === false) return false;
  }
  return true;
}

function collectFields(ctx: ExecCtx, typeName: string, selections: SelectionNode[], visited: Set<string>, out: CollectedField[]): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (directiveAllows(ctx, selection.directives)) out.push({ node: selection, typeCondition: typeName });
      continue;
    }
    if (!directiveAllows(ctx, selection.directives)) continue;
    if (selection.kind === 'inlineFragment') {
      collectFields(ctx, selection.typeCondition ?? typeName, selection.selectionSet, visited, out);
      continue;
    }
    if (visited.has(selection.name)) continue;
    visited.add(selection.name);
    const fragment = ctx.doc.fragments.get(selection.name);
    if (fragment !== undefined) collectFields(ctx, fragment.typeCondition, fragment.selectionSet, visited, out);
  }
}

/** The concrete type a wrapped source executes as under a fragment condition, or null when it does not apply. */
function fragmentApplies(sourceType: string, condition: string | null): boolean {
  if (condition === null) return true;
  if (condition === sourceType) return true;
  if (condition === 'Node') return ['Repository', 'User', 'Issue', 'PullRequest', 'IssueComment'].includes(sourceType);
  if (condition === 'SearchResultItem') return SEARCH_RESULT_TYPES.includes(sourceType);
  return false;
}

async function executeSelectionSet(ctx: ExecCtx, typeName: string, source: unknown, selections: SelectionNode[], path: Array<string | number>): Promise<Rec> {
  const out: Rec = {};
  const fields: CollectedField[] = [];
  collectFields(ctx, typeName, selections, new Set(), fields);
  const sourceType = isSrc(source) ? source.t : typeName;
  for (const { node, typeCondition } of fields) {
    const responseKey = node.alias ?? node.name;
    if (!fragmentApplies(sourceType, typeCondition)) continue;
    if (node.name === '__typename') {
      out[responseKey] = sourceType;
      continue;
    }
    if (typeName === 'Query' && node.name === '__type') {
      const args = argsOf(ctx, node);
      const name = typeof args.name === 'string' ? args.name : '';
      out[responseKey] = await completeValue(ctx, '__Type', SCHEMA[name] !== undefined ? namedTypeSrc(name) : null, node, [...path, responseKey]);
      continue;
    }
    if (typeName === 'Query' && node.name === '__schema') {
      out[responseKey] = await completeValue(ctx, '__Schema', src('__Schema', {}), node, [...path, responseKey]);
      continue;
    }
    const args = argsOf(ctx, node);
    let value: unknown;
    try {
      value = await resolveSourceField(ctx, typeName, source, node, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, responseKey] });
      value = null;
    }
    const fieldDef = SCHEMA[sourceType]?.fields?.[node.name] ?? SCHEMA[typeName]?.fields?.[node.name];
    const named = fieldDef !== undefined ? namedTypeOf(fieldDef.type) : null;
    out[responseKey] = await completeValue(ctx, named, value, node, [...path, responseKey]);
  }
  return out;
}

function isSrc(value: unknown): value is Src {
  return isRecord(value) && typeof (value as Src).t === 'string' && 'v' in (value as Src);
}

function argsOf(ctx: ExecCtx, node: FieldNode): Rec {
  const args: Rec = {};
  for (const arg of node.args) args[arg.name] = coerceValue(arg.value, ctx.variables);
  return args;
}

/** Resolve one field on a wrapped source (typed resolver) or a plain object (property read). */
async function resolveSourceField(ctx: ExecCtx, typeName: string, source: unknown, node: FieldNode, args: Rec): Promise<unknown> {
  if (isSrc(source)) return resolveField(ctx, source.t, source, node, args);
  if (isRecord(source)) {
    const value = source[node.name];
    return typeof value === 'function' ? value(args) : value;
  }
  return null;
}

/** Shape a resolved value to the field's selection: recurse into objects, map over lists. */
async function completeValue(ctx: ExecCtx, namedType: string | null, value: unknown, node: FieldNode, path: Array<string | number>): Promise<unknown> {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) out.push(await completeValue(ctx, namedType, value[i], node, [...path, i]));
    return out;
  }
  if (node.selectionSet === null) return value;
  if (isSrc(value)) return executeSelectionSet(ctx, value.t, value, node.selectionSet, path);
  if (isRecord(value)) return executeSelectionSet(ctx, namedType ?? 'Query', value, node.selectionSet, path);
  return value;
}

/** Run one operation document to its {data} / {data, errors} / {errors} envelope. */
async function executeOperation(store: any, documentText: string, variables: Rec, operationName: string | null): Promise<Rec> {
  let doc: DocumentNode;
  try {
    doc = new Parser(lex(documentText)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation: OperationNode | undefined;
  if (operationName !== null && operationName !== '') {
    operation = doc.operations.find((op) => op.name === operationName);
    if (operation === undefined) return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else {
    operation = doc.operations.find((op) => op.name === null) ?? doc.operations[0];
  }
  if (operation === undefined) return { errors: [{ message: 'the document holds no operation' }] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: Array<{ message: string }> = [];
  validateSelections(rootType, operation.selectionSet, doc, validationErrors);
  if (validationErrors.length > 0) return { data: null, errors: validationErrors };
  const ctx: ExecCtx = { store, variables, doc, errors: [] };
  const data = await executeSelectionSet(ctx, rootType, src(rootType, {}), operation.selectionSet, []);
  const envelope: Rec = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

// ---------------------------------------------------------------------------------------------------------
// The HTTP handler: POST /api/graphql only. One operation object, or a JSON array of them answered in
// order. Authentication was enforced before dispatch; every answer is application/json.
// ---------------------------------------------------------------------------------------------------------

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: any, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/graphql') return false;
  const requestId = nextRequestId();
  if (req.method !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return true;
  }
  const raw = await readBody(req);
  const text = typeof raw === 'string' ? raw : Buffer.from(raw as any).toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'the request body is not JSON' }] }, requestId);
    return true;
  }
  if (Array.isArray(body)) {
    const envelopes: Rec[] = [];
    for (const entry of body) {
      if (!isRecord(entry) || typeof entry.query !== 'string') {
        envelopes.push({ errors: [{ message: 'each batched operation needs a query string' }] });
        continue;
      }
      const variables = isRecord(entry.variables) ? entry.variables : {};
      const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
      envelopes.push(await executeOperation(store, entry.query, variables, operationName));
    }
    sendJson(res, 200, envelopes, requestId);
    return true;
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    sendJson(res, 400, { errors: [{ message: 'the request body must be an operation object with a query string' }] }, requestId);
    return true;
  }
  const variables = isRecord(body.variables) ? body.variables : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const envelope = await executeOperation(store, body.query, variables, operationName);
  sendJson(res, 200, envelope, requestId);
  return true;
}
