// rest.ts — the REST v3 surface, as the suite drives it.
//
// Routes live under /api/v3. Every reply is JSON with an X-GitHub-Request-Id (added by app.ts),
// errors carry a string `message`, unknown routes answer 404, and a body that is not valid JSON
// answers 400. Repos exist only under the viewer, so any other owner is a 404, never a 403.
//
// Pagination keeps creation order and answers a Link header with an absolute rel="next" URL when
// another page exists. Issue and pull numbers share one per-repo counter, as GitHub numbers them.

import type { Forge, Issue, Pull, Repo } from './store.ts';
import { VIEWER, trialIso } from './store.ts';
import {
  commitFiles, diffFiles, parseCommit, parseTree,
  squashMerge,
} from './git.ts';

export interface RestContext {
  method: string;
  path: string;
  segments: string[];
  query: URLSearchParams;
  origin: string;
  body: unknown;
  bodyError: boolean;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (body: unknown, headers?: Record<string, string>): RestResult => ({ status: 200, body, headers });
const created = (body: unknown): RestResult => ({ status: 201, body });
const noContent = (): RestResult => ({ status: 204, body: null });
const err = (status: number, message: string): RestResult => ({ status, body: { message } });
const notFound = (): RestResult => err(404, 'Not Found');

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Slice a list into one page; `link` is an absolute rel="next" URL, or null on the last page. */
function pageOf<T>(items: T[], ctx: RestContext): { items: T[]; link: string | null } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const perPage = Number.isSafeInteger(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isSafeInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    link = `<${ctx.origin}${ctx.path}?${params.toString()}>; rel="next"`;
  }
  return { items: slice, link };
}

function linkHeader(link: string | null): Record<string, string> | undefined {
  return link === null ? undefined : { link };
}

// ------------------------------------------------------------------ views

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    created_at: trialIso(),
    updated_at: trialIso(),
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    visibility: repo.private ? 'private' : 'public',
    fork: false,
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: trialIso(),
    updated_at: trialIso(),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: trialIso(),
    updated_at: trialIso(),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function branchView(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = line.match(/^(.*?) <(.*?)> (\d+) [+-]\d{4}$/);
  if (match === null) return { name: line, email: '', date: trialIso() };
  return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitView(forge: Forge, repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = forge.getObject(repo, sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  const author = parseIdentity(info.author);
  const committer = parseIdentity(info.committer);
  return {
    sha,
    commit: {
      message: info.message,
      author,
      committer,
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: info.parents.map((parent) => ({ sha: parent })),
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

/** Resolve a ref name (or raw oid) to a tip commit, or undefined. */
function resolveTip(forge: Forge, repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') return forge.headTip(repo);
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const obj = forge.getObject(repo, ref);
    return obj !== undefined && obj.type === 'commit' ? ref : undefined;
  }
  if (ref.startsWith('refs/')) return forge.refTip(repo, ref);
  return forge.refTip(repo, `refs/heads/${ref}`);
}

// ------------------------------------------------------------------ contents

interface ContentEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  sha: string;
  size: number;
}

/** Walk a tree to `path`; returns the file blob, the directory entries, or null when absent. */
function resolveContent(forge: Forge, repo: Repo, tip: string, path: string): { file: { oid: string; data: Buffer } } | { dir: ContentEntry[] } | null {
  const tipObj = forge.getObject(repo, tip);
  if (tipObj === undefined || tipObj.type !== 'commit') return null;
  let treeOid = parseCommit(tipObj.data).tree;
  const segments = path === '' ? [] : path.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const treeObj = forge.getObject(repo, treeOid);
    if (treeObj === undefined || treeObj.type !== 'tree') return null;
    const entry = parseTree(treeObj.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) {
      if (entry.mode === '40000') {
        const dirObj = forge.getObject(repo, entry.oid);
        if (dirObj === undefined || dirObj.type !== 'tree') return null;
        const entries: ContentEntry[] = [];
        for (const child of parseTree(dirObj.data)) {
          const childPath = path === '' ? child.name : `${path}/${child.name}`;
          if (child.mode === '40000') {
            entries.push({ type: 'dir', name: child.name, path: childPath, sha: child.oid, size: 0 });
          } else {
            const blob = forge.getObject(repo, child.oid);
            entries.push({ type: 'file', name: child.name, path: childPath, sha: child.oid, size: blob?.data.length ?? 0 });
          }
        }
        return { dir: entries };
      }
      const blob = forge.getObject(repo, entry.oid);
      if (blob === undefined || blob.type !== 'blob') return null;
      return { file: { oid: entry.oid, data: blob.data } };
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  // The root directory.
  const treeObj = forge.getObject(repo, treeOid);
  if (treeObj === undefined || treeObj.type !== 'tree') return null;
  const entries: ContentEntry[] = [];
  for (const child of parseTree(treeObj.data)) {
    if (child.mode === '40000') {
      entries.push({ type: 'dir', name: child.name, path: child.name, sha: child.oid, size: 0 });
    } else {
      const blob = forge.getObject(repo, child.oid);
      entries.push({ type: 'file', name: child.name, path: child.name, sha: child.oid, size: blob?.data.length ?? 0 });
    }
  }
  return { dir: entries };
}

// ------------------------------------------------------------------ router

export function handleRest(forge: Forge, ctx: RestContext): RestResult {
  const [first, second, third, ...rest] = ctx.segments;

  // GET /api/v3/ — the API root.
  if (ctx.segments.length === 0 && ctx.method === 'GET') {
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  if (first === 'meta' && ctx.method === 'GET') {
    return ok({ installed_version: '1.0.0', verifiable_password_authentication: false });
  }

  if (first === 'user' && ctx.method === 'GET' && second === undefined) {
    return ok({
      login: VIEWER.login,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      html_url: `https://github.com/${VIEWER.login}`,
    });
  }

  // POST /user/repos — create under the viewer. GET /user/repos — list, paginated.
  if (first === 'user' && second === 'repos') {
    if (ctx.method === 'POST') {
      if (ctx.bodyError) return err(400, 'Problems parsing JSON');
      if (!isObject(ctx.body)) return err(422, 'body must be a JSON object');
      const name = asString(ctx.body.name);
      if (name === undefined || name === '') return err(422, 'name is required');
      const repo = forge.createRepo(VIEWER.login, name, {
        private: ctx.body.private === true,
        description: asString(ctx.body.description) ?? '',
      });
      if (repo === null) return err(422, `Repository ${VIEWER.login}/${name} already exists`);
      return created(repoView(repo));
    }
    if (ctx.method === 'GET') {
      const repos = forge.listRepos(VIEWER.login);
      const page = pageOf(repos.map((repo) => repoView(repo)), ctx);
      return ok(page.items, linkHeader(page.link));
    }
    return notFound();
  }

  if (first !== 'repos') return notFound();
  const owner = second ?? '';
  const repoName = third ?? '';
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  const [sub, ...tail] = rest;

  // GET /repos/{o}/{r} — PATCH description, DELETE the repo.
  if (sub === undefined) {
    if (ctx.method === 'GET') return ok(repoView(repo));
    if (ctx.method === 'PATCH') {
      if (ctx.bodyError) return err(400, 'Problems parsing JSON');
      if (isObject(ctx.body)) {
        const description = asString(ctx.body.description);
        if (description !== undefined) repo.description = description;
      }
      return ok(repoView(repo));
    }
    if (ctx.method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      return noContent();
    }
    return notFound();
  }

  // Branches.
  if (sub === 'branches') {
    const branch = tail[0];
    if (branch === undefined && ctx.method === 'GET') {
      const branches: Record<string, unknown>[] = [];
      for (const name of [...repo.refs.keys()].sort()) {
        if (!name.startsWith('refs/heads/')) continue;
        branches.push(branchView(repo, name.slice('refs/heads/'.length), repo.refs.get(name) as string));
      }
      return ok(branches);
    }
    if (branch !== undefined && tail.length === 1 && ctx.method === 'GET') {
      const tip = forge.refTip(repo, `refs/heads/${branch}`);
      if (tip === undefined) return notFound();
      return ok(branchView(repo, branch, tip));
    }
    return notFound();
  }

  // Commits: GET /commits[?sha=<ref>].
  if (sub === 'commits') {
    if (ctx.method !== 'GET') return notFound();
    if (tail.length > 0) {
      const view = commitView(forge, repo, tail[0] as string);
      return view === null ? notFound() : ok(view);
    }
    const tip = resolveTip(forge, repo, ctx.query.get('sha') ?? undefined);
    if (tip === undefined) return ok([]);
    const oids: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = forge.getObject(repo, oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      oids.push(oid);
      for (let i = parseCommit(obj.data).parents.length - 1; i >= 0; i -= 1) {
        stack.push(parseCommit(obj.data).parents[i] as string);
      }
    }
    const views: Record<string, unknown>[] = [];
    for (const oid of oids) {
      const view = commitView(forge, repo, oid);
      if (view !== null) views.push(view);
    }
    return ok(views);
  }

  // git/refs: POST create, GET a head.
  if (sub === 'git' && tail[0] === 'refs') {
    if (ctx.method === 'POST' && tail.length === 1) {
      if (ctx.bodyError) return err(400, 'Problems parsing JSON');
      if (!isObject(ctx.body)) return err(422, 'body must be a JSON object');
      const ref = asString(ctx.body.ref);
      const sha = asString(ctx.body.sha);
      if (ref === undefined || sha === undefined) return err(422, 'ref and sha are required');
      if (!ref.startsWith('refs/')) return err(422, 'ref must start with refs/');
      if (forge.refTip(repo, ref) !== undefined) return err(422, 'Reference already exists');
      if (forge.getObject(repo, sha) === undefined) return err(422, 'Object does not exist');
      forge.setRef(repo, ref, sha);
      return created({ ref, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}` }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref}` });
    }
    if (ctx.method === 'GET' && tail[1] === 'heads' && tail[2] !== undefined && tail.length === 3) {
      const tip = forge.refTip(repo, `refs/heads/${tail[2]}`);
      if (tip === undefined) return notFound();
      return ok({ ref: `refs/heads/${tail[2]}`, object: { sha: tip, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/commits/${tip}` }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/heads/${tail[2]}` });
    }
    return notFound();
  }

  // Contents: PUT create/update, GET file or directory, DELETE.
  if (sub === 'contents') {
    const path = tail.map((segment) => decodeURIComponent(segment)).join('/');
    if (ctx.method === 'PUT') {
      if (ctx.bodyError) return err(400, 'Problems parsing JSON');
      if (!isObject(ctx.body)) return err(422, 'body must be a JSON object');
      const message = asString(ctx.body.message) ?? 'Update file';
      const content = asString(ctx.body.content);
      if (content === undefined) return err(422, 'content is required');
      let bytes: Buffer;
      try {
        bytes = Buffer.from(content, 'base64');
      } catch {
        return err(400, 'content is not valid base64');
      }
      const branch = asString(ctx.body.branch) ?? repo.defaultBranch;
      const tip = resolveTip(forge, repo, branch);
      const existing = tip === undefined ? null : resolveContent(forge, repo, tip, path);
      const givenSha = asString(ctx.body.sha);
      if (existing !== null && 'file' in existing) {
        if (givenSha !== undefined && givenSha !== existing.file.oid) {
          return err(409, 'sha does not match the current file');
        }
        const blobOid = forge.putObject(repo, 'blob', bytes);
        const { commitOid } = commitFiles(forge, repo, branch, message, [{ path, oid: blobOid }]);
        return ok({
          content: { name: path.split('/').pop(), path, sha: blobOid, size: bytes.length, encoding: 'base64', type: 'file' },
          commit: { sha: commitOid, message },
        });
      }
      if (givenSha !== undefined) return err(422, 'sha does not match: the file does not exist');
      const blobOid = forge.putObject(repo, 'blob', bytes);
      const { commitOid } = commitFiles(forge, repo, branch, message, [{ path, oid: blobOid }]);
      return created({
        content: { name: path.split('/').pop(), path, sha: blobOid, size: bytes.length, encoding: 'base64', type: 'file' },
        commit: { sha: commitOid, message },
      });
    }
    if (ctx.method === 'GET') {
      const tip = resolveTip(forge, repo, ctx.query.get('ref') ?? undefined);
      if (tip === undefined) return notFound();
      const resolved = resolveContent(forge, repo, tip, path);
      if (resolved === null) return notFound();
      if ('file' in resolved) {
        return ok({
          type: 'file',
          name: path.split('/').pop(),
          path,
          sha: resolved.file.oid,
          size: resolved.file.data.length,
          encoding: 'base64',
          content: resolved.file.data.toString('base64'),
        });
      }
      return ok(resolved.dir);
    }
    if (ctx.method === 'DELETE') {
      if (ctx.bodyError) return err(400, 'Problems parsing JSON');
      if (!isObject(ctx.body)) return err(422, 'body must be a JSON object');
      const message = asString(ctx.body.message) ?? 'Delete file';
      const givenSha = asString(ctx.body.sha);
      const tip = resolveTip(forge, repo, repo.defaultBranch);
      if (tip === undefined) return notFound();
      const existing = resolveContent(forge, repo, tip, path);
      if (existing === null || !('file' in existing)) return notFound();
      if (givenSha !== undefined && givenSha !== existing.file.oid) return err(409, 'sha does not match the current file');
      const { commitOid } = commitFiles(forge, repo, repo.defaultBranch, message, [{ path, oid: null }]);
      return ok({ content: null, commit: { sha: commitOid, message } });
    }
    return notFound();
  }

  // Labels.
  if (sub === 'labels') {
    if (ctx.method === 'POST') {
      if (ctx.bodyError) return err(400, 'Problems parsing JSON');
      if (!isObject(ctx.body)) return err(422, 'body must be a JSON object');
      const name = asString(ctx.body.name);
      if (name === undefined || name === '') return err(422, 'name is required');
      const color = asString(ctx.body.color) ?? 'ededed';
      const existing = repo.labels.get(name);
      if (existing !== undefined) return created({ name: existing.name, color: existing.color, description: '' });
      const label = forge.addLabel(repo, name, color);
      return created({ name: label.name, color: label.color, description: '' });
    }
    if (ctx.method === 'GET') {
      return ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
    }
    return notFound();
  }

  // Issues.
  if (sub === 'issues') {
    const number = tail[0] === undefined ? undefined : Number(tail[0]);
    if (tail[0] !== undefined && tail[1] === 'comments') {
      if (number === undefined || !Number.isSafeInteger(number)) return notFound();
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (issue === undefined) return notFound();
      if (ctx.method === 'POST') {
        if (ctx.bodyError) return err(400, 'Problems parsing JSON');
        if (!isObject(ctx.body)) return err(422, 'body must be a JSON object');
        const body = asString(ctx.body.body);
        if (body === undefined) return err(422, 'body is required');
        const comment = forge.addComment(repo, issue, body);
        return created({ id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, created_at: trialIso(), updated_at: trialIso() });
      }
      if (ctx.method === 'GET') {
        return ok(issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, created_at: trialIso(), updated_at: trialIso() })));
      }
      return notFound();
    }
    if (number !== undefined && tail.length === 1) {
      if (!Number.isSafeInteger(number)) return notFound();
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (issue === undefined) return notFound();
      if (ctx.method === 'GET') return ok(issueView(repo, issue));
      if (ctx.method === 'PATCH') {
        if (ctx.bodyError) return err(400, 'Problems parsing JSON');
        if (isObject(ctx.body)) {
          const state = asString(ctx.body.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = asString(ctx.body.title);
          if (title !== undefined) issue.title = title;
          const body = asString(ctx.body.body);
          if (body !== undefined) issue.body = body;
        }
        return ok(issueView(repo, issue));
      }
      return notFound();
    }
    if (tail.length === 0) {
      if (ctx.method === 'POST') {
        if (ctx.bodyError) return err(400, 'Problems parsing JSON');
        if (!isObject(ctx.body)) return err(422, 'body must be a JSON object');
        const title = asString(ctx.body.title);
        if (title === undefined || title === '') return err(422, 'title is required');
        const labelsRaw = ctx.body.labels;
        const labels: string[] = [];
        if (Array.isArray(labelsRaw)) {
          for (const entry of labelsRaw) {
            const name = typeof entry === 'string' ? entry : isObject(entry) ? asString(entry.name) : undefined;
            if (name === undefined) continue;
            if (!repo.labels.has(name)) return err(422, `Label "${name}" does not exist`);
            labels.push(name);
          }
        }
        const issue = forge.createIssue(repo, title, asString(ctx.body.body) ?? '', labels);
        return created(issueView(repo, issue));
      }
      if (ctx.method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const direction = ctx.query.get('direction') ?? 'desc';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        if (ctx.query.get('sort') === 'created' || ctx.query.get('sort') === null) {
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        }
        const page = pageOf(list.map((issue) => issueView(repo, issue)), ctx);
        return ok(page.items, linkHeader(page.link));
      }
      return notFound();
    }
    return notFound();
  }

  // Pull requests.
  if (sub === 'pulls') {
    const number = tail[0] === undefined ? undefined : Number(tail[0]);
    if (number !== undefined && tail[1] === 'files' && tail.length === 2 && ctx.method === 'GET') {
      if (!Number.isSafeInteger(number)) return notFound();
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return notFound();
      return ok(diffFiles(forge, repo, pull));
    }
    if (number !== undefined && tail[1] === 'merge' && tail.length === 2 && ctx.method === 'PUT') {
      if (!Number.isSafeInteger(number)) return notFound();
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return notFound();
      if (pull.state === 'closed') return err(405, 'Pull request is already closed');
      const result = squashMerge(forge, repo, pull);
      if ('conflict' in result) return err(405, 'Merge conflict');
      return ok({ sha: result.sha, merged: true, message: 'Pull request successfully merged' });
    }
    if (number !== undefined && tail.length === 1 && ctx.method === 'GET') {
      if (!Number.isSafeInteger(number)) return notFound();
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return notFound();
      return ok(pullView(repo, pull));
    }
    if (tail.length === 0) {
      if (ctx.method === 'POST') {
        if (ctx.bodyError) return err(400, 'Problems parsing JSON');
        if (!isObject(ctx.body)) return err(422, 'body must be a JSON object');
        const head = asString(ctx.body.head);
        const base = asString(ctx.body.base);
        const title = asString(ctx.body.title);
        if (head === undefined || base === undefined || title === undefined) return err(422, 'head, base and title are required');
        const headTip = forge.refTip(repo, `refs/heads/${head}`);
        const baseTip = forge.refTip(repo, `refs/heads/${base}`);
        if (headTip === undefined) return err(422, `head branch "${head}" does not exist`);
        if (baseTip === undefined) return err(422, `base branch "${base}" does not exist`);
        const existing = repo.pulls.find((candidate) => candidate.state === 'open' && candidate.headRef === head && candidate.baseRef === base);
        if (existing !== undefined) return err(422, 'A pull request already exists for this head and base');
        const pull = forge.createPull(repo, title, asString(ctx.body.body) ?? '', head, headTip, base, baseTip);
        return created(pullView(repo, pull));
      }
      if (ctx.method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((pull) => pull.state === state);
        list.sort((a, b) => b.number - a.number);
        const page = pageOf(list.map((pull) => pullView(repo, pull)), ctx);
        return ok(page.items, linkHeader(page.link));
      }
      return notFound();
    }
    return notFound();
  }

  return notFound();
}
