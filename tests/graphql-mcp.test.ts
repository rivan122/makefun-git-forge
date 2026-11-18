// Tests for src/graphql.ts and src/mcp.ts against the real store: a bare http server dispatching to
// the two handlers, the GraphQL documents copied verbatim from the sealed checks-graphql.ts, and MCP
// exchanges framed the way mcp-client.ts frames them. Run: node --experimental-strip-types
// tests/graphql-mcp.test.ts — exits non-zero on the first failed batch of assertions.

import { createServer } from 'node:http';
import { Store, VIEWER } from '../src/store.ts';
import { handleGraphQL } from '../src/graphql.ts';
import { handleMcp } from '../src/mcp.ts';

let failures = 0;
let checks = 0;

function ok(condition: boolean, label: string, detail?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`ok ${checks} - ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${checks} - ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
  }
}

function eq(actual: unknown, expected: unknown, label: string): void {
  ok(actual === expected, label, { actual, expected });
}

// ---------------------------------------------------------------------------------------------------------
// The fixture: one repository with a git history (base + three head branches), issues and pull requests,
// plus a second repository holding seven issues for pagination. Built with the store's own verbs.
// ---------------------------------------------------------------------------------------------------------

const store = new Store();
const OWNER = VIEWER.login;
const AUTHOR_LINE = 'ada iversen <adaiversen@example.invalid> 1700000000 +0000';

function commitFiles(git: any, files: Record<string, string>, parents: string[], message: string): string {
  const tree = git.makeTreeFromFiles(new Map(Object.entries(files).map(([path, content]) => [path, Buffer.from(content, 'utf8')])));
  return git.makeCommit(tree, parents, message, AUTHOR_LINE);
}

function seedRepo(name: string): any {
  const repo = store.createRepo(OWNER, name, { private: false, description: 'fixture' });
  const git = repo.git;
  const baseFiles = { 'base.txt': 'base\n', 'README.md': 'readme\n' };
  const c1 = commitFiles(git, baseFiles, [], 'first commit');
  git.refs.set('refs/heads/main', c1);
  git.refs.set('refs/heads/feature', commitFiles(git, { ...baseFiles, 'feature.txt': 'feature\n' }, [c1], 'feature work'));
  git.refs.set('refs/heads/create-branch', commitFiles(git, { ...baseFiles, 'feature.txt.create': 'create\n' }, [c1], 'create branch'));
  git.refs.set('refs/heads/merge-branch', commitFiles(git, { ...baseFiles, 'feature.txt.merge': 'merge\n' }, [c1], 'merge branch'));
  return repo;
}

const repo = seedRepo('fixture');
const openIssues: number[] = [];
for (let i = 1; i <= 3; i += 1) openIssues.push(store.addIssue(repo, { title: `seeded open ${i}`, body: 'seeded body' }).number);
const closedIssue = store.addIssue(repo, { title: 'seeded closed', body: 'seeded body' });
closedIssue.state = 'closed';
const fixturePull = store.addPull(repo, { title: 'fixture pull request', body: 'seeded body', headRef: 'feature', baseRef: 'main' });
const mergePull = store.addPull(repo, { title: 'merge pull request', body: 'seeded body', headRef: 'merge-branch', baseRef: 'main' });

const pagesRepo = store.createRepo(OWNER, 'fixture-pages', { private: false });
const pageNumbers: number[] = [];
for (let i = 1; i <= 7; i += 1) pageNumbers.push(store.addIssue(pagesRepo, { title: `page ${i}`, body: 'seeded body' }).number);

// ---------------------------------------------------------------------------------------------------------
// The server and the wire helpers.
// ---------------------------------------------------------------------------------------------------------

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://entry');
  const done = (err: unknown): void => {
    if (err !== null && err !== undefined) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  };
  if (url.pathname === '/api/graphql') {
    handleGraphQL(req, res, store, url).then(() => done(null), done);
    return;
  }
  if (url.pathname === '/mcp') {
    handleMcp(req, res, store, url).then(() => done(null), done);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"message":"Not Found"}');
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('no port');
const BASE = `http://127.0.0.1:${address.port}`;

async function gql(document: string, variables: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify({ query: document, variables }),
  });
  return { status: res.status, body: JSON.parse(await res.text()) };
}

async function rpc(message: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer test' },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

function toolText(outcome: any): any {
  const text = outcome?.result?.content?.[0]?.text;
  return typeof text === 'string' ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------------------------------------
// The GraphQL documents, verbatim from checks-graphql.ts.
// ---------------------------------------------------------------------------------------------------------

const VIEWER_LOGIN = `query ViewerLogin {
  viewer {
    login
  }
}`;

const REPOSITORY_FIELDS = `query RepositoryFields($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    databaseId
    name
    owner {
      login
    }
    defaultBranchRef {
      name
    }
    viewerPermission
    hasIssuesEnabled
  }
}`;

const ISSUE_FIELDS = `query Issue_fields {
  Issue: __type(name: "Issue") {
    fields(includeDeprecated: true) {
      name
    }
  }
}`;

const TYPE_FIELDS = `query PullRequestAndRepositoryFields {
  PullRequest: __type(name: "PullRequest") {
    fields(includeDeprecated: true) {
      name
    }
  }
  Repository: __type(name: "Repository") {
    fields(includeDeprecated: true) {
      name
    }
  }
}`;

const SEARCH_TYPE_ENUM_VALUES = `query SearchType_enumValues {
  SearchType: __type(name: "SearchType") {
    enumValues(includeDeprecated: true) {
      name
    }
  }
}`;

const OPEN_ISSUES = `query OpenIssues($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        title
        state
        id
      }
    }
  }
}`;

const ISSUE_BY_NUMBER = `query IssueByNumber($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      title
      state
      id
      body
    }
  }
}`;

const CREATE_ISSUE = `mutation IssueCreate($input: CreateIssueInput!) {
  createIssue(input: $input) {
    issue {
      number
      id
    }
  }
}`;

const CLOSE_ISSUE = `mutation IssueClose($input: CloseIssueInput!) {
  closeIssue(input: $input) {
    issue {
      number
      id
      state
    }
  }
}`;

const PULL_REQUESTS = `query PullRequests($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first) {
      nodes {
        number
        headRefName
        baseRefName
        mergeable
        state
      }
    }
  }
}`;

const PULL_REQUEST_FILES = `query PullRequestFiles($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      files(first: 10) {
        nodes {
          path
        }
      }
    }
  }
}`;

const PULL_REQUEST_ID = `query PullRequestId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
    }
  }
}`;

const CREATE_PULL_REQUEST = `mutation PullRequestCreate($input: CreatePullRequestInput!) {
  createPullRequest(input: $input) {
    pullRequest {
      number
      id
      state
      headRefName
      baseRefName
    }
  }
}`;

const MERGE_PULL_REQUEST = `mutation MergePullRequest($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) {
    pullRequest {
      number
      merged
      state
    }
  }
}`;

const ADD_COMMENT = `mutation AddComment($input: AddCommentInput!) {
  addComment(input: $input) {
    commentEdge {
      node {
        id
        body
      }
    }
  }
}`;

const INVALID_FIELD = `query ViewerInvalidField {
  viewer {
    login
    noSuchFieldOnViewer
  }
}`;

const NODE_REPOSITORY = `query NodeRepository($id: ID!) {
  node(id: $id) {
    id
    ... on Repository {
      name
      nameWithOwner
    }
  }
}`;

const ISSUES_PAGE = `query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after) {
      nodes {
        number
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

// ---------------------------------------------------------------------------------------------------------
// GraphQL assertions.
// ---------------------------------------------------------------------------------------------------------

{
  const { body } = await gql(VIEWER_LOGIN);
  eq(body.data?.viewer?.login, OWNER, 'graphql: viewer.login is the token owner');
  ok(body.errors === undefined, 'graphql: viewer login carries no errors');
}

let repoGlobalId = '';
{
  const { body } = await gql(REPOSITORY_FIELDS, { owner: OWNER, name: 'fixture' });
  const repository = body.data?.repository;
  ok(repository !== null && repository !== undefined, 'graphql: repository reads back', body);
  repoGlobalId = repository.id;
  ok(typeof repoGlobalId === 'string' && repoGlobalId !== '', 'graphql: repository id is a non-empty string');
  ok(repoGlobalId !== String(repository.databaseId), 'graphql: repository id is opaque, not the databaseId');
  eq(repository.databaseId, repo.id, 'graphql: databaseId is the store id');
  eq(repository.name, 'fixture', 'graphql: repository name');
  eq(repository.owner?.login, OWNER, 'graphql: repository owner login');
  eq(repository.defaultBranchRef?.name, 'main', 'graphql: defaultBranchRef names the pushed branch');
  ok(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'].includes(repository.viewerPermission), 'graphql: viewerPermission is a valid enum');
  eq(repository.hasIssuesEnabled, true, 'graphql: hasIssuesEnabled is true');

  const again = await gql(REPOSITORY_FIELDS, { owner: OWNER, name: 'fixture' });
  eq(again.body.data?.repository?.id, repoGlobalId, 'graphql: repository global id is stable across reads');
}

{
  const { body } = await gql(ISSUE_FIELDS);
  const names = (body.data?.Issue?.fields ?? []).map((field: any) => field.name);
  for (const wanted of ['id', 'number', 'title', 'state', 'body']) ok(names.includes(wanted), `graphql: Issue lists ${wanted}`, names);
}
{
  const { body } = await gql(TYPE_FIELDS);
  const prNames = (body.data?.PullRequest?.fields ?? []).map((field: any) => field.name);
  for (const wanted of ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files']) {
    ok(prNames.includes(wanted), `graphql: PullRequest lists ${wanted}`, prNames);
  }
  const repoNames = (body.data?.Repository?.fields ?? []).map((field: any) => field.name);
  for (const wanted of ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']) {
    ok(repoNames.includes(wanted), `graphql: Repository lists ${wanted}`, repoNames);
  }
  const search = await gql(SEARCH_TYPE_ENUM_VALUES);
  const enumNames = (search.body.data?.SearchType?.enumValues ?? []).map((entry: any) => entry.name);
  ok(enumNames.includes('ISSUE'), 'graphql: SearchType enumValues include ISSUE', enumNames);
}

{
  const { body } = await gql(OPEN_ISSUES, { owner: OWNER, name: 'fixture', first: 10 });
  const nodes = body.data?.repository?.issues?.nodes ?? [];
  eq(nodes.length, 3, 'graphql: OPEN issues list holds the three open issues');
  ok(nodes.every((node: any) => node.state === 'OPEN'), 'graphql: OPEN issues are all OPEN');
  const numbers = nodes.map((node: any) => node.number);
  ok(numbers.every((n: number, i: number) => i === 0 || numbers[i - 1] >= n), 'graphql: OPEN issues are CREATED_AT DESC (number DESC)', numbers);
  ok(!numbers.includes(closedIssue.number), 'graphql: the closed issue is excluded from the OPEN list');
  for (const number of openIssues) ok(numbers.includes(number), `graphql: OPEN list holds #${number}`);
  ok(nodes.every((node: any) => typeof node.id === 'string' && node.id !== '' && node.id !== String(node.number)), 'graphql: issue ids are opaque');
}

{
  const { body } = await gql(ISSUE_BY_NUMBER, { owner: OWNER, name: 'fixture', number: openIssues[0] });
  const issue = body.data?.repository?.issue;
  eq(issue?.number, openIssues[0], 'graphql: issue(number:) number');
  eq(issue?.title, 'seeded open 1', 'graphql: issue(number:) title');
  eq(issue?.state, 'OPEN', 'graphql: issue(number:) state');
  eq(issue?.body, 'seeded body', 'graphql: issue(number:) body');
}

{
  const first = await gql(ISSUES_PAGE, { owner: OWNER, name: 'fixture-pages', first: 5, after: null });
  const firstConn = first.body.data?.repository?.issues;
  eq(firstConn?.nodes?.length, 5, 'graphql: first page holds 5 issues');
  eq(firstConn?.pageInfo?.hasNextPage, true, 'graphql: first page hasNextPage');
  const cursor = firstConn?.pageInfo?.endCursor;
  ok(typeof cursor === 'string' && cursor !== '', 'graphql: first page endCursor is non-empty');
  const second = await gql(ISSUES_PAGE, { owner: OWNER, name: 'fixture-pages', first: 5, after: cursor });
  const secondConn = second.body.data?.repository?.issues;
  eq(secondConn?.nodes?.length, 2, 'graphql: second page holds the remaining 2 issues');
  eq(secondConn?.pageInfo?.hasNextPage, false, 'graphql: second page hasNextPage is false');
  const seen = new Set([...(firstConn?.nodes ?? []), ...(secondConn?.nodes ?? [])].map((node: any) => node.number));
  eq(seen.size, 7, 'graphql: pages are disjoint and complete');
  for (const number of pageNumbers) ok(seen.has(number), `graphql: pages hold #${number}`);
}

{
  const { body } = await gql(NODE_REPOSITORY, { id: repoGlobalId });
  eq(body.data?.node?.id, repoGlobalId, 'graphql: node(id:) round-trips the repository id');
  eq(body.data?.node?.name, 'fixture', 'graphql: node(id:) name via inline fragment');
  eq(body.data?.node?.nameWithOwner, `${OWNER}/fixture`, 'graphql: node(id:) nameWithOwner');
}

{
  const { body } = await gql(REPOSITORY_FIELDS, { owner: OWNER, name: 'fixture-missing' });
  eq(body.data?.repository, null, 'graphql: unknown repository is data.repository = null');
  ok(body.errors === undefined, 'graphql: unknown repository carries no errors', body);
  const cross = await gql(REPOSITORY_FIELDS, { owner: 'someoneelse', name: 'fixture' });
  eq(cross.body.data?.repository, null, 'graphql: a repository under another owner reads as nonexistent');
}

{
  const { status, body } = await gql(INVALID_FIELD);
  eq(status, 200, 'graphql: invalid field answers HTTP 200');
  ok(Array.isArray(body.errors) && body.errors.some((error: any) => String(error.message).includes('noSuchFieldOnViewer')), 'graphql: invalid field errors name the field', body);
}

{
  const res = await fetch(`${BASE}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify([{ query: VIEWER_LOGIN, variables: {} }, { query: ISSUE_FIELDS, variables: {} }]),
  });
  eq(res.status, 200, 'graphql: batch answers HTTP 200');
  const body = JSON.parse(await res.text());
  ok(Array.isArray(body) && body.length === 2, 'graphql: batch answers two envelopes', body);
  eq(body[0]?.data?.viewer?.login, OWNER, 'graphql: batch first envelope is the viewer operation');
  ok((body[1]?.data?.Issue?.fields ?? []).length > 0, 'graphql: batch second envelope is the introspection operation');
}

// Mutations.
{
  const { body } = await gql(CREATE_ISSUE, { input: { repositoryId: repoGlobalId, title: 'created over graphql', body: 'seeded body' } });
  const number = body.data?.createIssue?.issue?.number;
  ok(typeof number === 'number' && number > 0, 'graphql: createIssue answers a number', body);
  const stored = repo.issues.get(number);
  eq(stored?.title, 'created over graphql', 'graphql: createIssue is the same object in the store');
  eq(stored?.state, 'open', 'graphql: createIssue reads open in the store');

  const idRead = await gql(ISSUE_BY_NUMBER, { owner: OWNER, name: 'fixture', number });
  const globalIdOfCreated = idRead.body.data?.repository?.issue?.id;
  const closed = await gql(CLOSE_ISSUE, { input: { issueId: globalIdOfCreated } });
  eq(closed.body.data?.closeIssue?.issue?.state, 'CLOSED', 'graphql: closeIssue answers CLOSED', closed.body);
  eq(repo.issues.get(number)?.state, 'closed', 'graphql: closeIssue closes the stored issue');
}

{
  const { body } = await gql(PULL_REQUESTS, { owner: OWNER, name: 'fixture', first: 5 });
  const nodes = body.data?.repository?.pullRequests?.nodes ?? [];
  const node = nodes.find((entry: any) => entry.number === fixturePull.number);
  ok(node !== undefined, 'graphql: pullRequests lists the fixture pull request', nodes);
  eq(node?.headRefName, 'feature', 'graphql: pullRequests headRefName');
  eq(node?.baseRefName, 'main', 'graphql: pullRequests baseRefName');
  eq(node?.state, 'OPEN', 'graphql: pullRequests state');
  ok(['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(node?.mergeable), 'graphql: pullRequests mergeable is a valid enum', node);
  eq(node?.mergeable, 'MERGEABLE', 'graphql: a clean pull request is MERGEABLE');
}

{
  const { body } = await gql(PULL_REQUEST_FILES, { owner: OWNER, name: 'fixture', number: fixturePull.number });
  const paths = (body.data?.repository?.pullRequest?.files?.nodes ?? []).map((entry: any) => entry.path);
  ok(paths.includes('feature.txt'), 'graphql: pullRequest files include the changed path', paths);
  eq(paths.length, 1, 'graphql: pullRequest files hold exactly the changed path', paths);
}

{
  const { body } = await gql(CREATE_PULL_REQUEST, {
    input: { repositoryId: repoGlobalId, baseRefName: 'main', headRefName: 'create-branch', title: 'created over graphql' },
  });
  const pull = body.data?.createPullRequest?.pullRequest;
  ok(typeof pull?.number === 'number', 'graphql: createPullRequest answers a number', body);
  eq(pull?.state, 'OPEN', 'graphql: createPullRequest state');
  eq(pull?.headRefName, 'create-branch', 'graphql: createPullRequest headRefName');
  eq(pull?.baseRefName, 'main', 'graphql: createPullRequest baseRefName');
  const stored = repo.issues.get(pull.number);
  eq(stored?.pull?.headRef, 'create-branch', 'graphql: createPullRequest reads back in the store with the same head');
  eq(stored?.pull?.baseRef, 'main', 'graphql: createPullRequest reads back in the store with the same base');
}

{
  const target = repo.issues.get(openIssues[1]);
  const before = target.comments.length;
  const idRead = await gql(ISSUE_BY_NUMBER, { owner: OWNER, name: 'fixture', number: openIssues[1] });
  const issueId = idRead.body.data?.repository?.issue?.id;
  const { body } = await gql(ADD_COMMENT, { input: { subjectId: issueId, body: 'a comment over graphql' } });
  const node = body.data?.addComment?.commentEdge?.node;
  eq(node?.body, 'a comment over graphql', 'graphql: addComment echoes the body', body);
  ok(typeof node?.id === 'string' && node.id !== '', 'graphql: addComment answers a comment id');
  eq(target.comments.length, before + 1, 'graphql: addComment lands in the store');
  eq(target.comments[target.comments.length - 1]?.body, 'a comment over graphql', 'graphql: the stored comment holds the body');
}

{
  const idRead = await gql(PULL_REQUEST_ID, { owner: OWNER, name: 'fixture', number: mergePull.number });
  const pullId = idRead.body.data?.repository?.pullRequest?.id;
  ok(typeof pullId === 'string' && pullId !== '', 'graphql: pullRequest id reads back');
  const mainBefore = repo.git.refs.get('refs/heads/main');
  const { body } = await gql(MERGE_PULL_REQUEST, { input: { pullRequestId: pullId, mergeMethod: 'SQUASH' } });
  const merged = body.data?.mergePullRequest?.pullRequest;
  eq(merged?.merged, true, 'graphql: mergePullRequest answers merged: true', body);
  eq(merged?.state, 'MERGED', 'graphql: mergePullRequest answers state MERGED');
  const stored = repo.issues.get(mergePull.number);
  eq(stored?.pull?.merged, true, 'graphql: the stored pull request is merged');
  eq(stored?.state, 'closed', 'graphql: the stored pull request is closed after the merge');
  const mainAfter = repo.git.refs.get('refs/heads/main');
  ok(mainAfter !== undefined && mainAfter !== mainBefore, 'graphql: the merge moved the base branch ref');
  const mergedTree = repo.git.flattenTree(repo.git.commit(mainAfter)?.tree ?? '');
  ok(mergedTree.has('feature.txt.merge'), 'graphql: the merged tree holds the head file');
  ok(mergedTree.has('base.txt'), 'graphql: the merged tree keeps the base file');
}

// ---------------------------------------------------------------------------------------------------------
// MCP assertions.
// ---------------------------------------------------------------------------------------------------------

{
  const { status, body } = await rpc({ jsonrpc: '2.0', id: 'discover-1', method: 'server/discover', params: {} });
  eq(status, 200, 'mcp: server/discover answers HTTP 200');
  const result = body?.result;
  ok(Array.isArray(result?.supportedVersions) && result.supportedVersions.length > 0, 'mcp: discover supportedVersions is non-empty', result);
  ok(result.supportedVersions.every((v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)), 'mcp: supportedVersions are YYYY-MM-DD revisions');
  ok(result.supportedVersions.includes('2026-07-28'), 'mcp: supportedVersions include 2026-07-28');
  ok(typeof result?.serverInfo?.name === 'string' && result.serverInfo.name !== '', 'mcp: discover serverInfo.name');
  ok(typeof result?.serverInfo?.version === 'string' && result.serverInfo.version !== '', 'mcp: discover serverInfo.version');
  ok(result?.capabilities?.tools !== undefined, 'mcp: discover capabilities.tools is present');
  eq(body?.id, 'discover-1', 'mcp: discover echoes the request id');
}

{
  const init = await rpc({ jsonrpc: '2.0', id: 'initialize-1', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  eq(init.body?.result?.protocolVersion, '2025-11-25', 'mcp: initialize negotiates 2025-11-25');
  ok(init.body?.result?.capabilities?.tools !== undefined, 'mcp: initialize capabilities.tools is present');
  ok(typeof init.body?.result?.serverInfo?.name === 'string' && init.body.result.serverInfo.name !== '', 'mcp: initialize serverInfo.name');
  const older = await rpc({ jsonrpc: '2.0', id: 'initialize-2', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  eq(older.body?.result?.protocolVersion, '2025-06-18', 'mcp: initialize negotiates 2025-06-18');
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
  });
  eq(res.status, 202, 'mcp: notifications/initialized answers a bare 202');
  eq(await res.text(), '', 'mcp: the 202 carries no body');
}

let toolsList: any[] = [];
{
  const first = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const second = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  toolsList = first.body?.result?.tools ?? [];
  ok(toolsList.length >= 6, 'mcp: tools/list offers at least six tools', toolsList.length);
  for (const wanted of ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']) {
    ok(toolsList.some((entry: any) => entry.name === wanted), `mcp: tools/list offers ${wanted}`);
  }
  for (const entry of toolsList) {
    ok(typeof entry.description === 'string' && entry.description !== '', `mcp: ${entry.name} has a description`);
    eq(entry.inputSchema?.type, 'object', `mcp: ${entry.name} inputSchema is an object schema`);
  }
  eq(JSON.stringify(second.body?.result?.tools), JSON.stringify(toolsList), 'mcp: two tools/list answers are byte-identical');
}

{
  const created = await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'mcp-parity', description: 'parity repo', private: true } } });
  const view = toolText(created.body);
  eq(view?.full_name, `${OWNER}/mcp-parity`, 'mcp: create_repo answers the REST-shaped repository', view);
  const stored = store.getRepo(OWNER, 'mcp-parity');
  ok(stored !== undefined, 'mcp: create_repo lands in the store');
  eq(view?.id, stored?.id, 'mcp: the created repository id matches the store');

  const fetched = await rpc({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_repo', arguments: { owner: OWNER, repo: 'mcp-parity' } } });
  eq(toolText(fetched.body)?.full_name, `${OWNER}/mcp-parity`, 'mcp: get_repo reads the repository back');
  const cross = await rpc({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'get_repo', arguments: { owner: 'someoneelse', repo: 'mcp-parity' } } });
  eq(cross.body?.result?.isError, true, 'mcp: a repository under another owner behaves as nonexistent');
}

{
  const created = await rpc({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: OWNER, repo: 'fixture', title: 'created over mcp', body: 'seeded body' } } });
  const view = toolText(created.body);
  ok(typeof view?.number === 'number', 'mcp: create_issue answers a number', view);
  eq(repo.issues.get(view.number)?.title, 'created over mcp', 'mcp: create_issue is the same object in the store');

  const listed = await rpc({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'list_issues', arguments: { owner: OWNER, repo: 'fixture', state: 'open' } } });
  const text = listed.body?.result?.content?.[0]?.text ?? '';
  ok(text.includes('created over mcp'), 'mcp: list_issues returns the created issue by title');
  ok(new RegExp(`"number"\\s*:\\s*${view.number}(?!\\d)`).test(text), 'mcp: list_issues returns the created issue by number');
}

{
  const mcpRepo = seedRepo('mcp-pr');
  const created = await rpc({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'create_pull_request', arguments: { owner: OWNER, repo: 'mcp-pr', title: 'created over mcp', head: 'feature', base: 'main' } } });
  const view = toolText(created.body);
  ok(typeof view?.number === 'number', 'mcp: create_pull_request answers a number', view);
  const stored = mcpRepo.issues.get(view.number);
  eq(stored?.pull?.headRef, 'feature', 'mcp: create_pull_request reads back with the same head');
  eq(stored?.pull?.baseRef, 'main', 'mcp: create_pull_request reads back with the same base');

  const merged = await rpc({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'merge_pull_request', arguments: { owner: OWNER, repo: 'mcp-pr', pull_number: view.number } } });
  const mergedView = toolText(merged.body);
  eq(mergedView?.merged, true, 'mcp: merge_pull_request answers merged: true', merged.body);
  eq(mcpRepo.issues.get(view.number)?.pull?.merged, true, 'mcp: the stored pull request is merged');
  eq(mcpRepo.issues.get(view.number)?.state, 'closed', 'mcp: the stored pull request is closed after the merge');
  const mainAfter = mcpRepo.git.refs.get('refs/heads/main');
  ok(mainAfter !== undefined && mcpRepo.git.flattenTree(mcpRepo.git.commit(mainAfter)?.tree ?? '').has('feature.txt'), 'mcp: the merge commit lands on the base branch');
}

{
  const unknown = await rpc({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'mcp_no_such_tool_x', arguments: {} } });
  eq(unknown.status, 200, 'mcp: unknown tool answers HTTP 200, never 500');
  ok([-32602, -32601].includes(unknown.body?.error?.code), 'mcp: unknown tool answers -32602 or -32601', unknown.body);

  const missing = await rpc({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'create_issue', arguments: {} } });
  ok(missing.body?.error?.code === -32602 || missing.body?.result?.isError === true, 'mcp: missing arguments answer -32602 or isError', missing.body);

  const noMethod = await rpc({ jsonrpc: '2.0', id: 42, method: 'no/such-method', params: {} });
  eq(noMethod.body?.error?.code, -32601, 'mcp: an unknown method answers -32601');

  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: '{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"',
  });
  eq(res.status, 400, 'mcp: a non-JSON body answers HTTP 400');
  const parsed = JSON.parse(await res.text());
  eq(parsed?.error?.code, -32700, 'mcp: a non-JSON body answers -32700');
}

{
  const left = await rpc({ jsonrpc: '2.0', id: 'unused', method: 'tools/list', params: {} });
  void left;
  const call = (id: string, repoName: string): Promise<{ status: number; body: any }> =>
    rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_repo', arguments: { owner: OWNER, repo: repoName } } });
  const [leftAnswer, rightAnswer] = await Promise.all([call('concurrent-left-x', 'fixture'), call('concurrent-right-x', 'fixture-pages')]);
  eq(leftAnswer.body?.id, 'concurrent-left-x', 'mcp: concurrent call keeps its own id (left)');
  eq(rightAnswer.body?.id, 'concurrent-right-x', 'mcp: concurrent call keeps its own id (right)');
  ok((leftAnswer.body?.result?.content?.[0]?.text ?? '').includes('fixture'), 'mcp: concurrent left answers its own repository');
  ok((rightAnswer.body?.result?.content?.[0]?.text ?? '').includes('fixture-pages'), 'mcp: concurrent right answers its own repository');
}

{
  const get = await fetch(`${BASE}/mcp`, { method: 'GET', headers: { authorization: 'Bearer test' } });
  eq(get.status, 405, 'mcp: GET answers 405');
  const del = await fetch(`${BASE}/mcp`, { method: 'DELETE', headers: { authorization: 'Bearer test' } });
  eq(del.status, 200, 'mcp: DELETE answers 200');
}

// Audit regressions: the MCP tools refuse what the REST surface refuses — a pull request from a
// branch that does not exist (REST answers 422) and a second merge of an already-merged pull
// request (REST answers 405) — instead of recording phantom state with a success result.
{
  seedRepo('audit-mcp');
  const ghost = await rpc({
    jsonrpc: '2.0',
    id: 'audit-ghost-pr',
    method: 'tools/call',
    params: { name: 'create_pull_request', arguments: { owner: OWNER, repo: 'audit-mcp', title: 'ghost', head: 'no-such-branch', base: 'main' } },
  });
  eq(ghost.body?.result?.isError, true, 'mcp: create_pull_request with a missing head branch is an error', ghost.body);
  const real = await rpc({
    jsonrpc: '2.0',
    id: 'audit-real-pr',
    method: 'tools/call',
    params: { name: 'create_pull_request', arguments: { owner: OWNER, repo: 'audit-mcp', title: 'real audit pull', head: 'merge-branch', base: 'main' } },
  });
  ok(real.body?.result?.isError !== true, 'mcp: create_pull_request with real branches succeeds', real.body);
  const number = JSON.parse(real.body?.result?.content?.[0]?.text ?? '{}')?.number;
  ok(typeof number === 'number', 'mcp: the created pull request has a number', real.body);
  const first = await rpc({
    jsonrpc: '2.0',
    id: 'audit-merge-1',
    method: 'tools/call',
    params: { name: 'merge_pull_request', arguments: { owner: OWNER, repo: 'audit-mcp', pull_number: number } },
  });
  ok(first.body?.result?.isError !== true, 'mcp: the first merge succeeds', first.body);
  const second = await rpc({
    jsonrpc: '2.0',
    id: 'audit-merge-2',
    method: 'tools/call',
    params: { name: 'merge_pull_request', arguments: { owner: OWNER, repo: 'audit-mcp', pull_number: number } },
  });
  eq(second.body?.result?.isError, true, 'mcp: merging an already-merged pull request is an error', second.body);
}

// Audit regression: GraphQL createPullRequest errors when the head ref does not exist (the REST
// surface answers 422 for the same input) instead of recording a pull request with no commits.
{
  const { body } = await gql(CREATE_PULL_REQUEST, {
    input: { repositoryId: repoGlobalId, baseRefName: 'main', headRefName: 'no-such-branch', title: 'ghost over graphql' },
  });
  ok(Array.isArray(body?.errors) && body.errors.length > 0, 'graphql: createPullRequest with a missing head ref errors', body);
  ok(body?.data?.createPullRequest === null || body?.data?.createPullRequest === undefined, 'graphql: no pull request payload for the ghost create', body);
}

server.close();
console.log(`\n${checks - failures}/${checks} assertions passed`);
if (failures > 0) process.exit(1);
