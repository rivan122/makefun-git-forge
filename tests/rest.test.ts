// End-to-end tests for src/rest.ts: a bare http server that plays app.ts's part (bearer auth,
// then dispatch) in front of handleRest and the real store, driven with fetch.
//
// Run: node --experimental-strip-types tests/rest.test.ts   (exits non-zero on any failure)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleRest } from '../src/rest.ts';
import { Store, VIEWER } from '../src/store.ts';
import { nextRequestId, sendJson } from '../src/util.ts';

const TOKEN = 'rest-test-token';

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${label}${detail === '' ? '' : `: ${detail}`}`);
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

interface Answer {
  status: number;
  body: any;
  headers: Headers;
}

async function main(): Promise<void> {
  const store = new Store();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://entry');
      if (url.pathname === '/api/v3' || url.pathname.startsWith('/api/v3/')) {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          sendJson(res, 401, { message: 'Bad credentials' }, nextRequestId());
          return;
        }
        if (await handleRest(req, res, store, url)) return;
      }
      sendJson(res, 404, { message: 'Not Found' }, nextRequestId());
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;

  async function call(method: string, path: string, body?: unknown, rawBody?: string): Promise<Answer> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
  const unb64 = (text: string): string => Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
  const owner = VIEWER.login;

  try {
    // Root and meta.
    const root = await call('GET', '/api/v3/');
    eq('root status', root.status, 200);
    eq('root scopes header', root.headers.get('x-oauth-scopes'), 'repo, read:org');
    check('root request id', (root.headers.get('x-github-request-id') ?? '') !== '');
    const meta = await call('GET', '/api/v3/meta');
    eq('meta status', meta.status, 200);
    check('meta installed_version', typeof meta.body?.installed_version === 'string' && meta.body.installed_version !== '');
    const me = await call('GET', '/api/v3/user');
    eq('user login', me.body?.login, owner);

    // Repository create/get/patch/delete round-trip.
    const created = await call('POST', '/api/v3/user/repos', { name: 'round-trip', private: true, description: 'first' });
    eq('create status', created.status, 201);
    eq('create name', created.body?.name, 'round-trip');
    eq('create private', created.body?.private, true);
    eq('create full_name', created.body?.full_name, `${owner}/round-trip`);
    check('create default_branch', typeof created.body?.default_branch === 'string' && created.body.default_branch !== '');
    const duplicate = await call('POST', '/api/v3/user/repos', { name: 'round-trip', private: true });
    eq('duplicate create is 422', duplicate.status, 422);
    check('duplicate carries a message', typeof duplicate.body?.message === 'string');

    const repoPath = `/api/v3/repos/${owner}/round-trip`;
    const got = await call('GET', repoPath);
    eq('get status', got.status, 200);
    eq('get description', got.body?.description, 'first');
    const patched = await call('PATCH', repoPath, { description: 'second' });
    eq('patch status', patched.status, 200);
    eq('patch description', patched.body?.description, 'second');
    const foreign = await call('GET', `/api/v3/repos/someone-else/round-trip`);
    eq('foreign owner is 404', foreign.status, 404);

    // Contents: create lands a real git commit and round-trips.
    const put = await call('PUT', `${repoPath}/contents/docs/readme.md`, { message: 'add readme', content: b64('# Hello\n') });
    eq('contents create status', put.status, 201);
    eq('contents encoding', put.body?.content?.encoding, 'base64');
    check('contents commit sha shape', /^[0-9a-f]{40}$/.test(put.body?.commit?.sha ?? ''));
    const rec = store.getRepo(owner, 'round-trip');
    check('store holds the repo', rec !== null && rec !== undefined);
    const tip = rec.git.refs.get(`refs/heads/${rec.default_branch}`);
    eq('git tip is the contents commit', tip, put.body?.commit?.sha);
    const commit = rec.git.commit(tip);
    check('git commit exists', commit !== null && commit !== undefined);

    const readBack = await call('GET', `${repoPath}/contents/docs/readme.md`);
    eq('contents get status', readBack.status, 200);
    eq('contents round-trip', unb64(readBack.body?.content ?? ''), '# Hello\n');
    eq('contents sha matches put', readBack.body?.sha, put.body?.content?.sha);
    eq('contents size', readBack.body?.size, 8);

    const dir = await call('GET', `${repoPath}/contents/docs`);
    eq('directory status', dir.status, 200);
    check('directory lists readme', Array.isArray(dir.body) && dir.body.some((e: any) => e.name === 'readme.md' && e.type === 'file'));

    // Update with the right sha, then a stale sha is a 409.
    const update = await call('PUT', `${repoPath}/contents/docs/readme.md`, { message: 'revise', content: b64('# Hello again\n'), sha: readBack.body?.sha });
    eq('contents update status', update.status, 200);
    const stale = await call('PUT', `${repoPath}/contents/docs/readme.md`, { message: 'stale', content: b64('nope\n'), sha: readBack.body?.sha });
    eq('stale sha is 409', stale.status, 409);
    check('409 carries a message', typeof stale.body?.message === 'string');

    // Contents delete.
    const afterUpdate = await call('GET', `${repoPath}/contents/docs/readme.md`);
    const deleted = await call('DELETE', `${repoPath}/contents/docs/readme.md`, { message: 'remove', sha: afterUpdate.body?.sha });
    eq('contents delete status', deleted.status, 200);
    check('contents delete commit sha', /^[0-9a-f]{40}$/.test(deleted.body?.commit?.sha ?? ''));
    const gone = await call('GET', `${repoPath}/contents/docs/readme.md`);
    eq('deleted file is 404', gone.status, 404);

    // Labels and issues.
    const label = await call('POST', `${repoPath}/labels`, { name: 'bug', color: 'd73a4a', description: 'Something is broken' });
    eq('label create status', label.status, 201);
    eq('label name', label.body?.name, 'bug');
    eq('label color', label.body?.color, 'd73a4a');
    const labels = await call('GET', `${repoPath}/labels`);
    check('label list contains bug', Array.isArray(labels.body) && labels.body.some((l: any) => l.name === 'bug'));

    const issue = await call('POST', `${repoPath}/issues`, { title: 'It broke', body: 'Steps...', labels: ['bug'] });
    eq('issue create status', issue.status, 201);
    eq('issue number', issue.body?.number, 1);
    eq('issue state', issue.body?.state, 'open');
    check('issue carries the label', Array.isArray(issue.body?.labels) && issue.body.labels.some((l: any) => l.name === 'bug'));
    const badIssue = await call('POST', `${repoPath}/issues`, { title: 'Nope', labels: ['no-such-label'] });
    eq('unknown label is 422', badIssue.status, 422);

    const comment = await call('POST', `${repoPath}/issues/1/comments`, { body: 'Looking into it' });
    eq('comment create status', comment.status, 201);
    eq('comment body', comment.body?.body, 'Looking into it');
    check('comment id', Number.isInteger(comment.body?.id) && comment.body.id >= 1);
    const comments = await call('GET', `${repoPath}/issues/1/comments`);
    check('comments list', Array.isArray(comments.body) && comments.body.length === 1 && comments.body[0].body === 'Looking into it');

    const closed = await call('PATCH', `${repoPath}/issues/1`, { state: 'closed' });
    eq('issue close status', closed.status, 200);
    eq('issue closed', closed.body?.state, 'closed');
    const openList = await call('GET', `${repoPath}/issues?state=open`);
    check('open list omits closed', Array.isArray(openList.body) && openList.body.length === 0);
    const allList = await call('GET', `${repoPath}/issues?state=all`);
    check('all list has the issue', Array.isArray(allList.body) && allList.body.length === 1);

    // Pull request flow on a second repository.
    const prRepo = await call('POST', '/api/v3/user/repos', { name: 'pr-flow', private: true, description: 'pr' });
    eq('pr repo create', prRepo.status, 201);
    const prPath = `/api/v3/repos/${owner}/pr-flow`;
    const basePut = await call('PUT', `${prPath}/contents/src/app.txt`, { message: 'base', content: b64('one\n') });
    eq('base contents', basePut.status, 201);
    const baseSha = basePut.body?.commit?.sha;
    const repoView = await call('GET', prPath);
    const defaultBranch = repoView.body?.default_branch;

    const ref = await call('POST', `${prPath}/git/refs`, { ref: 'refs/heads/feature', sha: baseSha });
    eq('create ref status', ref.status, 201);
    eq('create ref name', ref.body?.ref, 'refs/heads/feature');
    const refRead = await call('GET', `${prPath}/git/refs/heads/feature`);
    eq('read ref sha', refRead.body?.object?.sha, baseSha);
    const branchRead = await call('GET', `${prPath}/branches/feature`);
    eq('read branch sha', branchRead.body?.commit?.sha, baseSha);

    const headPut = await call('PUT', `${prPath}/contents/src/app.txt`, { message: 'change', content: b64('one\ntwo\n'), branch: 'feature', sha: basePut.body?.content?.sha });
    eq('head contents update', headPut.status, 200);
    const extraPut = await call('PUT', `${prPath}/contents/src/extra.txt`, { message: 'extra', content: b64('new file\n'), branch: 'feature' });
    eq('head contents create', extraPut.status, 201);

    const branches = await call('GET', `${prPath}/branches`);
    check('branches list', Array.isArray(branches.body) && branches.body.some((b: any) => b.name === 'feature') && branches.body.some((b: any) => b.name === defaultBranch));

    const commits = await call('GET', `${prPath}/commits?sha=feature`);
    check('commits list newest first', Array.isArray(commits.body) && commits.body[0]?.sha === extraPut.body?.commit?.sha);
    eq('commit message', commits.body?.[0]?.commit?.message, 'extra');

    const pull = await call('POST', `${prPath}/pulls`, { title: 'Add two', body: 'Please review', head: 'feature', base: defaultBranch });
    eq('pull create status', pull.status, 201);
    eq('pull state', pull.body?.state, 'open');
    eq('pull head ref', pull.body?.head?.ref, 'feature');
    eq('pull head sha', pull.body?.head?.sha, extraPut.body?.commit?.sha);
    eq('pull base sha', pull.body?.base?.sha, baseSha);
    const prNumber = pull.body?.number;

    const files = await call('GET', `${prPath}/pulls/${prNumber}/files`);
    eq('files status', files.status, 200);
    const appFile = Array.isArray(files.body) ? files.body.find((f: any) => f.filename === 'src/app.txt') : undefined;
    const extraFile = Array.isArray(files.body) ? files.body.find((f: any) => f.filename === 'src/extra.txt') : undefined;
    eq('modified file status', appFile?.status, 'modified');
    eq('modified additions', appFile?.additions, 1);
    eq('added file status', extraFile?.status, 'added');
    check('added additions >= 1', (extraFile?.additions ?? 0) >= 1);

    const merge = await call('PUT', `${prPath}/pulls/${prNumber}/merge`, { merge_method: 'squash' });
    eq('merge status', merge.status, 200);
    eq('merge merged', merge.body?.merged, true);
    check('merge sha shape', /^[0-9a-f]{40}$/.test(merge.body?.sha ?? ''));
    const prRec = store.getRepo(owner, 'pr-flow');
    eq('base tip is the merge sha', prRec.git.refs.get(`refs/heads/${defaultBranch}`), merge.body?.sha);
    const mergedView = await call('GET', `${prPath}/pulls/${prNumber}`);
    eq('pull closed after merge', mergedView.body?.state, 'closed');
    eq('pull merged flag', mergedView.body?.merged, true);
    eq('pull merge_commit_sha', mergedView.body?.merge_commit_sha, merge.body?.sha);
    check('pull merged_at', typeof mergedView.body?.merged_at === 'string' && mergedView.body.merged_at !== '');
    const onDefault = await call('GET', `${prPath}/contents/src/extra.txt?ref=${defaultBranch}`);
    eq('merged content on default', unb64(onDefault.body?.content ?? ''), 'new file\n');

    const unknownMerge = await call('PUT', `${prPath}/pulls/999999/merge`, { merge_method: 'squash' });
    eq('merge unknown is 404', unknownMerge.status, 404);
    const unknownPull = await call('GET', `${prPath}/pulls/999999`);
    eq('get unknown pull is 404', unknownPull.status, 404);

    // Commits isolation: the default branch list must not show branch-only commits.
    const defaultCommits = await call('GET', `${prPath}/commits`);
    check('default commits omit branch-only commit', Array.isArray(defaultCommits.body) && !defaultCommits.body.some((c: any) => c.sha === extraPut.body?.commit?.sha));
    check('default commits include the merge', Array.isArray(defaultCommits.body) && defaultCommits.body.some((c: any) => c.sha === merge.body?.sha));

    // Merge conflict: two branches change the same file from the same base; the second merge is 405.
    const cfRepo = await call('POST', '/api/v3/user/repos', { name: 'conflict-flow', private: true });
    eq('conflict repo create', cfRepo.status, 201);
    const cfPath = `/api/v3/repos/${owner}/conflict-flow`;
    const cfBase = await call('PUT', `${cfPath}/contents/f.txt`, { message: 'base', content: b64('seed\n') });
    const cfBaseSha = cfBase.body?.commit?.sha;
    const cfRepoView = await call('GET', cfPath);
    const cfDefault = cfRepoView.body?.default_branch;
    for (const side of ['a', 'b']) {
      const r = await call('POST', `${cfPath}/git/refs`, { ref: `refs/heads/side-${side}`, sha: cfBaseSha });
      eq(`conflict ref ${side}`, r.status, 201);
      const w = await call('PUT', `${cfPath}/contents/f.txt`, { message: `side ${side}`, content: b64(`seed (${side})\n`), branch: `side-${side}`, sha: cfBase.body?.content?.sha });
      eq(`conflict write ${side}`, w.status, 200);
    }
    const cfPullA = await call('POST', `${cfPath}/pulls`, { title: 'A', head: 'side-a', base: cfDefault });
    const cfPullB = await call('POST', `${cfPath}/pulls`, { title: 'B', head: 'side-b', base: cfDefault });
    eq('conflict pull A', cfPullA.status, 201);
    eq('conflict pull B', cfPullB.status, 201);
    const cfMergeA = await call('PUT', `${cfPath}/pulls/${cfPullA.body?.number}/merge`, { merge_method: 'squash' });
    eq('first merge ok', cfMergeA.status, 200);
    const cfMergeB = await call('PUT', `${cfPath}/pulls/${cfPullB.body?.number}/merge`, { merge_method: 'squash' });
    eq('conflicted merge is 405', cfMergeB.status, 405);
    check('405 carries a message', typeof cfMergeB.body?.message === 'string');
    const cfPullsDefault = await call('GET', `${cfPath}/pulls`);
    check('pulls default lists open only', Array.isArray(cfPullsDefault.body) && cfPullsDefault.body.length === 1 && cfPullsDefault.body[0].number === cfPullB.body?.number);
    const cfPullsAll = await call('GET', `${cfPath}/pulls?state=all`);
    check('pulls state=all lists both', Array.isArray(cfPullsAll.body) && cfPullsAll.body.length === 2);

    // Issue sort order by creation, both directions.
    const sRepo = await call('POST', '/api/v3/user/repos', { name: 'sort-flow', private: true });
    eq('sort repo create', sRepo.status, 201);
    const sPath = `/api/v3/repos/${owner}/sort-flow`;
    for (const t of ['one', 'two', 'three']) {
      const made = await call('POST', `${sPath}/issues`, { title: t, body: 'x' });
      eq(`sort issue ${t}`, made.status, 201);
    }
    const asc = await call('GET', `${sPath}/issues?state=open&sort=created&direction=asc&per_page=100`);
    check('sort asc', Array.isArray(asc.body) && asc.body.map((i: any) => i.number).join(',') === '1,2,3');
    const desc = await call('GET', `${sPath}/issues?state=open&sort=created&direction=desc&per_page=100`);
    check('sort desc', Array.isArray(desc.body) && desc.body.map((i: any) => i.number).join(',') === '3,2,1');

    // Repository delete round-trip.
    const del = await call('DELETE', repoPath);
    eq('repo delete status', del.status, 204);
    const afterDelete = await call('GET', repoPath);
    eq('repo gone after delete', afterDelete.status, 404);

    // Pagination: 35 more repositories at per_page=10 through Link rel="next".
    for (let i = 0; i < 35; i += 1) store.createRepo(owner, `page-${String(i).padStart(2, '0')}`, {});
    const seen = new Set<string>();
    let next: string | null = `${base}/api/v3/user/repos?per_page=10`;
    let pages = 0;
    while (next !== null && pages < 20) {
      pages += 1;
      const res = await fetch(next, { headers: { authorization: `Bearer ${TOKEN}` } });
      eq(`page ${pages} status`, res.status, 200);
      const items: any[] = await res.json();
      check(`page ${pages} size <= 10`, items.length <= 10);
      for (const item of items) {
        check(`no repeat of ${item.name}`, !seen.has(item.name));
        seen.add(item.name);
      }
      const link = res.headers.get('link') ?? '';
      const match = /<([^>]+)>;\s*rel="next"/.exec(link);
      next = match ? (match[1] as string) : null;
    }
    check('pagination walked at least 4 pages', pages >= 4, `pages=${pages}`);
    check('pagination saw every repo', seen.size >= 36, `seen=${seen.size}`);

    // Protocol: unknown route is a JSON 404, malformed JSON is a 400.
    const unknown = await call('GET', '/api/v3/no-such-route');
    eq('unknown route status', unknown.status, 404);
    check('unknown route message', typeof unknown.body?.message === 'string');
    check('unknown route request id', (unknown.headers.get('x-github-request-id') ?? '') !== '');
    const malformed = await call('POST', '/api/v3/user/repos', undefined, '{"name":');
    eq('malformed body status', malformed.status, 400);
    check('malformed body message', typeof malformed.body?.message === 'string');
  } finally {
    server.close();
  }

  console.log(`${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

await main();
