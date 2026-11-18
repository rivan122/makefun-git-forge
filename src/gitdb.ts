// The in-memory git object database: blobs, trees, commits and tags keyed by their SHA-1, plus
// the refs beside them. Everything is parsed and serialized by hand in git's own formats — no
// git binary is ever invoked — so a hash computed here is the hash real git computes.

import { gitObjectSha } from './util.ts';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

/** A parsed commit: header fields plus the message, preserved verbatim after the blank line. */
export interface CommitRec {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/**
 * One tree entry. `mode` is the ASCII form git writes: '100644', '100755', '120000', '160000',
 * and '40000' for directories ('040000' is accepted on input and normalized to '40000').
 */
export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

interface StoredObject {
  type: ObjType;
  data: Buffer;
}

/** Normalize a tree mode to the form git writes ('040000' -> '40000'). */
function normalizeMode(mode: string): string {
  return mode === '040000' ? '40000' : mode;
}

/** True when a (normalized) tree mode names a directory. */
function isDirMode(mode: string): boolean {
  return normalizeMode(mode) === '40000';
}

/** git's tree-entry sort key: the name's bytes, a directory compared as if it ended in '/'. */
function treeSortKey(entry: TreeEntry): Buffer {
  return Buffer.from(isDirMode(entry.mode) ? `${entry.name}/` : entry.name, 'utf8');
}

/** Parse a commit object's raw bytes; undefined when the header layout is not a commit's. */
function parseCommit(data: Buffer): CommitRec | undefined {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (tree === '') return undefined;
  return { tree, parents, author, committer, message };
}

/** Parse a tree object's raw bytes into its entries, in stored order. */
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** One repository's object store and refs. */
export class GitRepo {
  objects: Map<string, StoredObject>;
  refs: Map<string, string>;
  headRef: string;

  constructor(headRef = 'refs/heads/main') {
    this.objects = new Map();
    this.refs = new Map();
    this.headRef = headRef;
  }

  /** True when the object is stored. */
  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  /** Store an object's raw bytes under their git id; returns the id. */
  store(type: ObjType, data: Buffer): string {
    const sha = gitObjectSha(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  /** The stored object, or undefined when absent. */
  load(sha: string): StoredObject | undefined {
    return this.objects.get(sha);
  }

  /** The parsed commit at `sha`, or undefined when absent or not a commit. */
  commit(sha: string): CommitRec | undefined {
    const obj = this.objects.get(sha);
    if (!obj || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data);
  }

  /** The parsed tree at `sha`, or undefined when absent or not a tree. */
  tree(sha: string): TreeEntry[] | undefined {
    const obj = this.objects.get(sha);
    if (!obj || obj.type !== 'tree') return undefined;
    return parseTree(obj.data);
  }

  /** Store file contents as a blob; returns its id. */
  writeBlob(content: Buffer): string {
    return this.store('blob', content);
  }

  /**
   * Serialize and store a tree from entries: modes normalized, entries sorted with git's rule
   * (directories as name + '/'), each entry "<mode> <name>\0" plus the 20 raw id bytes.
   */
  buildTree(entries: TreeEntry[]): string {
    const normalized = entries.map((entry) => ({ mode: normalizeMode(entry.mode), name: entry.name, sha: entry.sha }));
    const sorted = [...normalized].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
    const parts: Buffer[] = [];
    for (const entry of sorted) {
      parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      parts.push(Buffer.from(entry.sha, 'hex'));
    }
    return this.store('tree', Buffer.concat(parts));
  }

  /**
   * Every file under a tree, keyed by full slash path from `prefix`. Directories are walked;
   * anything else (blobs, symlinks, gitlinks) is a leaf.
   */
  flattenTree(treeSha: string, prefix = ''): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>();
    const walk = (sha: string, base: string): void => {
      const entries = this.tree(sha);
      if (!entries) return;
      for (const entry of entries) {
        const path = base + entry.name;
        if (isDirMode(entry.mode)) walk(entry.sha, `${path}/`);
        else out.set(path, { mode: entry.mode, sha: entry.sha });
      }
    };
    walk(treeSha, prefix);
    return out;
  }

  /** Build (and store) the nested trees for a flat map of slash paths to file contents. */
  makeTreeFromFiles(files: Map<string, Buffer>): string {
    interface DirNode {
      dirs: Map<string, DirNode>;
      files: Map<string, Buffer>;
    }
    const newNode = (): DirNode => ({ dirs: new Map(), files: new Map() });
    const root = newNode();
    for (const [path, content] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        let child = node.dirs.get(parts[i]);
        if (!child) {
          child = newNode();
          node.dirs.set(parts[i], child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1], content);
    }
    const build = (node: DirNode): string => {
      const entries: TreeEntry[] = [];
      for (const [name, content] of node.files) entries.push({ mode: '100644', name, sha: this.writeBlob(content) });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: build(child) });
      return this.buildTree(entries);
    };
    return build(root);
  }

  /**
   * Serialize and store a commit in git's exact layout: tree, parents in order, author,
   * committer (defaulting to the author line), a blank line, then the message verbatim.
   */
  makeCommit(treeSha: string, parents: string[], message: string, authorLine: string, committerLine?: string): string {
    const lines = [`tree ${treeSha}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${authorLine}`);
    lines.push(`committer ${committerLine ?? authorLine}`);
    return this.store('commit', Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8'));
  }

  /** True when `anc` is `desc` itself or reachable from it by walking parents. */
  isAncestor(anc: string, desc: string): boolean {
    const seen = new Set<string>();
    const queue = [desc];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      if (cur === anc) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const rec = this.commit(cur);
      if (rec) queue.push(...rec.parents);
    }
    return false;
  }

  /**
   * A best common ancestor of `a` and `b`: the first commit met by a breadth-first walk from
   * `b` that is also an ancestor of `a`. Null when the histories share nothing.
   */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsOfA = new Set<string>();
    const collect = [a];
    while (collect.length > 0) {
      const cur = collect.shift() as string;
      if (ancestorsOfA.has(cur)) continue;
      ancestorsOfA.add(cur);
      const rec = this.commit(cur);
      if (rec) collect.push(...rec.parents);
    }
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (ancestorsOfA.has(cur)) return cur;
      const rec = this.commit(cur);
      if (rec) queue.push(...rec.parents);
    }
    return null;
  }

  /** Every object id reachable from the tips: commits, their trees recursively, blobs, tags. */
  reachableFrom(tips: string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      const obj = this.objects.get(sha);
      if (!obj) continue;
      seen.add(sha);
      if (obj.type === 'commit') {
        const rec = parseCommit(obj.data);
        if (rec) {
          stack.push(rec.tree);
          stack.push(...rec.parents);
        }
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.sha);
      } else if (obj.type === 'tag') {
        const text = obj.data.toString('utf8');
        for (const line of text.split('\n')) {
          if (line.startsWith('object ')) {
            stack.push(line.slice(7).trim());
            break;
          }
        }
      }
    }
    return seen;
  }

  /** Commit ids reachable from `sha`, newest first (breadth-first by parents), at most `limit`. */
  history(sha: string, limit: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [sha];
    let head = 0;
    while (head < queue.length && out.length < limit) {
      const cur = queue[head];
      head += 1;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const rec = this.commit(cur);
      if (!rec) continue;
      out.push(cur);
      queue.push(...rec.parents);
    }
    return out;
  }
}
