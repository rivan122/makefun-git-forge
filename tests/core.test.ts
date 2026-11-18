// Core tests for util / gitdb / pack / store. Run with:
//   node --experimental-strip-types tests/core.test.ts
// Plain asserts, a line per check, exit 1 on any failure. The differential checks shell out to
// the local git CLI — allowed in tests only; the shipped code never does.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { GitRepo } from '../src/gitdb.ts';
import { decodePack, encodePack, type PackObject } from '../src/pack.ts';
import { Store, VIEWER } from '../src/store.ts';
import { b64, gitObjectSha, pktLine, PKT_FLUSH, readPktLines, unb64 } from '../src/util.ts';

let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL - ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// util: known-answer hashes, pkt-lines, base64
// ---------------------------------------------------------------------------------------------

check('util: git blob id matches the well-known "hello\\n" answer', () => {
  assert.equal(gitObjectSha('blob', Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

check('util: pkt-lines round-trip, flush, and a truncated tail returned as-is', () => {
  const wire = Buffer.concat([pktLine('hello'), PKT_FLUSH, pktLine(Buffer.from('x'))]);
  const { items, next } = readPktLines(wire);
  assert.equal(next, wire.length);
  assert.equal(items.length, 3);
  assert.equal((items[0] as Buffer).toString('utf8'), 'hello');
  assert.equal(items[1], 'flush');
  assert.equal((items[2] as Buffer).toString('utf8'), 'x');
  const truncated = readPktLines(pktLine('hello').subarray(0, 6));
  assert.equal(truncated.items.length, 1);
  assert.equal((truncated.items[0] as Buffer).length, 6);
  assert.equal(truncated.next, 6);
});

check('util: base64 round-trips with whitespace, and garbage throws', () => {
  const data = Buffer.from('forge bytes \x00\xff here');
  const encoded = b64(data);
  const withBreaks = `${encoded.slice(0, 4)}\n  ${encoded.slice(4)}`;
  assert.deepEqual(unb64(withBreaks), data);
  assert.throws(() => unb64('not!base64'));
  assert.throws(() => unb64('abcde'));
});

// ---------------------------------------------------------------------------------------------
// gitdb: trees, commits, ancestry
// ---------------------------------------------------------------------------------------------

const AUTHOR = 'A U Thor <a@example.com> 1700000000 +0000';

function sampleRepo(): { repo: GitRepo; files: Map<string, Buffer>; treeSha: string } {
  const repo = new GitRepo();
  const files = new Map<string, Buffer>([
    ['README.md', Buffer.from('# demo\n')],
    ['src/index.ts', Buffer.from('export {};\n')],
    ['src/lib/util.ts', Buffer.from('export const x = 1;\n')],
    ['docs/guide/intro.md', Buffer.from('intro\n')],
  ]);
  const treeSha = repo.makeTreeFromFiles(files);
  return { repo, files, treeSha };
}

check('gitdb: empty tree has git\'s well-known id', () => {
  const repo = new GitRepo();
  assert.equal(repo.buildTree([]), '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
});

check('gitdb: makeTreeFromFiles -> flattenTree round-trips every path', () => {
  const { repo, files, treeSha } = sampleRepo();
  const flat = repo.flattenTree(treeSha);
  assert.equal(flat.size, files.size);
  for (const [path, content] of files) {
    const entry = flat.get(path);
    assert.ok(entry, `missing ${path}`);
    assert.equal(entry.sha, gitObjectSha('blob', content));
    assert.equal(entry.mode, '100644');
  }
  const top = repo.tree(treeSha);
  assert.ok(top);
  assert.deepEqual(
    top.map((e) => e.name),
    ['README.md', 'docs', 'src'],
  );
});

check('gitdb: commit parse round-trips tree, parents, author, committer, message', () => {
  const { repo, treeSha } = sampleRepo();
  const c1 = repo.makeCommit(treeSha, [], 'initial commit\n', AUTHOR);
  assert.deepEqual(repo.commit(c1), {
    tree: treeSha,
    parents: [],
    author: AUTHOR,
    committer: AUTHOR,
    message: 'initial commit\n',
  });
  const c2 = repo.makeCommit(treeSha, [c1], 'second\nline two\n', AUTHOR, 'C O Mitter <c@example.com> 1700000001 +0000');
  const rec = repo.commit(c2);
  assert.ok(rec);
  assert.deepEqual(rec.parents, [c1]);
  assert.equal(rec.committer, 'C O Mitter <c@example.com> 1700000001 +0000');
  assert.equal(rec.message, 'second\nline two\n');
});

check('gitdb: history, isAncestor, mergeBase over a fork', () => {
  const { repo, treeSha } = sampleRepo();
  const c1 = repo.makeCommit(treeSha, [], 'one\n', AUTHOR);
  const c2 = repo.makeCommit(treeSha, [c1], 'two\n', AUTHOR);
  const cA = repo.makeCommit(treeSha, [c2], 'branch a\n', AUTHOR);
  const cB = repo.makeCommit(treeSha, [c2], 'branch b\n', AUTHOR);
  assert.deepEqual(repo.history(cA, 10), [cA, c2, c1]);
  assert.deepEqual(repo.history(cA, 2), [cA, c2]);
  assert.equal(repo.isAncestor(c1, cB), true);
  assert.equal(repo.isAncestor(cA, cB), false);
  assert.equal(repo.isAncestor(cA, cA), true);
  assert.equal(repo.mergeBase(cA, cB), c2);
  assert.equal(repo.mergeBase(cA, c1), c1);
  const orphan = repo.makeCommit(treeSha, [], 'orphan\n', AUTHOR);
  assert.equal(repo.mergeBase(cA, orphan), null);
});

check('gitdb: reachableFrom walks commits, trees, blobs and tags', () => {
  const { repo, files, treeSha } = sampleRepo();
  const c1 = repo.makeCommit(treeSha, [], 'one\n', AUTHOR);
  const tagData = Buffer.from(`object ${c1}\ntype commit\ntag v1\ntagger ${AUTHOR}\n\nrelease\n`, 'utf8');
  const tagSha = repo.store('tag', tagData);
  const reach = repo.reachableFrom([tagSha]);
  assert.ok(reach.has(tagSha) && reach.has(c1) && reach.has(treeSha));
  for (const content of files.values()) assert.ok(reach.has(gitObjectSha('blob', content)));
});

// ---------------------------------------------------------------------------------------------
// differential: real git agrees with buildTree's sorting and serialization
// ---------------------------------------------------------------------------------------------

function git(args: string[], opts: { cwd?: string; input?: Buffer | string } = {}): Buffer {
  return execFileSync('git', args, {
    cwd: opts.cwd,
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

check('differential: buildTree matches git mktree (dir-slash sort included)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-mktree-'));
  try {
    git(['init', '-q', '-b', 'main', dir]);
    const blob = (text: string): string =>
      git(['hash-object', '-w', '--stdin'], { cwd: dir, input: Buffer.from(text) }).toString('utf8').trim();
    const blobA = blob('alpha\n');
    const blobB = blob('beta\n');
    const blobC = blob('gamma\n');
    const emptyTree = git(['mktree'], { cwd: dir, input: '' }).toString('utf8').trim();
    assert.equal(emptyTree, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    // git's order: 'foo.txt' (0x2e '.') before 'foo/' (0x2f '/'), then 'link', then 'run.sh'.
    const lsTree = [
      `100644 blob ${blobA}\tfoo.txt`,
      `40000 tree ${emptyTree}\tfoo`,
      `120000 blob ${blobC}\tlink`,
      `100755 blob ${blobB}\trun.sh`,
      '',
    ].join('\n');
    const gitTree = git(['mktree'], { cwd: dir, input: lsTree }).toString('utf8').trim();
    const repo = new GitRepo();
    const mine = repo.buildTree([
      { mode: '100755', name: 'run.sh', sha: blobB },
      { mode: '040000', name: 'foo', sha: emptyTree },
      { mode: '120000', name: 'link', sha: blobC },
      { mode: '100644', name: 'foo.txt', sha: blobA },
    ]);
    assert.equal(mine, gitTree);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// pack: round-trip, hand-built deltas, thin packs, and real git index-pack
// ---------------------------------------------------------------------------------------------

/** Deterministic pseudo-random bytes (an LCG), so the large blob is stable run to run. */
function pseudoRandom(size: number): Buffer {
  const out = Buffer.alloc(size);
  let x = 123456789;
  for (let i = 0; i < size; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x >> 8) & 0xff;
  }
  return out;
}

function repoPackObjects(): { repo: GitRepo; objects: PackObject[]; bigSha: string; commitSha: string } {
  const { repo, treeSha } = sampleRepo();
  const commitSha = repo.makeCommit(treeSha, [], 'packed\n', AUTHOR);
  const big = pseudoRandom(300_000);
  const bigSha = repo.writeBlob(big);
  const objects: PackObject[] = [];
  for (const sha of repo.reachableFrom([commitSha])) {
    const obj = repo.load(sha);
    assert.ok(obj);
    objects.push({ sha, type: obj.type, data: obj.data });
  }
  objects.push({ sha: bigSha, type: 'blob', data: big });
  return { repo, objects, bigSha, commitSha };
}

check('pack: encode -> decode round-trips every object, large blob included', () => {
  const { objects } = repoPackObjects();
  const pack = encodePack(objects);
  const decoded = decodePack(pack, () => undefined);
  assert.equal(decoded.length, objects.length);
  const bySha = new Map(decoded.map((o) => [o.sha, o]));
  for (const obj of objects) {
    const back = bySha.get(obj.sha);
    assert.ok(back, `missing ${obj.sha}`);
    assert.equal(back.type, obj.type);
    assert.deepEqual(back.data, obj.data);
  }
});

check('pack: a corrupted trailer is refused', () => {
  const { objects } = repoPackObjects();
  const pack = Buffer.from(encodePack(objects));
  pack[pack.length - 1] = pack[pack.length - 1] ^ 0xff;
  assert.throws(() => decodePack(pack, () => undefined));
});

/** The pack object-header varint with an explicit type code (the test builds delta entries). */
function packEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Assemble a whole pack from pre-encoded entries, with a correct trailer. */
function assemblePack(entries: Buffer[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([header, ...entries]);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** A base-128 little-endian varint, as delta headers use. */
function deltaVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    bytes.push(b);
  } while (v > 0);
  return Buffer.from(bytes);
}

/** The ofs-delta base-offset encoding: each step back adds one before shifting. */
function encodeOfs(value: number): Buffer {
  const bytes: number[] = [value & 0x7f];
  let v = Math.floor(value / 128);
  while (v > 0) {
    v -= 1;
    bytes.unshift((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  return Buffer.from(bytes);
}

interface DeltaFixture {
  base: Buffer;
  target: Buffer;
  baseSha: string;
  targetSha: string;
  delta: Buffer;
  baseEntry: Buffer;
}

function deltaFixture(): DeltaFixture {
  const base = Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(4), 'utf8');
  const target = Buffer.concat([base.subarray(0, 50), Buffer.from('INSERTED'), base.subarray(60)]);
  const delta = Buffer.concat([
    deltaVarint(base.length),
    deltaVarint(target.length),
    Buffer.from([0x90, 50]), // copy from 0, 50 bytes
    Buffer.from([8]),
    Buffer.from('INSERTED'),
    Buffer.from([0x91, 60, base.length - 60]), // copy from 60, the rest
  ]);
  const baseEntry = Buffer.concat([packEntryHeader(3, base.length), deflateSync(base)]);
  return {
    base,
    target,
    baseSha: gitObjectSha('blob', base),
    targetSha: gitObjectSha('blob', target),
    delta,
    baseEntry,
  };
}

check('pack: a hand-built ref-delta pack decodes to the target', () => {
  const f = deltaFixture();
  const refDelta = Buffer.concat([
    packEntryHeader(7, f.delta.length),
    Buffer.from(f.baseSha, 'hex'),
    deflateSync(f.delta),
  ]);
  const decoded = decodePack(assemblePack([f.baseEntry, refDelta]), () => undefined);
  const target = decoded.find((o) => o.sha === f.targetSha);
  assert.ok(target);
  assert.deepEqual(target.data, f.target);
});

check('pack: a hand-built ofs-delta pack decodes to the target', () => {
  const f = deltaFixture();
  const deltaEntryOffset = 12 + f.baseEntry.length;
  const ofsDelta = Buffer.concat([
    packEntryHeader(6, f.delta.length),
    encodeOfs(deltaEntryOffset - 12),
    deflateSync(f.delta),
  ]);
  const decoded = decodePack(assemblePack([f.baseEntry, ofsDelta]), () => undefined);
  const target = decoded.find((o) => o.sha === f.targetSha);
  assert.ok(target);
  assert.deepEqual(target.data, f.target);
});

check('pack: a thin pack resolves its base through resolveExternal', () => {
  const f = deltaFixture();
  const refDelta = Buffer.concat([
    packEntryHeader(7, f.delta.length),
    Buffer.from(f.baseSha, 'hex'),
    deflateSync(f.delta),
  ]);
  const decoded = decodePack(assemblePack([refDelta]), (sha) =>
    sha === f.baseSha ? { type: 'blob', data: f.base } : undefined,
  );
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].sha, f.targetSha);
  assert.deepEqual(decoded[0].data, f.target);
});

check('differential: git index-pack accepts encodePack output and cat-file reads it back', () => {
  const { objects, bigSha, commitSha } = repoPackObjects();
  const pack = encodePack(objects);
  const dir = mkdtempSync(join(tmpdir(), 'forge-pack-'));
  try {
    git(['init', '-q', '-b', 'main', dir]);
    git(['index-pack', '--stdin'], { cwd: dir, input: pack });
    const packDir = join(dir, '.git', 'objects', 'pack');
    const idx = readdirSync(packDir).find((f) => f.endsWith('.idx'));
    assert.ok(idx, 'index-pack wrote no idx');
    const listing = git(['verify-pack', '-v', join(packDir, idx)], { cwd: dir }).toString('utf8');
    assert.ok(listing.includes(commitSha), 'verify-pack does not list the commit');
    assert.equal(git(['cat-file', '-t', commitSha], { cwd: dir }).toString('utf8').trim(), 'commit');
    const blobBack = git(['cat-file', '-p', bigSha], { cwd: dir });
    const original = objects.find((o) => o.sha === bigSha);
    assert.ok(original);
    assert.deepEqual(blobBack, original.data);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// store: numbering, the logical clock, repo lifecycle
// ---------------------------------------------------------------------------------------------

check('store: logical clock starts at the trial base and advances one second per stamp', () => {
  const parsed = Date.parse(process.env.MAKEFUN_TRIAL_NOW ?? '');
  const base = Number.isNaN(parsed) ? Date.parse('2026-11-14T06:30:00.000Z') : parsed;
  const s = new Store();
  assert.equal(s.epochSec(), Math.floor(base / 1000));
  const first = s.nowIso();
  assert.equal(Date.parse(first), base);
  const second = s.nowIso();
  assert.equal(Date.parse(second) - Date.parse(first), 1000);
  assert.ok(second > first);
});

check('store: issues and pulls share one numbering space; ids are global', () => {
  const s = new Store();
  const repo = s.createRepo(VIEWER.login, 'demo');
  assert.equal(repo.id, 1);
  assert.equal(repo.full_name, 'adaiversen/demo');
  assert.equal(repo.default_branch, 'main');
  assert.equal(repo.git.headRef, 'refs/heads/main');
  assert.equal(repo.private, false);
  assert.equal(repo.description, '');

  const issue = s.addIssue(repo, { title: 'a bug', body: 'it broke', labels: ['bug'] });
  assert.equal(issue.number, 1);
  assert.equal(issue.id, 1);
  assert.equal(issue.state, 'open');
  assert.equal(issue.isPull, false);
  assert.equal(issue.user.login, 'adaiversen');
  assert.deepEqual(issue.labels, ['bug']);

  repo.git.refs.set('refs/heads/feature', 'a'.repeat(40));
  const pull = s.addPull(repo, { title: 'a change', headRef: 'feature', baseRef: 'main' });
  assert.equal(pull.number, 2);
  assert.equal(pull.id, 2);
  assert.equal(pull.isPull, true);
  assert.ok(pull.pull);
  assert.equal(pull.pull.headSha, 'a'.repeat(40));
  assert.equal(pull.pull.baseSha, null);
  assert.equal(pull.pull.merged, false);

  const third = s.addIssue(repo, { title: 'another' });
  assert.equal(third.number, 3);
  assert.equal(third.id, 3);
  assert.equal(repo.nextIssue, 4);
});

check('store: repo lookup, listing order and deletion', () => {
  const s = new Store();
  const one = s.createRepo('adaiversen', 'one');
  const two = s.createRepo('adaiversen', 'two', { private: true, defaultBranch: 'trunk' });
  s.createRepo('someoneelse', 'one');
  assert.equal(two.id, 2);
  assert.equal(two.private, true);
  assert.equal(two.git.headRef, 'refs/heads/trunk');
  assert.equal(s.getRepo('adaiversen', 'one'), one);
  assert.equal(s.getRepo('adaiversen', 'missing'), undefined);
  assert.deepEqual(
    s.listRepos('adaiversen').map((r) => r.name),
    ['one', 'two'],
  );
  assert.equal(s.deleteRepo('adaiversen', 'one'), true);
  assert.equal(s.deleteRepo('adaiversen', 'one'), false);
  assert.equal(s.getRepo('adaiversen', 'one'), undefined);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
