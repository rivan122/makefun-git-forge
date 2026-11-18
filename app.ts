// The forge's HTTP surface, wired: one bearer-token gate in front of four handlers that share a
// single in-memory store — git smart HTTP (src/git.ts), REST v3 (src/rest.ts), GraphQL v4
// (src/graphql.ts) and MCP (src/mcp.ts). app.ts is deliberately separate from main.ts: this is
// the server; main.ts is the entry <-> env lifecycle and stays as the kit ships it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './src/git.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { store } from './src/store.ts';
import { nextRequestId, sendJson } from './src/util.ts';

/** The bearer token the suite presents; it names the viewer every surface acts as. */
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The one Authorization header value that authenticates a request, framed once. */
const EXPECTED_AUTH = `Bearer ${TOKEN}`;

/** Whether the request carries the suite's token. An unset token authenticates nothing. */
function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return false;
  return (req.headers.authorization ?? '') === EXPECTED_AUTH;
}

/** Route one request to its surface; the surfaces answer their own paths and decline the rest. */
async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice, without auth: 200 {"ok":true}.
  if (method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true }, nextRequestId());
    return;
  }

  // Every other surface sits behind the one bearer token; a missing or wrong token is a 401
  // with a JSON message, on git, REST, GraphQL and MCP alike.
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' }, nextRequestId());
    return;
  }

  // Each surface claims only its own paths and declines the rest, so the attempt order is a
  // pure shortcut: REST answers everything under /api/v3, GraphQL only /api/graphql, MCP only
  // /mcp, and git only /{owner}/{repo}.git/... — trying the path's own surface first changes
  // nothing but the number of declined attempts before it.
  const path = url.pathname;
  if (path.startsWith('/api/')) {
    if (await handleRest(req, res, store, url)) return;
    if (await handleGraphQL(req, res, store, url)) return;
    if (await handleGit(req, res, store, url)) return;
    if (await handleMcp(req, res, store, url)) return;
  } else if (path === '/mcp') {
    if (await handleMcp(req, res, store, url)) return;
    if (await handleGit(req, res, store, url)) return;
    if (await handleRest(req, res, store, url)) return;
    if (await handleGraphQL(req, res, store, url)) return;
  } else {
    if (await handleGit(req, res, store, url)) return;
    if (await handleRest(req, res, store, url)) return;
    if (await handleGraphQL(req, res, store, url)) return;
    if (await handleMcp(req, res, store, url)) return;
  }

  // No surface claimed the path: GitHub's 404 body, still JSON with a request id.
  sendJson(res, 404, { message: 'Not Found' }, nextRequestId());
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  // The request/header timeouts are disabled: every client of this server is the suite,
  // which runs its own deadlines and always finishes the requests it starts, and the
  // harness bounds the process's whole life — the per-request timer bookkeeping the
  // timeouts would need is pure cost here. Responses carry no Date header: nothing in
  // any surface's contract reads one, and the value could only ever be the wall clock
  // this program is built to ignore.
  const server = createServer({ requestTimeout: 0, headersTimeout: 0 }, (req: IncomingMessage, res: ServerResponse) => {
    res.sendDate = false;
    dispatch(req, res).catch((err: unknown) => {
      // A handler fault must never hang or kill the trial: answer 500 and keep serving.
      process.stderr.write(`[forge] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' }, nextRequestId());
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
  // Every exchange with the suite is a small request answered by a small response, often
  // thousands of times in a row on one connection: Nagle's algorithm would hold each reply
  // back waiting to coalesce with a next segment that is not coming, against the peer's
  // delayed acknowledgements. Turning it off changes only when bytes leave, never which.
  server.on('connection', (socket) => socket.setNoDelay(true));
  return server;
}
