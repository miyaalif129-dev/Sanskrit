// mcp.ts — the MCP endpoint (POST /mcp), JSON-RPC 2.0 over plain HTTP.
//
// The suite's client speaks the modern era (2026-07-28): it probes `server/discover` first and
// never needs a session id, an SSE stream, or a handshake. `initialize` and the `initialized`
// notification are still answered for the legacy path. Every tools/call runs against the same Forge
// as REST and GraphQL, so a repository created here reads back identically there.
//
// Errors: an unknown tool is -32601, a missing required argument is an isError result, and a body
// that is not JSON is HTTP 400 with -32700. Authorization is checked by app.ts before this file
// ever sees the request.

import type { Forge, Issue, Pull, Repo } from './store.ts';
import { VIEWER, trialIso } from './store.ts';
import { squashMerge } from './git.ts';

export interface McpResult {
  status: number;
  /** null means "answer 202 with an empty body" (a notification). */
  body: unknown | null;
}

const SERVER_INFO = Object.freeze({ name: 'github-forge', version: '1.0.0' });

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The tool list, a constant so two tools/list calls answer byte-identically. */
const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from one branch onto another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The branch the changes are on.' },
        base: { type: 'string', description: 'The branch the changes merge into.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

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
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: trialIso(),
    updated_at: trialIso(),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
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

function textResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function errorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredArg(args: Record<string, unknown>, name: string): unknown {
  const value = args[name];
  return value === undefined || value === null || value === '' ? undefined : value;
}

/** Dispatch one tools/call; returns the tool result object (never a JSON-RPC error). */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const missing = (field: string): Record<string, unknown> => errorResult(`missing required argument: ${field}`);
  switch (name) {
    case 'create_repo': {
      const repoName = requiredArg(args, 'name');
      if (repoName === undefined) return missing('name');
      const owner = typeof args.owner === 'string' && args.owner !== '' ? String(args.owner) : VIEWER.login;
      if (owner !== VIEWER.login) return errorResult(`cannot create a repository for ${owner}: the token belongs to ${VIEWER.login}`);
      const repo = forge.createRepo(owner, String(repoName), {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      if (repo === null) return errorResult(`Repository ${owner}/${repoName} already exists`);
      return textResult(repoView(repo));
    }
    case 'get_repo': {
      const owner = requiredArg(args, 'owner');
      const repoName = requiredArg(args, 'repo');
      if (owner === undefined) return missing('owner');
      if (repoName === undefined) return missing('repo');
      const repo = forge.getRepo(String(owner), String(repoName));
      if (repo === undefined) return errorResult(`Repository ${owner}/${repoName} not found`);
      return textResult(repoView(repo));
    }
    case 'create_issue': {
      const owner = requiredArg(args, 'owner');
      const repoName = requiredArg(args, 'repo');
      const title = requiredArg(args, 'title');
      if (owner === undefined) return missing('owner');
      if (repoName === undefined) return missing('repo');
      if (title === undefined) return missing('title');
      const repo = forge.getRepo(String(owner), String(repoName));
      if (repo === undefined) return errorResult(`Repository ${owner}/${repoName} not found`);
      const issue = forge.createIssue(repo, String(title), typeof args.body === 'string' ? args.body : '', []);
      return textResult(issueView(repo, issue));
    }
    case 'list_issues': {
      const owner = requiredArg(args, 'owner');
      const repoName = requiredArg(args, 'repo');
      if (owner === undefined) return missing('owner');
      if (repoName === undefined) return missing('repo');
      const repo = forge.getRepo(String(owner), String(repoName));
      if (repo === undefined) return errorResult(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => b.number - a.number);
      return textResult({ issues: list.map((issue) => issueView(repo, issue)), total_count: list.length });
    }
    case 'create_pull_request': {
      const owner = requiredArg(args, 'owner');
      const repoName = requiredArg(args, 'repo');
      const title = requiredArg(args, 'title');
      const head = requiredArg(args, 'head');
      const base = requiredArg(args, 'base');
      if (owner === undefined) return missing('owner');
      if (repoName === undefined) return missing('repo');
      if (title === undefined) return missing('title');
      if (head === undefined) return missing('head');
      if (base === undefined) return missing('base');
      const repo = forge.getRepo(String(owner), String(repoName));
      if (repo === undefined) return errorResult(`Repository ${owner}/${repoName} not found`);
      const headTip = forge.refTip(repo, `refs/heads/${head}`);
      const baseTip = forge.refTip(repo, `refs/heads/${base}`);
      if (headTip === undefined) return errorResult(`head branch "${head}" does not exist`);
      if (baseTip === undefined) return errorResult(`base branch "${base}" does not exist`);
      const existing = repo.pulls.find((entry) => entry.state === 'open' && entry.headRef === String(head) && entry.baseRef === String(base));
      if (existing !== undefined) return errorResult('A pull request already exists for this head and base');
      const pull = forge.createPull(repo, String(title), typeof args.body === 'string' ? args.body : '', String(head), headTip, String(base), baseTip);
      return textResult(pullView(repo, pull));
    }
    case 'merge_pull_request': {
      const owner = requiredArg(args, 'owner');
      const repoName = requiredArg(args, 'repo');
      const pullNumber = requiredArg(args, 'pull_number');
      if (owner === undefined) return missing('owner');
      if (repoName === undefined) return missing('repo');
      if (pullNumber === undefined) return missing('pull_number');
      const repo = forge.getRepo(String(owner), String(repoName));
      if (repo === undefined) return errorResult(`Repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.find((entry) => entry.number === Number(pullNumber));
      if (pull === undefined) return errorResult(`Pull request #${pullNumber} not found`);
      if (pull.state === 'closed') return errorResult('Pull request is already closed');
      const result = squashMerge(forge, repo, pull);
      if ('conflict' in result) return errorResult('Merge conflict');
      return textResult({ merged: true, sha: result.sha, message: 'Pull request successfully merged' });
    }
    default:
      return errorResult(`unknown tool: ${name}`);
  }
}

export function handleMcp(forge: Forge, body: unknown, bodyError: boolean): McpResult {
  if (bodyError) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!isObject(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const method = typeof body.method === 'string' ? body.method : '';
  const id = body.id === undefined ? undefined : body.id;
  const params = isObject(body.params) ? body.params : {};

  // A notification carries no id and gets an empty 202.
  if (id === undefined) return { status: 202, body: null };

  const result = (value: unknown): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id, result: value } });
  const failure = (code: number, message: string): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  switch (method) {
    case 'server/discover':
      return result({
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize':
      return result({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isObject(params.arguments) ? params.arguments : {};
      if (toolName === '' || !TOOLS.some((tool) => tool.name === toolName)) {
        return failure(-32601, `Method not found: ${toolName === '' ? 'tools/call' : toolName}`);
      }
      return result(callTool(forge, toolName, args));
    }
    default:
      return failure(-32601, `Method not found: ${method}`);
  }
}
