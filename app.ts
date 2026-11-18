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

/** Whether the request carries the suite's token. An unset token authenticates nothing. */
function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return false;
  return (req.headers.authorization ?? '') === `Bearer ${TOKEN}`;
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

  if (await handleGit(req, res, store, url)) return;
  if (await handleRest(req, res, store, url)) return;
  if (await handleGraphQL(req, res, store, url)) return;
  if (await handleMcp(req, res, store, url)) return;

  // No surface claimed the path: GitHub's 404 body, still JSON with a request id.
  sendJson(res, 404, { message: 'Not Found' }, nextRequestId());
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
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
}
