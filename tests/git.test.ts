// End-to-end tests for src/git.ts (the smart-HTTP transport) driven by the real git CLI: the
// strongest check available locally, since the trial pod's suite speaks the same protocol with
// its own in-process client. A bare node http server dispatches to handleGit over a real Store;
// git pushes, clones, shallow-clones, is refused a non-fast-forward, partially accepts a
// two-ref push, and deletes a branch against it.
//
// Run: node --experimental-strip-types tests/git.test.ts  (exit 0 is green)

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { handleGit } from '../src/git.ts';
import { Store } from '../src/store.ts';

const run = promisify(execFile);

let failures = 0;
function check(name: string, condition: boolean, extra = ''): void {
  if (condition) console.log(`ok - ${name}`);
  else {
    failures += 1;
    console.log(`FAIL - ${name}${extra ? `: ${extra}` : ''}`);
  }
}

interface GitResult {
  code: number;
  out: string;
}

const workRoot = mkdtempSync(join(tmpdir(), 'forge-git-test-'));
const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: workRoot,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

/** Run git in `cwd`; never throws — the exit code and combined output come back for asserting. */
async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run('git', args, { cwd, env: gitEnv, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, out: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

/** Run git and assert it succeeded; returns the combined output. */
async function gitOk(cwd: string, args: string[], name: string): Promise<string> {
  const result = await git(cwd, args);
  check(name, result.code === 0, result.out.trim().split('\n').slice(-3).join(' | '));
  return result.out;
}

async function main(): Promise<void> {
  const store = new Store();
  store.createRepo('adaiversen', 'demo');
  store.createRepo('adaiversen', 'empty');

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    handleGit(req, res, store, url)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"message":"Not Found"}\n');
        }
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  const base = `http://127.0.0.1:${address.port}`;
  const remote = `${base}/adaiversen/demo.git`;
  const authArgs = ['-c', 'http.extraHeader=Authorization: Bearer test-token'];

  try {
    // A missing repository advertises 404 on info/refs.
    const missing = await fetch(`${base}/adaiversen/nope.git/info/refs?service=git-upload-pack`);
    check('missing repo info/refs answers 404', missing.status === 404, `HTTP ${missing.status}`);
    await missing.text();

    // --- the client repository: three commits on main -------------------------------
    const client = join(workRoot, 'client');
    await gitOk(workRoot, ['init', '-b', 'main', client], 'git init client');
    await gitOk(client, ['config', 'user.name', 'Test User'], 'config user.name');
    await gitOk(client, ['config', 'user.email', 'test@example.invalid'], 'config user.email');
    await gitOk(client, ['config', 'http.extraHeader', 'Authorization: Bearer test-token'], 'config auth header');
    await gitOk(client, ['remote', 'add', 'origin', remote], 'remote add origin');

    writeFileSync(join(client, 'a.txt'), 'hello\n');
    mkdirSync(join(client, 'sub'));
    writeFileSync(join(client, 'sub', 'b.txt'), 'nested file\n');
    await gitOk(client, ['add', '.'], 'add first files');
    await gitOk(client, ['commit', '-m', 'one'], 'commit one');
    const sha1 = (await gitOk(client, ['rev-parse', 'HEAD'], 'rev-parse one')).trim();

    const push1 = await git(client, ['push', 'origin', 'main']);
    check('first push to the empty repo succeeds', push1.code === 0, push1.out.trim().split('\n').slice(-3).join(' | '));

    writeFileSync(join(client, 'a.txt'), 'hello\nworld\n');
    writeFileSync(join(client, 'c.txt'), 'third file\n');
    await gitOk(client, ['add', '.'], 'add second change');
    await gitOk(client, ['commit', '-m', 'two'], 'commit two');
    const sha2 = (await gitOk(client, ['rev-parse', 'HEAD'], 'rev-parse two')).trim();
    const push2 = await git(client, ['push', 'origin', 'main']);
    check('fast-forward push succeeds', push2.code === 0, push2.out.trim().split('\n').slice(-3).join(' | '));

    writeFileSync(join(client, 'a.txt'), 'hello\nworld\nagain\n');
    await gitOk(client, ['add', '.'], 'add third change');
    await gitOk(client, ['commit', '-m', 'three'], 'commit three');
    const sha3 = (await gitOk(client, ['rev-parse', 'HEAD'], 'rev-parse three')).trim();
    const push3 = await git(client, ['push', 'origin', 'main']);
    check('second fast-forward push succeeds', push3.code === 0, push3.out.trim().split('\n').slice(-3).join(' | '));

    const remoteRefs = await gitOk(client, ['ls-remote', 'origin'], 'ls-remote');
    check('ls-remote shows main at the third commit', remoteRefs.includes(`${sha3}\trefs/heads/main`), remoteRefs.trim());

    // --- full clone, tree diff -------------------------------------------------------
    const clone1 = join(workRoot, 'clone1');
    const cloned = await git(workRoot, [...authArgs, 'clone', remote, clone1]);
    check('full clone succeeds', cloned.code === 0, cloned.out.trim().split('\n').slice(-3).join(' | '));
    const cloneHead = (await gitOk(clone1, ['rev-parse', 'HEAD'], 'clone rev-parse')).trim();
    check('clone HEAD is the pushed tip', cloneHead === sha3, `${cloneHead} vs ${sha3}`);
    check(
      'cloned file bytes match',
      readFileSync(join(clone1, 'a.txt'), 'utf8') === 'hello\nworld\nagain\n' &&
        readFileSync(join(clone1, 'sub', 'b.txt'), 'utf8') === 'nested file\n' &&
        readFileSync(join(clone1, 'c.txt'), 'utf8') === 'third file\n',
    );
    const clientTree = await gitOk(client, ['ls-tree', '-r', 'HEAD'], 'client ls-tree');
    const cloneTree = await gitOk(clone1, ['ls-tree', '-r', 'HEAD'], 'clone ls-tree');
    check('clone tree equals the pushed tree', clientTree === cloneTree);

    // A v0 fetch against the clone exercises the protocol v0 upload-pack path.
    const fetchV0 = await git(clone1, ['-c', 'protocol.version=0', 'fetch', 'origin', 'main']);
    check('protocol v0 fetch succeeds', fetchV0.code === 0, fetchV0.out.trim().split('\n').slice(-3).join(' | '));

    // --- shallow clone ----------------------------------------------------------------
    const clone2 = join(workRoot, 'clone2');
    const shallowCloned = await git(workRoot, [...authArgs, 'clone', '--depth', '1', remote, clone2]);
    check('shallow clone succeeds', shallowCloned.code === 0, shallowCloned.out.trim().split('\n').slice(-3).join(' | '));
    const shallowHead = (await gitOk(clone2, ['rev-parse', 'HEAD'], 'shallow rev-parse')).trim();
    check('shallow clone HEAD is the tip', shallowHead === sha3, `${shallowHead} vs ${sha3}`);
    const shallowCount = (await gitOk(clone2, ['rev-list', '--count', 'HEAD'], 'shallow rev-list count')).trim();
    check('shallow clone holds exactly one commit', shallowCount === '1', `count ${shallowCount}`);
    check('shallow clone is marked shallow', existsSync(join(clone2, '.git', 'shallow')));

    // --- cloning the still-empty repo ---------------------------------------------------
    const clone3 = join(workRoot, 'clone3');
    const emptyCloned = await git(workRoot, [...authArgs, 'clone', `${base}/adaiversen/empty.git`, clone3]);
    check('empty repo clones cleanly', emptyCloned.code === 0, emptyCloned.out.trim().split('\n').slice(-3).join(' | '));

    // --- non-fast-forward push is refused and moves nothing ------------------------------
    await gitOk(client, ['reset', '--hard', sha1], 'reset to first commit');
    writeFileSync(join(client, 'other.txt'), 'sibling change\n');
    await gitOk(client, ['add', '.'], 'add sibling change');
    await gitOk(client, ['commit', '-m', 'sibling'], 'commit sibling');
    const shaSibling = (await gitOk(client, ['rev-parse', 'HEAD'], 'rev-parse sibling')).trim();
    const refused = await git(client, ['push', 'origin', 'main']);
    check('non-fast-forward push is refused', refused.code !== 0, 'git accepted it');
    check(
      'refusal names non-fast-forward',
      refused.out.includes('non-fast-forward'),
      refused.out.trim().split('\n').slice(-4).join(' | '),
    );
    const afterRefusal = await gitOk(client, ['ls-remote', 'origin'], 'ls-remote after refusal');
    check('the refused push left main unmoved', afterRefusal.includes(`${sha3}\trefs/heads/main`), afterRefusal.trim());
    check('the sibling commit is not on the server', !afterRefusal.includes(shaSibling));

    // --- one push, two refs: one fast-forward, one not ----------------------------------
    await gitOk(client, ['reset', '--hard', sha3], 'reset back to the tip');
    const createSide = await git(client, ['push', 'origin', `${sha3}:refs/heads/side`]);
    check('side branch creation succeeds', createSide.code === 0, createSide.out.trim().split('\n').slice(-3).join(' | '));
    writeFileSync(join(client, 'a.txt'), 'hello\nworld\nagain\nfourth\n');
    await gitOk(client, ['add', '.'], 'add fourth change');
    await gitOk(client, ['commit', '-m', 'four'], 'commit four');
    const sha4 = (await gitOk(client, ['rev-parse', 'HEAD'], 'rev-parse four')).trim();
    const mixed = await git(client, ['push', 'origin', `main:refs/heads/main`, `${shaSibling}:refs/heads/side`]);
    check('the mixed push reports a failure for the refused half', mixed.code !== 0, 'git reported full success');
    const afterMixed = await gitOk(client, ['ls-remote', 'origin'], 'ls-remote after mixed push');
    check('the fast-forward half was applied', afterMixed.includes(`${sha4}\trefs/heads/main`), afterMixed.trim());
    check('the non-fast-forward half was not applied', afterMixed.includes(`${sha3}\trefs/heads/side`), afterMixed.trim());

    // --- branch delete ---------------------------------------------------------------------
    const createFeature = await git(client, ['push', 'origin', `${sha4}:refs/heads/feature`]);
    check('feature branch creation succeeds', createFeature.code === 0, createFeature.out.trim().split('\n').slice(-3).join(' | '));
    const deleted = await git(client, ['push', 'origin', ':refs/heads/feature']);
    check('branch delete push succeeds', deleted.code === 0, deleted.out.trim().split('\n').slice(-3).join(' | '));
    const afterDelete = await gitOk(client, ['ls-remote', 'origin'], 'ls-remote after delete');
    check('the deleted branch is gone', !afterDelete.includes('refs/heads/feature'), afterDelete.trim());
    check('main survived the delete', afterDelete.includes(`${sha4}\trefs/heads/main`), afterDelete.trim());

    // The server is still healthy and the repo still clones after every refusal above.
    const clone4 = join(workRoot, 'clone4');
    const recloned = await git(workRoot, [...authArgs, 'clone', remote, clone4]);
    check('repo still clones after refusals and deletes', recloned.code === 0, recloned.out.trim().split('\n').slice(-3).join(' | '));
    const reclonedHead = (await gitOk(clone4, ['rev-parse', 'HEAD'], 'reclone rev-parse')).trim();
    check('reclone HEAD is the final tip', reclonedHead === sha4, `${reclonedHead} vs ${sha4}`);

    // --- an annotated tag pushes, advertises peeled, and clones -------------------------
    await gitOk(client, ['tag', '-a', 'v1', '-m', 'version one'], 'create annotated tag');
    const pushTag = await git(client, ['push', 'origin', 'v1']);
    check('annotated tag push succeeds', pushTag.code === 0, pushTag.out.trim().split('\n').slice(-3).join(' | '));
    const tagRefs = await gitOk(client, ['ls-remote', 'origin'], 'ls-remote with tag');
    check('the tag ref is advertised', tagRefs.includes('\trefs/tags/v1'), tagRefs.trim());
    check('the tag advertises peeled to its commit', tagRefs.includes(`${sha4}\trefs/tags/v1^{}`), tagRefs.trim());
    const clone5 = join(workRoot, 'clone5');
    const tagCloned = await git(workRoot, [...authArgs, 'clone', remote, clone5]);
    check('clone with a tag succeeds', tagCloned.code === 0, tagCloned.out.trim().split('\n').slice(-3).join(' | '));
    const peeled = (await gitOk(clone5, ['rev-parse', 'v1^{commit}'], 'clone tag peel')).trim();
    check('the cloned tag peels to the tip commit', peeled === sha4, `${peeled} vs ${sha4}`);

    // --- deepen a shallow clone by one generation -----------------------------------------
    const clone6 = join(workRoot, 'clone6');
    const shallow2 = await git(workRoot, [...authArgs, 'clone', '--depth', '1', remote, clone6]);
    check('second shallow clone succeeds', shallow2.code === 0, shallow2.out.trim().split('\n').slice(-3).join(' | '));
    const beforeDeepen = (await gitOk(clone6, ['rev-list', '--count', 'HEAD'], 'count before deepen')).trim();
    check('second shallow clone starts at depth 1', beforeDeepen === '1', `count ${beforeDeepen}`);
    const deepen = await git(clone6, ['fetch', '--deepen=1', 'origin']);
    check('deepen fetch succeeds', deepen.code === 0, deepen.out.trim().split('\n').slice(-3).join(' | '));
    const afterDeepen = (await gitOk(clone6, ['rev-list', '--count', 'HEAD'], 'count after deepen')).trim();
    check('deepen extends the history to depth 2', afterDeepen === '2', `count ${afterDeepen}`);
    const grandparent = await git(clone6, ['cat-file', '-e', sha2]);
    check('the grandparent is still absent after deepen 2', grandparent.code !== 0, 'grandparent object present');
  } finally {
    server.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? 'PASS: all git transport tests green' : `FAIL: ${failures} assertion(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(`FAIL: test run aborted: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
