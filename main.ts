// The harness drives this process through a small handshake, and this file is that handshake
// and nothing more: the graded server is built by app.ts, while the steps below only introduce
// it to the env and wait to be told the trial is finished.
//
//   - MAKEFUN_ENV_URL names the env's origin. With no origin there is no trial to join, so an
//     unset or empty value ends the process at once with exit code 1.
//   - The server binds port 0, which asks the kernel for a free port; 8080 is never requested,
//     because on the trial layout that port belongs to the env itself.
//   - The bound port is announced with POST /register and a JSON body of {"port": N}. The env
//     pairs the caller's address with that port and treats the pair as the entry's base URL
//     from then on. Only the first announcement counts: a 409 later on changes nothing and is
//     not an error for this process.
//   - GET /done is polled until its body reads {"done": true}. The env answers immediately
//     (false while the suite runs), so polling with a pause is the intended rhythm, and this
//     process must not exit on any earlier signal, failure or silence.
//   - Once done arrives, the server closes and the process exits 0, which tells the harness to
//     stop the env and score the export the env wrote.

import { createApp as buildServer } from './app.ts';

/** The env's origin with any trailing slashes removed, or '' when the variable is absent. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** One register or poll request is abandoned after this long and, where allowed, retried. */
const REQUEST_LIMIT_MS = 30_000;
/** The pause after a first failed attempt; it doubles per attempt up to the ceiling. */
const FIRST_PAUSE_MS = 250;
/** The longest pause between attempts, however many have failed. */
const LONGEST_PAUSE_MS = 2_000;

/** Wait for `ms` milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long to wait before the attempt following `failures` failures so far. */
function pauseAfter(failures: number): number {
  const grown = FIRST_PAUSE_MS * 2 ** Math.min(failures, 8);
  return Math.min(LONGEST_PAUSE_MS, grown);
}

/** A refusal the env means permanently (HTTP 400 or 405 on register): retrying cannot help. */
class RefusedError extends Error {}

/**
 * Announce the bound port until the env accepts the announcement. 200 is the ordinary answer
 * and 409 means an earlier announcement already won; both end the loop. A 400 or 405 is a
 * contract error and is thrown. Anything else — a network failure, a 5xx while the env is
 * still starting — is retried after a growing pause.
 */
async function announce(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const answer = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new RefusedError(`register answered HTTP ${answer.status}: ${await answer.text()}`);
      }
    } catch (err) {
      if (err instanceof RefusedError) throw err;
    }
    await pause(pauseAfter(failures));
  }
}

/**
 * Poll the env's /done until it answers {"done": true}. A failed poll, a non-JSON body or a
 * body without done set all mean the same thing — not finished — and are polled again after a
 * growing pause. This function returns only on the done answer.
 */
async function awaitDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const answer = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_LIMIT_MS) });
      if (answer.ok) {
        const body = (await answer.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Silence from the env is not done: fall through and poll again.
    }
    await pause(pauseAfter(failures));
  }
}

/** Bind the server, announce its port, and wait out the trial. */
async function run(): Promise<void> {
  const server = buildServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('the server bound no TCP port');
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
