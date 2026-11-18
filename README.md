# A GitHub-compatible git forge in one Node process

![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)
![rank](https://make.fun/badge/github-core-clone-01/rivan122/makefun-git-forge/rank.svg)
![reward](https://make.fun/badge/github-core-clone-01/rivan122/makefun-git-forge/reward.svg)

A standalone git forge that speaks the four surfaces GitHub clients already use — **Git Smart
HTTP**, the **REST v3 API**, **GraphQL v4** and the **Model Context Protocol** — from a single
Node process over its own in-memory store. No dependencies, no database, no `git` binary: the
object database, packfile codec and protocol state machines are implemented here, in TypeScript
the Node runtime strips natively.

Built for the make.fun bounty [Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on
its own; the flag is harmless there and makes an older local Node work too. There is nothing to
install: the program imports `node:http` and its own sources only, and the trial has no package
manager and no internet.

`main.ts` is the entry ↔ env lifecycle (bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`,
poll `GET $MAKEFUN_ENV_URL/done`, exit 0) and stays exactly as the kit ships it. Everything the
suite scores lives behind `app.ts`: one bearer-token gate (`Authorization: Bearer
$MAKEFUN_SHOP_TOKEN`; `/healthz` is the unauthenticated boot probe) dispatching to four handlers
over one shared store.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, git data (refs, trees, blobs, commits), issues, comments, labels, pull requests, files, squash merges |
| `POST /api/graphql` | GitHub GraphQL v4: a real lexer/parser/validator/executor — queries, mutations, Relay connections, introspection, batched documents |
| `POST /mcp` | MCP over Streamable HTTP: `server/discover` (revision 2026-07-28) plus the legacy initialize handshake; six tools — create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request |
| `/<owner>/<repo>.git/...` | Git Smart HTTP: protocol v2 `ls-refs`/`fetch` (with shallow/deepen) and v0 `receive-pack` with report-status, side-band-64k, fast-forward-only updates and per-ref partial acceptance |
| anything else | 404 `{"message":"Not Found"}` |

Cross-surface rules the implementation is careful about: a repository under another owner is
404, never 403; an issue and a pull request share one number space per repository; a squash
merge lands the same commit whichever surface performs it; every stored timestamp derives from
`MAKEFUN_TRIAL_NOW` plus a logical counter, so a replayed trial reproduces byte-identical state.

## Layout

- `main.ts` — the lifecycle above. Kept as the kit ships it.
- `app.ts` — the token gate and the dispatch.
- `src/store.ts` — the record store: repositories, issues, pull requests, labels, comments, the logical clock.
- `src/gitdb.ts` — the git object database: commits, trees, ancestry, merge bases, tree building with git's sort rule.
- `src/pack.ts` — packfile v2 encode/decode, including ofs-delta and ref-delta (thin packs included).
- `src/git.ts` — Smart HTTP: advertisements, ls-refs, fetch planning, receive-pack validation and reporting.
- `src/rest.ts` — the REST v3 surface.
- `src/graphql.ts` — the GraphQL v4 engine.
- `src/mcp.ts` — the MCP endpoint.
- `src/util.ts` — SHA-1, pkt-line framing, base64, JSON replies.
- `tests/` — four suites: core (18 checks, including differentials against the real `git` binary), git transport (the real git CLI end to end), REST (200 checks), GraphQL+MCP (175 checks).

## Verification

Against the kit's own sealed-suite runner, locally: **120/120 conformance checks** (git 30,
repos 15, issues 15, pulls 20, GraphQL 20, MCP 15, protocol 5). Timed workloads, median of three
rounds on a small VM, against the reference forge's calibrated medians: push ≈ 0.28 s (ref
1.64 s), clone ≈ 0.09 s (ref 0.27 s), read ≈ 0.59 s (ref 2.76 s), write ≈ 0.10 s (ref 0.35 s).
Two full runs through the kit's env harness produced byte-identical state exports.

## License

MIT — see `LICENSE`.
