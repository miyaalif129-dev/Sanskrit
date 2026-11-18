// store.ts — the forge's memory.
//
// Everything the entry serves lives here, in plain Maps, and nothing is ever written to disk:
// the trial replays the same requests against a fresh process, so the store only has to be fast and
// deterministic. Two rules run through the whole file:
//
//   * No wall clock, no randomness. Ids come from counters, timestamps come from MAKEFUN_TRIAL_NOW
//     (the trial's opening time, the same in every replay), and a commit's SHA comes from its bytes.
//   * Repos, issues and pulls are numbered in creation order, and lists come back in that order,
//     because pagination and "newest first" both depend on it.
//
// The viewer is fixed by the trial scenario (a public constant in the kit): the token owner is
// adaiversen, id 1000. The token itself carries no login, so the entry hardcodes the scenario's
// viewer rather than pretending the token tells it who the caller is.

import { createHash } from 'node:crypto';

/** The scenario's viewer: the account the shop token belongs to. */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** Fallback opening time (2025-01-01T00:00:00Z) when the env gives no usable MAKEFUN_TRIAL_NOW. */
const FALLBACK_EPOCH_SEC = 1735689600;

/** The trial's opening time, in whole seconds since the epoch. */
export function trialEpochSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) return asNumber > 1e12 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
  }
  return FALLBACK_EPOCH_SEC;
}

/** The trial's opening time as an ISO-8601 string, for created_at / merged_at fields. */
export function trialIso(): string {
  return new Date(trialEpochSec() * 1000).toISOString();
}

/** The identity line a REST-made commit carries (author and committer are the same). */
export function identityLine(): string {
  return `${VIEWER.name} <${VIEWER.email}> ${trialEpochSec()} +0000`;
}

/** SHA-1 of a git object header plus its bytes — the object's id. */
export function objectId(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ------------------------------------------------------------------ types

export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  /** One shared counter for issues and pulls, as GitHub numbers them together. */
  nextNumber: number;
  nextCommentId: number;
  nextIssueId: number;
}

// ------------------------------------------------------------------ the forge

/** A request-id counter: every reply carries X-GitHub-Request-Id, and a counter is deterministic. */
let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextRepoSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string } = {}): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    this.nextRepoSeq += 1;
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.nextRepoSeq,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
      nextIssueId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // -- objects -------------------------------------------------------

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = objectId(type, data);
    repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  // -- refs ----------------------------------------------------------

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  headRefName(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  headTip(repo: Repo): string | undefined {
    return repo.refs.get(this.headRefName(repo));
  }

  // -- labels --------------------------------------------------------

  addLabel(repo: Repo, name: string, color: string): Label {
    const label: Label = { name, color, description: '' };
    repo.labels.set(name, label);
    return label;
  }

  // -- issues --------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      id: repo.nextIssueId,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: number,
      comments: [],
    };
    repo.nextIssueId += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    for (const issue of repo.issues) if (issue.number === number) return issue;
    return undefined;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: repo.nextCommentId, body };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // -- pulls ---------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): Pull {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: Pull = {
      id: number,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      createdSeq: number,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    for (const pull of repo.pulls) if (pull.number === number) return pull;
    return undefined;
  }

  openPullWith(repo: Repo, headRef: string, baseRef: string): Pull | undefined {
    for (const pull of repo.pulls) {
      if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) return pull;
    }
    return undefined;
  }
}
