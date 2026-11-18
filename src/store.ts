// The forge's state: repositories (each with its labels, issues, pull requests and git object
// store) held in memory, plus the logical clock every timestamp in the system comes from. The
// clock never reads the wall time — it starts at MAKEFUN_TRIAL_NOW (or a fixed base) and
// advances one second per timestamp issued, so a replayed trial produces byte-identical state.

import { GitRepo } from './gitdb.ts';

/** A user as the API surfaces model one. */
export interface UserRec {
  id: number;
  login: string;
  name: string;
  email: string;
  type: string;
}

/** The scenario's token user: the author of everything the API creates on a caller's behalf. */
export const VIEWER: UserRec = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
};

/** An issue label defined on a repository. */
export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

/** One issue or pull-request comment. */
export interface CommentRec {
  id: number;
  body: string;
  user: UserRec;
  created_at: string;
  updated_at: string;
}

/** The pull-request half of an IssueRec that is a pull request. */
export interface PullRec {
  headRef: string;
  headSha: string | null;
  baseRef: string;
  baseSha: string | null;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: boolean | null;
}

/** An issue, or a pull request when `isPull` is set (the two share one numbering space). */
export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  user: UserRec;
  created_at: string;
  updated_at: string;
  comments: CommentRec[];
  isPull: boolean;
  pull: PullRec | null;
}

/** A repository and everything filed under it. */
export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  nextIssue: number;
  git: GitRepo;
}

/** The fallback base of the logical clock when MAKEFUN_TRIAL_NOW does not parse. */
const CLOCK_FALLBACK = '2026-11-14T06:30:00.000Z';

export class Store {
  private clockMs: number;
  private readonly baseMs: number;
  private repoSeq: number;
  private issueSeq: number;
  private commentSeq: number;
  private repos: Map<string, RepoRec>;

  constructor() {
    const envNow = Date.parse(process.env.MAKEFUN_TRIAL_NOW ?? '');
    this.clockMs = Number.isNaN(envNow) ? Date.parse(CLOCK_FALLBACK) : envNow;
    this.baseMs = this.clockMs;
    this.repoSeq = 1;
    this.issueSeq = 1;
    this.commentSeq = 1;
    this.repos = new Map();
  }

  /** The current logical time as an ISO string; advances the clock by one second. */
  nowIso(): string {
    const iso = new Date(this.clockMs).toISOString();
    this.clockMs += 1000;
    return iso;
  }

  /** The current logical time in epoch seconds; does not advance the clock. */
  epochSec(): number {
    return Math.floor(this.clockMs / 1000);
  }

  /** The trial's starting time as an ISO string; never advances (for records that predate all activity). */
  baseIso(): string {
    return new Date(this.baseMs).toISOString();
  }

  /** The next global comment id (comments share one id space across repositories). */
  nextCommentId(): number {
    const id = this.commentSeq;
    this.commentSeq += 1;
    return id;
  }

  private key(owner: string, name: string): string {
    return `${owner}\0${name}`;
  }

  /**
   * Create a repository: an empty GitRepo whose HEAD names refs/heads/<defaultBranch>, and no
   * refs until something is pushed. Throws when the owner/name pair is already taken.
   */
  createRepo(
    owner: string,
    name: string,
    opts: { description?: string; private?: boolean; defaultBranch?: string } = {},
  ): RepoRec {
    const key = this.key(owner, name);
    if (this.repos.has(key)) throw new Error(`repository ${owner}/${name} already exists`);
    const defaultBranch = opts.defaultBranch ?? 'main';
    const ts = this.nowIso();
    const rec: RepoRec = {
      id: this.repoSeq,
      owner,
      name,
      full_name: `${owner}/${name}`,
      description: opts.description ?? '',
      private: opts.private ?? false,
      default_branch: defaultBranch,
      created_at: ts,
      updated_at: ts,
      labels: new Map(),
      issues: new Map(),
      nextIssue: 1,
      git: new GitRepo(`refs/heads/${defaultBranch}`),
    };
    this.repoSeq += 1;
    this.repos.set(key, rec);
    return rec;
  }

  /** The repository under an exact owner/name, or undefined. */
  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** Remove a repository; true when one was there. */
  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /**
   * Re-key a repository under a new name (a rename): the record keeps its id, issues and git
   * store; only its map key, name and full_name move. False when the old name is absent or the
   * new name is already taken by another repository of the same owner.
   */
  renameRepo(owner: string, oldName: string, newName: string): boolean {
    const oldKey = this.key(owner, oldName);
    const rec = this.repos.get(oldKey);
    if (rec === undefined) return false;
    if (oldName === newName) return true;
    const newKey = this.key(owner, newName);
    if (this.repos.has(newKey)) return false;
    this.repos.delete(oldKey);
    rec.name = newName;
    rec.full_name = `${owner}/${newName}`;
    this.repos.set(newKey, rec);
    return true;
  }

  /** An owner's repositories, in creation order. */
  listRepos(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((rec) => rec.owner === owner);
  }

  /** File an issue on a repository, authored by the viewer, in the repo's numbering space. */
  addIssue(repo: RepoRec, input: { title: string; body?: string; labels?: string[] }): IssueRec {
    const ts = this.nowIso();
    const rec: IssueRec = {
      number: repo.nextIssue,
      id: this.issueSeq,
      title: input.title,
      body: input.body ?? null,
      state: 'open',
      labels: input.labels ? [...input.labels] : [],
      user: VIEWER,
      created_at: ts,
      updated_at: ts,
      comments: [],
      isPull: false,
      pull: null,
    };
    repo.nextIssue += 1;
    this.issueSeq += 1;
    repo.issues.set(rec.number, rec);
    return rec;
  }

  /**
   * File a pull request: same numbering space as issues, with the pull record resolved against
   * the repo's current branch refs (a missing branch leaves the sha null).
   */
  addPull(repo: RepoRec, input: { title: string; body?: string; headRef: string; baseRef: string }): IssueRec {
    const ts = this.nowIso();
    const shaOf = (ref: string): string | null => {
      const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
      return repo.git.refs.get(full) ?? repo.git.refs.get(ref) ?? null;
    };
    const rec: IssueRec = {
      number: repo.nextIssue,
      id: this.issueSeq,
      title: input.title,
      body: input.body ?? null,
      state: 'open',
      labels: [],
      user: VIEWER,
      created_at: ts,
      updated_at: ts,
      comments: [],
      isPull: true,
      pull: {
        headRef: input.headRef,
        headSha: shaOf(input.headRef),
        baseRef: input.baseRef,
        baseSha: shaOf(input.baseRef),
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        mergeable: null,
      },
    };
    repo.nextIssue += 1;
    this.issueSeq += 1;
    repo.issues.set(rec.number, rec);
    return rec;
  }
}

/** The one store the server runs on. */
export const store = new Store();
