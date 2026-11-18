// Git smart-HTTP transport: upload-pack protocol v2 (ls-refs, fetch) with a v0 fallback, and
// v0 receive-pack (push), all served from the forge's in-memory object store (gitdb.ts). No git
// binary is involved on this side of the wire; every byte follows the pkt-line framing in
// util.ts, and nothing here reads a clock or a random source, so a replayed trial sees the same
// responses byte for byte.
//
// Routing: handleGit answers /{owner}/{repo}.git/info/refs, /git-upload-pack and
// /git-receive-pack, and returns false for every other path. Authentication is the caller's
// job (app.ts checks the bearer token before dispatch); a repository that does not exist — or
// exists under another owner — answers 404 on both services, as the rules require.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_DELIM,
  PKT_FLUSH,
  isHex40,
  nextRequestId,
  pktLine,
  readBody,
  readPktLines,
  sendJson,
  type PktItem,
} from './util.ts';
import type { Store } from './store.ts';
import type { GitRepo, ObjType } from './gitdb.ts';
import { decodePack, encodePack } from './pack.ts';

/** The repository record the store hands out (derived, so this file needs no name for it). */
type RepoRec = NonNullable<ReturnType<Store['getRepo']>>;

/** The all-zero object id: an unborn ref's value, and a delete's new value. */
const ZERO_OID = '0'.repeat(40);
/** The agent string advertised in both protocols. */
const AGENT = 'forge/1.0';
/**
 * Pack bytes per sideband packet. The payload is one band byte plus the chunk, and a pkt-line
 * may carry at most 65516 payload bytes (65520 with its length prefix), so 65500 always fits.
 */
const SIDEBAND_CHUNK = 65500;
/** Object types a pack may carry, used to vet decoded objects before they are staged. */
const OBJ_TYPES: ReadonlySet<string> = new Set(['blob', 'tree', 'commit', 'tag']);

/** A stored git object, structurally: the shape gitdb keeps and pack.ts moves around. */
interface ObjectLike {
  type: ObjType;
  data: Buffer;
}

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

/** Answer a JSON error (the 404 shape GitHub uses), with a fresh deterministic request id. */
function jsonError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message }, nextRequestId());
}

/** Answer a binary git payload with an explicit length. */
function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

/** One line of a protocol stream: strip exactly one trailing LF, as every parser here expects. */
function chomp(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** A one-line, printable rendering of an error, safe to embed in a protocol line. */
function sanitize(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/[^\x20-\x7e]/g, ' ').slice(0, 200) || 'error';
}

/** True when the Git-Protocol header asks for protocol version 2. */
function wantsV2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  if (typeof header !== 'string') return false;
  return header.split(/[:,]/).some((part) => part.trim() === 'version=2');
}

/** Percent-decode one path segment; null when the encoding is malformed. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The repo's refs as [name, oid] pairs, sorted by name so advertisements are deterministic. */
function sortedRefs(git: GitRepo): Array<[string, string]> {
  return [...git.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The `object` header of a tag object's bytes, or null when it is not a well-formed tag. */
function tagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) {
      const value = line.slice(7).trim();
      return isHex40(value) ? value : null;
    }
  }
  return null;
}

/** Follow tag objects from `sha` until a non-tag object; that object's id (or `sha` itself). */
function peelTag(git: GitRepo, sha: string): string {
  let current = sha;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const obj = git.load(current);
    if (!obj || obj.type !== 'tag') return current;
    const target = tagTarget(obj.data);
    if (!target) return current;
    current = target;
  }
}

/** Parse a commit object's header from raw bytes: its tree and its parents, in order. */
function parseCommitHeader(data: Buffer): { tree: string | null; parents: string[] } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  let tree: string | null = null;
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

/** Parse a tree object's raw bytes into its entries (mode, name, hex id), in stored order. */
function parseTreeEntries(data: Buffer): Array<{ mode: string; name: string; sha: string }> {
  const entries: Array<{ mode: string; name: string; sha: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Add a tree and everything under it (subtrees, blobs) to `into`. Missing objects are skipped. */
function treeClosure(git: GitRepo, treeSha: string, into: Set<string>): void {
  const stack = [treeSha];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (into.has(sha)) continue;
    const obj = git.load(sha);
    if (!obj) continue;
    into.add(sha);
    if (obj.type === 'tree') {
      const entries = git.tree(sha);
      if (entries) for (const entry of entries) stack.push(entry.sha);
    }
  }
}

/** Wrap pack bytes in side-band-64k band-1 packets (payload: one band byte, then raw bytes). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, offset + SIDEBAND_CHUNK);
    const payload = Buffer.allocUnsafe(chunk.length + 1);
    payload[0] = 1;
    chunk.copy(payload, 1);
    packets.push(pktLine(payload));
  }
  if (packets.length === 0) {
    // A pack is never empty (its header and trailer alone are 32 bytes), but a fetch must still
    // carry at least one band-1 packet for the framing to read as a packfile section.
    const payload = Buffer.allocUnsafe(1);
    payload[0] = 1;
    packets.push(pktLine(payload));
  }
  return packets;
}

/** Build the pack carrying exactly `send`'s objects, in id order so the bytes are stable. */
function buildPack(git: GitRepo, send: ReadonlySet<string>): Buffer {
  const objects: Array<{ sha: string; type: ObjType; data: Buffer }> = [];
  for (const sha of [...send].sort()) {
    const obj = git.load(sha);
    if (obj) objects.push({ sha, type: obj.type, data: obj.data });
  }
  return encodePack(objects);
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

/**
 * The v0 ref advertisement for a service: the "# service=" preamble, a flush, then either the
 * capabilities pseudo-ref (an empty repository) or HEAD — carrying the capabilities after a
 * NUL — followed by every ref, annotated tags each followed by their peeled `^{}` line.
 */
function v0Advertisement(git: GitRepo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const capabilities =
    service === 'git-upload-pack'
      ? `multi_ack_detailed thin-pack side-band-64k ofs-delta shallow object-format=sha1 symref=HEAD:${git.headRef} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(git);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}`));
  } else {
    const headSha = git.refs.get(git.headRef) ?? ZERO_OID;
    parts.push(pktLine(`${headSha} HEAD\0${capabilities}`));
    for (const [name, sha] of refs) {
      parts.push(pktLine(`${sha} ${name}`));
      const obj = git.load(sha);
      if (obj && obj.type === 'tag') {
        const peeled = peelTag(git, sha);
        if (peeled !== sha) parts.push(pktLine(`${peeled} ${name}^{}`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement: service preamble, then "version 2" and one line per capability. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

/** GET info/refs: the advertisement for the named service, or 404 for anything else. */
function infoRefs(req: IncomingMessage, res: ServerResponse, git: GitRepo, url: URL): void {
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    jsonError(res, 404, 'Not Found');
    return;
  }
  const body =
    service === 'git-upload-pack' && wantsV2(req) ? v2Advertisement() : v0Advertisement(git, service);
  sendBytes(res, 200, `application/x-${service}-advertisement`, body);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2 commands
// ---------------------------------------------------------------------------------------------

/**
 * Split a v2 request body into its command name and argument lines. The request is a command
 * line plus capability lines, a delimiter, then the arguments up to the flush; a request with
 * no delimiter is read the same way, with the capability lines filtered out of the arguments.
 */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const { items } = readPktLines(body);
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const item of items) {
    if (item === 'flush' || item === 'response-end') break;
    if (item === 'delim') {
      inArgs = true;
      continue;
    }
    const line = chomp(item.toString('utf8'));
    if (!inArgs && line.startsWith('command=')) {
      command = line.slice('command='.length);
      continue;
    }
    if (!inArgs && (line.startsWith('agent=') || line.startsWith('object-format='))) continue;
    args.push(line);
  }
  return { command, args };
}

/** The v2 ls-refs command: HEAD (with its symref target), then the prefix-matched refs. */
function lsRefs(res: ServerResponse, git: GitRepo, args: string[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headSha = git.refs.get(git.headRef);
  if (matches('HEAD')) {
    if (headSha !== undefined) {
      lines.push(`${headSha} HEAD${symrefs ? ` symref-target:${git.headRef}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${git.headRef}` : ''}`);
    }
  }
  for (const [name, sha] of sortedRefs(git)) {
    if (!matches(name)) continue;
    let line = `${sha} ${name}`;
    if (peel) {
      const obj = git.load(sha);
      if (obj && obj.type === 'tag') {
        const peeled = peelTag(git, sha);
        if (peeled !== sha) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  const parts = lines.map((line) => pktLine(`${line}\n`));
  parts.push(PKT_FLUSH);
  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------------------------
// fetch (one planner shared by protocol v2 and v0)
// ---------------------------------------------------------------------------------------------

/** A parsed fetch request, either protocol's spelling of the same negotiation. */
interface FetchArgs {
  wants: string[];
  wantRefs: Array<{ oid: string; ref: string }>;
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  /** The client asked to deepen relative to its current shallow boundary, not from the want. */
  deepenRelative: boolean;
  done: boolean;
  filter: string | null;
}

/** The planner's answer: the objects to send, and the shallow boundary to report. */
interface FetchPlan {
  send: Set<string>;
  shallow: string[];
  unshallow: string[];
}

/** A commit's committer timestamp (unix seconds); +Infinity when it cannot be read. */
function commitTime(git: GitRepo, sha: string): number {
  const rec = git.commit(sha);
  if (!rec) return Number.POSITIVE_INFINITY;
  const match = / (\d+) [+-]\d{4}$/.exec(rec.committer.trim());
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

/**
 * Plan a fetch: which objects the pack carries, and how the shallow boundary moves.
 *
 * Without a depth limit the pack is the wants' full closure minus the haves' closure. With a
 * depth limit (deepen, deepen-since, deepen-not) the walk is generation-counted from the wants,
 * and a have the client holds shallowly excludes only the commit itself and its trees — never
 * its ancestry, which the client by definition does not hold. The reported boundary is the set
 * of delivered commits with a parent outside both the delivery and the client's hands, plus
 * the client's old boundary commits this fetch has made whole again (unshallow).
 */
/**
 * The generation at which the client's shallow boundary sits below `want` (the want itself
 * counting as generation 1), or 0 when no boundary commit is reachable from the want.
 */
function boundaryGeneration(git: GitRepo, want: string, clientShallow: ReadonlySet<string>): number {
  const start = peelTag(git, want);
  if (!git.commit(start)) return 0;
  const seen = new Set<string>();
  let frontier = [start];
  let generation = 0;
  while (frontier.length > 0) {
    generation += 1;
    const next: string[] = [];
    for (const sha of frontier) {
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (clientShallow.has(sha)) return generation;
      const rec = git.commit(sha);
      if (rec) next.push(...rec.parents);
    }
    frontier = next;
  }
  return 0;
}

function planFetch(git: GitRepo, args: FetchArgs): FetchPlan {
  const limited = args.depth !== null || args.deepenSince !== null || args.deepenNot.length > 0;
  const clientShallow = new Set(args.shallow);

  // A relative deepen counts from the client's current boundary, not from the want: the
  // effective depth is the requested deepening plus the boundary's generation below the want.
  let depth = args.depth;
  if (depth !== null && args.deepenRelative) {
    let boundary = 0;
    for (const want of args.wants) {
      boundary = Math.max(boundary, boundaryGeneration(git, want, clientShallow));
    }
    if (boundary > 0) depth += boundary;
  }

  // Commits a deepen-not names: reachable from those refs, and never delivered or crossed.
  const notCommits = new Set<string>();
  if (args.deepenNot.length > 0) {
    const tips: string[] = [];
    for (const ref of args.deepenNot) {
      const sha = git.refs.get(ref);
      if (sha) tips.push(sha);
      else if (isHex40(ref)) tips.push(ref);
    }
    for (const sha of git.reachableFrom(tips)) {
      const obj = git.load(sha);
      if (obj && obj.type === 'commit') notCommits.add(sha);
    }
  }

  // The delivery set, before subtracting what the client already holds.
  const included = new Set<string>();
  const includedCommits = new Set<string>();
  if (!limited) {
    for (const sha of git.reachableFrom(args.wants)) {
      included.add(sha);
      const obj = git.load(sha);
      if (obj && obj.type === 'commit') includedCommits.add(sha);
    }
  } else {
    let frontier: string[] = [];
    for (const want of args.wants) {
      let current = want;
      const guard = new Set<string>();
      for (;;) {
        const obj = git.load(current);
        if (!obj) break;
        if (obj.type === 'tag') {
          included.add(current);
          const target = tagTarget(obj.data);
          if (!target || guard.has(target)) break;
          guard.add(current);
          current = target;
          continue;
        }
        if (obj.type === 'commit') frontier.push(current);
        else included.add(current);
        break;
      }
    }
    const seen = new Set<string>();
    let generation = 0;
    while (frontier.length > 0) {
      generation += 1;
      const next: string[] = [];
      for (const sha of frontier) {
        if (seen.has(sha)) continue;
        seen.add(sha);
        if (notCommits.has(sha)) continue;
        if (args.deepenSince !== null && commitTime(git, sha) < args.deepenSince) continue;
        const rec = git.commit(sha);
        if (!rec) continue;
        includedCommits.add(sha);
        included.add(sha);
        treeClosure(git, rec.tree, included);
        for (const parent of rec.parents) next.push(parent);
      }
      if (depth !== null && generation >= depth) break;
      frontier = next;
    }
  }

  // What the client already holds. A shallow have excludes its commit and trees only; any
  // other have excludes its whole closure.
  const clientHas = new Set<string>();
  for (const have of new Set(args.haves)) {
    if (!git.has(have)) continue;
    if (!clientShallow.has(have)) {
      for (const sha of git.reachableFrom([have])) clientHas.add(sha);
      continue;
    }
    let current = have;
    const guard = new Set<string>();
    for (;;) {
      const obj = git.load(current);
      if (!obj) break;
      clientHas.add(current);
      if (obj.type === 'tag') {
        const target = tagTarget(obj.data);
        if (!target || guard.has(target)) break;
        guard.add(current);
        current = target;
        continue;
      }
      if (obj.type === 'commit') {
        const rec = git.commit(current);
        if (rec) treeClosure(git, rec.tree, clientHas);
      }
      break;
    }
  }

  const send = new Set<string>();
  for (const sha of included) if (!clientHas.has(sha)) send.add(sha);

  // An object filter, when the client sent one, trims the pack it asked to be trimmed.
  if (args.filter !== null) {
    if (args.filter === 'blob:none') {
      for (const sha of [...send]) {
        const obj = git.load(sha);
        if (obj && obj.type === 'blob') send.delete(sha);
      }
    } else if (args.filter.startsWith('blob:limit=')) {
      const limit = Number(args.filter.slice('blob:limit='.length));
      if (Number.isFinite(limit)) {
        for (const sha of [...send]) {
          const obj = git.load(sha);
          if (obj && obj.type === 'blob' && obj.data.length > limit) send.delete(sha);
        }
      }
    }
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (limited || clientShallow.size > 0) {
    for (const sha of includedCommits) {
      const rec = git.commit(sha);
      if (!rec) continue;
      const missingParent = rec.parents.some(
        (parent) => !includedCommits.has(parent) && !clientHas.has(parent),
      );
      if (missingParent) shallow.push(sha);
      else if (clientShallow.has(sha)) unshallow.push(sha);
    }
    shallow.sort();
    unshallow.sort();
  }
  return { send, shallow, unshallow };
}

/**
 * The v2 fetch command. While the client is still negotiating (no `done`), the answer is an
 * acknowledgments section: a NAK when no have is known — the client will offer more — or an
 * ACK per known have closed by `ready`, after which the packfile sections follow in the same
 * response, as a client that hears `ready` expects the pack next. A request that arrives with
 * `done` goes straight to the shallow-info, wanted-refs and packfile sections.
 */
function fetchV2(res: ServerResponse, git: GitRepo, args: FetchArgs): void {
  const parts: Buffer[] = [];
  if (!args.done) {
    const known = [...new Set(args.haves)].filter((have) => git.has(have));
    if (known.length === 0) {
      parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH);
      sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
      return;
    }
    parts.push(pktLine('acknowledgments\n'));
    for (const have of known) parts.push(pktLine(`ACK ${have}\n`));
    // A section that more sections follow ends with a delimiter, never a flush: a flush after
    // `ready` reads as the end of the whole response, and the client dies waiting for a pack.
    parts.push(pktLine('ready\n'), PKT_DELIM);
  }
  const plan = planFetch(git, args);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(PKT_DELIM);
  }
  if (args.wantRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const wantRef of args.wantRefs) parts.push(pktLine(`${wantRef.oid} ${wantRef.ref}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(buildPack(git, plan.send)));
  parts.push(PKT_FLUSH);
  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** Parse a v2 fetch command's argument lines into a FetchArgs. */
function parseFetchArgs(git: GitRepo, lines: string[]): FetchArgs {
  const args: FetchArgs = {
    wants: [],
    wantRefs: [],
    haves: [],
    shallow: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
    deepenRelative: false,
    done: false,
    filter: null,
  };
  const wantRefNames: string[] = [];
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const sha = line.slice('want '.length).trim();
      if (isHex40(sha)) args.wants.push(sha);
    } else if (line.startsWith('want-ref ')) {
      wantRefNames.push(line.slice('want-ref '.length).trim());
    } else if (line.startsWith('have ')) {
      const sha = line.slice('have '.length).trim();
      if (isHex40(sha)) args.haves.push(sha);
    } else if (line.startsWith('shallow ')) {
      const sha = line.slice('shallow '.length).trim();
      if (isHex40(sha)) args.shallow.push(sha);
    } else if (line.startsWith('deepen-not ')) {
      args.deepenNot.push(line.slice('deepen-not '.length).trim());
    } else if (line.startsWith('deepen-since ')) {
      const value = Number(line.slice('deepen-since '.length).trim());
      if (Number.isFinite(value)) args.deepenSince = value;
    } else if (line === 'deepen-relative') {
      args.deepenRelative = true;
    } else if (line.startsWith('deepen ')) {
      const value = Number(line.slice('deepen '.length).trim());
      if (Number.isFinite(value) && value > 0) args.depth = value;
    } else if (line === 'done') {
      args.done = true;
    } else if (line.startsWith('filter ')) {
      args.filter = line.slice('filter '.length).trim();
    }
    // thin-pack, no-progress, ofs-delta, wait-for-done, side-band-all: accepted, no effect here.
  }
  for (const ref of wantRefNames) {
    const sha = git.refs.get(ref);
    if (sha) {
      args.wants.push(sha);
      args.wantRefs.push({ oid: sha, ref });
    }
  }
  return args;
}

/** POST git-upload-pack under protocol v2: dispatch the ls-refs and fetch commands. */
function uploadPackV2(res: ServerResponse, git: GitRepo, body: Buffer): void {
  const { command, args } = parseV2Request(body);
  if (command === 'ls-refs') {
    lsRefs(res, git, args);
    return;
  }
  if (command === 'fetch') {
    fetchV2(res, git, parseFetchArgs(git, args));
    return;
  }
  throw new Error(`unknown command ${JSON.stringify(command)}`);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v0
// ---------------------------------------------------------------------------------------------

/**
 * POST git-upload-pack under protocol v0: want/shallow/deepen lines, a flush, have lines and
 * done, a second flush. The answer is shallow lines, the ACK/NAK negotiation (multi_ack_detailed
 * when the client asked for it), then the pack in side-band-64k band 1 and a flush.
 */
function uploadPackV0(res: ServerResponse, git: GitRepo, body: Buffer): void {
  const { items } = readPktLines(body);
  const args: FetchArgs = {
    wants: [],
    wantRefs: [],
    haves: [],
    shallow: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
    deepenRelative: false,
    done: false,
    filter: null,
  };
  const requestedCaps = new Set<string>();
  for (const item of items) {
    if (item === 'flush' || item === 'response-end') continue;
    if (!Buffer.isBuffer(item)) continue;
    const line = chomp(item.toString('utf8'));
    if (line.startsWith('want ')) {
      const [sha, ...caps] = line.slice('want '.length).split(' ');
      if (isHex40(sha)) args.wants.push(sha);
      for (const cap of caps) if (cap) requestedCaps.add(cap);
    } else if (line.startsWith('have ')) {
      const sha = line.slice('have '.length).trim();
      if (isHex40(sha)) args.haves.push(sha);
    } else if (line.startsWith('shallow ')) {
      const sha = line.slice('shallow '.length).trim();
      if (isHex40(sha)) args.shallow.push(sha);
    } else if (line.startsWith('deepen-not ')) {
      args.deepenNot.push(line.slice('deepen-not '.length).trim());
    } else if (line.startsWith('deepen-since ')) {
      const value = Number(line.slice('deepen-since '.length).trim());
      if (Number.isFinite(value)) args.deepenSince = value;
    } else if (line === 'deepen-relative') {
      args.deepenRelative = true;
    } else if (line.startsWith('deepen ')) {
      const value = Number(line.slice('deepen '.length).trim());
      if (Number.isFinite(value) && value > 0) args.depth = value;
    } else if (line === 'done') {
      args.done = true;
    }
  }
  if (args.wants.length === 0) throw new Error('fetch request carries no want');

  const detailed = requestedCaps.has('multi_ack_detailed');
  const known = [...new Set(args.haves)].filter((have) => git.has(have));
  const parts: Buffer[] = [];
  let plan: FetchPlan | null = null;
  if (args.done) {
    plan = planFetch(git, args);
    for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  }
  if (known.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else if (!args.done && detailed) {
    for (const have of known) parts.push(pktLine(`ACK ${have} common\n`));
  } else if (args.done && detailed) {
    for (const have of known.slice(0, -1)) parts.push(pktLine(`ACK ${have} common\n`));
    parts.push(pktLine(`ACK ${known[known.length - 1]} ready\n`));
  } else {
    parts.push(pktLine(`ACK ${known[known.length - 1]}\n`));
  }
  if (plan !== null) parts.push(...sidebandPackets(buildPack(git, plan.send)));
  parts.push(PKT_FLUSH);
  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** POST git-upload-pack: v2 when the client asked for it, v0 otherwise; errors answer ERR. */
async function uploadPack(req: IncomingMessage, res: ServerResponse, git: GitRepo): Promise<void> {
  const body = await readBody(req);
  try {
    if (wantsV2(req)) uploadPackV2(res, git, body);
    else uploadPackV0(res, git, body);
  } catch (err) {
    if (!res.headersSent) {
      const payload = Buffer.concat([pktLine(`ERR ${sanitize(err)}\n`), PKT_FLUSH]);
      sendBytes(res, 400, 'application/x-git-upload-pack-result', payload);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

/** One receive-pack command: move `ref` from `oldOid` to `newOid` (zero is create/delete). */
interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** A combined view of the repository plus a push's staged objects, for validation walks. */
type ObjectView = (sha: string) => ObjectLike | undefined;

/** Follow tag objects in the combined view until a non-tag object. */
function peelTagView(view: ObjectView, sha: string): string {
  let current = sha;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const obj = view(current);
    if (!obj || obj.type !== 'tag') return current;
    const target = tagTarget(obj.data);
    if (!target) return current;
    current = target;
  }
}

/** True when `ancestor` is `descendant` itself or reachable from it by walking parents. */
function isAncestorView(view: ObjectView, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = view(current);
    if (!obj || obj.type !== 'commit') continue;
    queue.push(...parseCommitHeader(obj.data).parents);
  }
  return false;
}

/** Add every object reachable from `tips` in the combined view to `into`. */
function closureView(view: ObjectView, tips: string[], into: Set<string>): void {
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (into.has(sha)) continue;
    const obj = view(sha);
    if (!obj) continue;
    into.add(sha);
    if (obj.type === 'commit') {
      const header = parseCommitHeader(obj.data);
      if (header.tree) stack.push(header.tree);
      stack.push(...header.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTreeEntries(obj.data)) stack.push(entry.sha);
    } else if (obj.type === 'tag') {
      const target = tagTarget(obj.data);
      if (target) stack.push(target);
    }
  }
}

/**
 * Decide one ref update against the pre-push state. The checks the rules name: a delete needs
 * an existing ref, a create/update needs its object, and every update must fast-forward — a
 * refusal is per ref, with "non-fast-forward" the exact reason for an ancestry failure.
 */
function decideUpdate(
  git: GitRepo,
  view: ObjectView,
  command: PushCommand,
): { ok: true } | { ok: false; reason: string } {
  const current = git.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    if (current === undefined) return { ok: false, reason: 'reference does not exist' };
    if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
      return { ok: false, reason: 'stale info' };
    }
    if (command.ref === git.headRef) {
      return { ok: false, reason: 'deletion of the current branch prohibited' };
    }
    return { ok: true };
  }
  if (!view(command.newOid)) return { ok: false, reason: 'unknown object' };
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return { ok: false, reason: 'reference already exists' };
    return { ok: true };
  }
  if (current !== command.oldOid) return { ok: false, reason: 'stale info' };
  if (command.oldOid === command.newOid) return { ok: true };
  const oldCommit = peelTagView(view, command.oldOid);
  const newCommit = peelTagView(view, command.newOid);
  if (!isAncestorView(view, oldCommit, newCommit)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  return { ok: true };
}

/**
 * POST git-receive-pack: a pkt-line command list, a flush, then the packfile (absent for a
 * delete-only push). Objects are staged from the pack and validated per ref before anything is
 * applied: only the objects an accepted update reaches are merged into the store, and only
 * accepted refs move. The report is "unpack ok" plus one ok/ng line per ref, framed in
 * side-band-64k when the client asked for it, plain pkt-lines otherwise.
 */
function receivePackBody(res: ServerResponse, git: GitRepo, body: Buffer): void {
  const { items } = readPktLines(body);
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let offset = 0;
  let terminated = false;
  for (const item of items) {
    if (item === 'flush') {
      offset += 4;
      terminated = true;
      break;
    }
    if (!Buffer.isBuffer(item)) throw new Error('malformed receive-pack command list');
    offset += item.length + 4;
    let line = chomp(item.toString('utf8'));
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      for (const cap of line.slice(nul + 1).split(' ')) if (cap) capabilities.add(cap);
      line = line.slice(0, nul);
    }
    if (line === '') continue;
    const parts = line.split(' ');
    if (
      parts.length !== 3 ||
      !isHex40(parts[0]) ||
      !isHex40(parts[1]) ||
      !parts[2].startsWith('refs/')
    ) {
      throw new Error('malformed receive-pack command');
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (!terminated) throw new Error('unterminated receive-pack command list');
  const packBytes = body.subarray(offset);

  // Stage the pack's objects; nothing enters the repository until a ref update is accepted.
  const staged = new Map<string, ObjectLike>();
  let unpackOk = true;
  let unpackDetail = 'ok';
  const anyUpdate = commands.some((command) => command.newOid !== ZERO_OID);
  if (anyUpdate) {
    try {
      const objects = decodePack(packBytes, (sha) => staged.get(sha) ?? git.load(sha));
      for (const obj of objects) {
        if (!OBJ_TYPES.has(obj.type)) throw new Error(`pack carries a ${obj.type} object`);
        staged.set(obj.sha, { type: obj.type, data: obj.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = sanitize(err);
    }
  }
  const view: ObjectView = (sha) => staged.get(sha) ?? git.load(sha);

  const results = commands.map((command) => ({
    command,
    ...(unpackOk ? decideUpdate(git, view, command) : { ok: false as const, reason: 'unpacker error' }),
  }));

  // Apply: first merge the objects the accepted updates reach, then move the accepted refs.
  const acceptedTips = results
    .filter((result) => result.ok && result.command.newOid !== ZERO_OID)
    .map((result) => result.command.newOid);
  const needed = new Set<string>();
  closureView(view, acceptedTips, needed);
  for (const sha of needed) {
    if (git.has(sha)) continue;
    const obj = staged.get(sha);
    if (obj && OBJ_TYPES.has(obj.type)) git.store(obj.type as ObjType, obj.data);
  }
  for (const result of results) {
    if (!result.ok) continue;
    if (result.command.newOid === ZERO_OID) git.refs.delete(result.command.ref);
    else git.refs.set(result.command.ref, result.command.newOid);
  }

  // Report, when the client asked for one.
  const wantsReport = capabilities.has('report-status') || capabilities.has('report-status-v2');
  if (!wantsReport) {
    sendBytes(
      res,
      200,
      'application/x-git-receive-pack-result',
      capabilities.has('side-band-64k') ? PKT_FLUSH : Buffer.alloc(0),
    );
    return;
  }
  const reportLines = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(
      result.ok ? `ok ${result.command.ref}\n` : `ng ${result.command.ref} ${result.reason}\n`,
    );
  }
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  if (!capabilities.has('side-band-64k')) {
    sendBytes(res, 200, 'application/x-git-receive-pack-result', inner);
    return;
  }
  const packets: Buffer[] = [];
  for (let at = 0; at < inner.length; at += SIDEBAND_CHUNK) {
    const chunk = inner.subarray(at, at + SIDEBAND_CHUNK);
    const payload = Buffer.allocUnsafe(chunk.length + 1);
    payload[0] = 1;
    chunk.copy(payload, 1);
    packets.push(pktLine(payload));
  }
  packets.push(PKT_FLUSH);
  sendBytes(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(packets));
}

/** POST git-receive-pack: read the body, run it, and never let one bad push take the server down. */
async function receivePack(req: IncomingMessage, res: ServerResponse, git: GitRepo): Promise<void> {
  const body = await readBody(req);
  try {
    receivePackBody(res, git, body);
  } catch (err) {
    if (!res.headersSent) {
      const payload = Buffer.concat([pktLine(`ERR ${sanitize(err)}\n`), PKT_FLUSH]);
      sendBytes(res, 400, 'application/x-git-receive-pack-result', payload);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// the handler
// ---------------------------------------------------------------------------------------------

/**
 * Answer one smart-HTTP request for `store`'s repositories. Returns true when the path is a
 * git path (/{owner}/{repo}.git/...) — the request has been answered, including with an
 * error — and false when it is some other surface's path entirely.
 */
export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  url: URL,
): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(url.pathname);
  if (!match) return false;
  const owner = decodeSegment(match[1]);
  const name = decodeSegment(match[2]);
  const suffix = match[3] ?? '';
  if (owner === null || name === null) {
    jsonError(res, 404, 'Not Found');
    return true;
  }
  const repo: RepoRec | undefined = store.getRepo(owner, name);
  if (!repo || repo.owner !== owner) {
    jsonError(res, 404, 'Not Found');
    return true;
  }
  const git = repo.git;
  try {
    if (req.method === 'GET' && suffix === '/info/refs') {
      infoRefs(req, res, git, url);
      return true;
    }
    if (req.method === 'POST' && suffix === '/git-upload-pack') {
      await uploadPack(req, res, git);
      return true;
    }
    if (req.method === 'POST' && suffix === '/git-receive-pack') {
      await receivePack(req, res, git);
      return true;
    }
  } catch {
    if (!res.headersSent) jsonError(res, 400, 'Bad Request');
    else res.destroy();
    return true;
  }
  jsonError(res, 404, 'Not Found');
  return true;
}
