// graphql.ts — a small GraphQL executor for the documents the suite sends.
//
// The suite speaks a fixed dialect: queries and mutations over viewer, repository, node, __type,
// and the five mutations (createIssue, closeIssue, createPullRequest, mergePullRequest, addComment),
// plus aliases, variables, inline fragments and batched arrays. This file parses that dialect with
// a hand-written recursive-descent parser and resolves it against the same Forge the REST surface
// uses, so a mutation here is visible through REST and vice versa.
//
// Unknown fields answer HTTP 200 with an `errors` array naming the field; an unknown repository
// answers `data.repository = null` with no errors; unauthenticated requests never reach this file
// (app.ts answers 401 first).

import type { Forge, Issue, Pull, Repo } from './store.ts';
import { VIEWER } from './store.ts';
import { diffFiles, mergeConflict, squashMerge } from './git.ts';

// ------------------------------------------------------------------ ids

function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0] as string, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function repoGid(repo: Repo): string {
  return gid('Repository', repo.id);
}

function issueGid(repo: Repo, issue: Issue): string {
  return gid('Issue', repo.id, issue.number);
}

function pullGid(repo: Repo, pull: Pull): string {
  return gid('PullRequest', repo.id, pull.number);
}

function cursorFor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = text.match(/^issue:(\d+)$/);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  children: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeName: string;
  children: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: string[];
  selections: SelectionNode[];
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const next = source[i + 1] as string;
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else value += next;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== undefined) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('empty GraphQL document');
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = first.value;
      this.next();
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.kind === 'name') name = this.next().value;
    } else if (first !== undefined && first.kind === 'name' && first.value === 'subscription') {
      throw new Error('subscriptions are not supported');
    }
    const variables: string[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        if (this.peek() === undefined) throw new Error('unterminated variable definitions');
        this.expectPunct('$');
        variables.push(this.expectName());
        this.expectPunct(':');
        this.parseType();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          this.parseValue();
        }
      }
      this.expectPunct(')');
    }
    // Directives on the operation (none are used): skip them.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') this.skipDirective();
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private skipDirective(): void {
    this.expectPunct('@');
    this.expectName();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArguments();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      if (this.peek() === undefined) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeName = this.expectName();
        return { kind: 'fragment', typeName, children: this.parseSelectionSet() };
      }
      // A named fragment spread: the suite never sends one; reject it plainly.
      throw new Error('named fragment spreads are not supported');
    }
    const name = this.expectName();
    let alias: string | undefined;
    let fieldName = name;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      fieldName = this.expectName();
    }
    const args = this.peek()?.kind === 'punct' && this.peek()?.value === '(' ? this.parseArguments() : [];
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') this.skipDirective();
    const children = this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name: fieldName, args, children };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      if (this.peek() === undefined) throw new Error('unterminated arguments');
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        if (this.peek() === undefined) throw new Error('unterminated list');
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        if (this.peek() === undefined) throw new Error('unterminated object');
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ------------------------------------------------------------------ values

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': case 'int': case 'float': case 'boolean': case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.values.map((child) => resolveValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ------------------------------------------------------------------ schema

/** The fields each type exposes, for introspection and for unknown-field errors. */
const TYPE_FIELDS: Record<string, string[]> = {
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url'],
  Ref: ['name', 'prefix'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'author'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'body', 'files', 'url'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo'],
  PullRequestFileEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
};

const SEARCH_TYPE_VALUES = ['DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'];

// ------------------------------------------------------------------ executor

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type AnyObject = Record<string, unknown>;

function pageInfoOf(cursors: string[], hasNext: boolean): AnyObject {
  return {
    __typename: 'PageInfo',
    hasNextPage: hasNext,
    hasPreviousPage: false,
    startCursor: cursors.length > 0 ? cursors[0] : null,
    endCursor: cursors.length > 0 ? cursors[cursors.length - 1] : null,
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObject(repo: Repo, issue: Issue): AnyObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: Pull): AnyObject {
  return { __typename: 'PullRequest', repo, pull };
}

function repoObject(repo: Repo): AnyObject {
  return { __typename: 'Repository', repo };
}

/** The issues connection for a repo, honouring states, orderBy and cursor pagination. */
function issuesConnection(repo: Repo, args: Record<string, unknown>): AnyObject {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  let direction = 'DESC';
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  if (orderBy !== undefined && typeof orderBy.direction === 'string') direction = orderBy.direction;
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const after = typeof args.after === 'string' ? numberFromCursor(args.after) : null;
  if (after !== null) {
    list = list.filter((issue) => (direction === 'ASC' ? issue.number > after : issue.number < after));
  }
  const first = typeof args.first === 'number' && Number.isSafeInteger(args.first) ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNext = list.length > page.length;
  const nodes = page.map((issue) => issueObject(repo, issue));
  return {
    __typename: 'IssueConnection',
    nodes,
    edges: nodes.map((node) => ({ __typename: 'IssueEdge', node, cursor: cursorFor((node.issue as Issue).number) })),
    pageInfo: pageInfoOf(nodes.map((node) => cursorFor((node.issue as Issue).number)), hasNext),
    totalCount: list.length,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): AnyObject {
  let list = repo.pulls.filter((pull) => pull.state === 'open');
  list.sort((a, b) => b.number - a.number);
  const after = typeof args.after === 'string' ? numberFromCursor(args.after) : null;
  if (after !== null) list = list.filter((pull) => pull.number < after);
  const first = typeof args.first === 'number' && Number.isSafeInteger(args.first) ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNext = list.length > page.length;
  const nodes = page.map((pull) => pullObject(repo, pull));
  return {
    __typename: 'PullRequestConnection',
    nodes,
    edges: nodes.map((node) => ({ __typename: 'PullRequestEdge', node, cursor: cursorFor((node.pull as Pull).number) })),
    pageInfo: pageInfoOf(nodes.map((node) => cursorFor((node.pull as Pull).number)), hasNext),
  };
}

function filesConnection(ctx: ExecContext, repo: Repo, pull: Pull, args: Record<string, unknown>): AnyObject {
  const files = diffFiles(ctx.forge, repo, pull);
  const first = typeof args.first === 'number' && Number.isSafeInteger(args.first) ? args.first : files.length;
  const page = files.slice(0, first);
  const hasNext = files.length > page.length;
  const nodes = page.map((file) => ({
    __typename: 'PullRequestFile',
    path: file.filename,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    status: file.status.toUpperCase(),
  }));
  return {
    __typename: 'PullRequestFileConnection',
    nodes,
    edges: nodes.map((node, index) => ({ __typename: 'PullRequestFileEdge', node, cursor: cursorFor(index + 1) })),
    pageInfo: pageInfoOf(nodes.map((_node, index) => cursorFor(index + 1)), hasNext),
  };
}

function resolveField(typeName: string, obj: AnyObject, field: FieldNode, ctx: ExecContext): unknown {
  const args = argsOf(field, ctx.variables);
  const repo = obj.repo as Repo | undefined;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') {
        return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
      }
      if (field.name === 'repository') {
        const found = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return found === undefined ? null : repoObject(found);
      }
      if (field.name === 'node') {
        const decoded = typeof args.id === 'string' ? parseGid(args.id) : null;
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          for (const candidate of ctx.forge.repos.values()) {
            if (candidate.id === Number(decoded.parts[0])) return repoObject(candidate);
          }
          return null;
        }
        if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest' || decoded.kind === 'IssueComment') {
          const repoId = Number(decoded.parts[0]);
          for (const candidate of ctx.forge.repos.values()) {
            if (candidate.id !== repoId) continue;
            if (decoded.kind === 'Issue') {
              const issue = candidate.issues.find((entry) => entry.number === Number(decoded.parts[1]));
              return issue === undefined ? null : issueObject(candidate, issue);
            }
            if (decoded.kind === 'PullRequest') {
              const pull = candidate.pulls.find((entry) => entry.number === Number(decoded.parts[1]));
              return pull === undefined ? null : pullObject(candidate, pull);
            }
            const issue = candidate.issues.find((entry) => entry.number === Number(decoded.parts[1]));
            const comment = issue?.comments.find((entry) => entry.id === Number(decoded.parts[2]));
            return comment === undefined || issue === undefined
              ? null
              : { __typename: 'IssueComment', repo: candidate, issue, comment };
          }
          return null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        const fields = TYPE_FIELDS[name];
        return {
          __typename: '__Type',
          name,
          kind: name === 'SearchType' ? 'ENUM' : 'OBJECT',
          fields: fields === undefined ? null : fields.map((fieldName) => ({ __typename: '__Field', name: fieldName })),
          enumValues: name === 'SearchType' ? SEARCH_TYPE_VALUES.map((value) => ({ __typename: '__EnumValue', name: value })) : null,
          description: null,
        };
      }
      break;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.repositoryId === 'string' ? parseGid(input.repositoryId) : null;
        if (decoded === null || decoded.kind !== 'Repository') return { __typename: 'CreateIssuePayload', issue: null };
        let target: Repo | undefined;
        for (const candidate of ctx.forge.repos.values()) if (candidate.id === Number(decoded.parts[0])) target = candidate;
        if (target === undefined) return { __typename: 'CreateIssuePayload', issue: null };
        const issue = ctx.forge.createIssue(target, String(input.title ?? ''), String(input.body ?? ''), []);
        return { __typename: 'CreateIssuePayload', issue: issueObject(target, issue) };
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.issueId === 'string' ? parseGid(input.issueId) : null;
        if (decoded === null || decoded.kind !== 'Issue') return { __typename: 'CloseIssuePayload', issue: null };
        for (const candidate of ctx.forge.repos.values()) {
          if (candidate.id !== Number(decoded.parts[0])) continue;
          const issue = candidate.issues.find((entry) => entry.number === Number(decoded.parts[1]));
          if (issue === undefined) return { __typename: 'CloseIssuePayload', issue: null };
          issue.state = 'closed';
          return { __typename: 'CloseIssuePayload', issue: issueObject(candidate, issue) };
        }
        return { __typename: 'CloseIssuePayload', issue: null };
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.repositoryId === 'string' ? parseGid(input.repositoryId) : null;
        if (decoded === null || decoded.kind !== 'Repository') return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        let target: Repo | undefined;
        for (const candidate of ctx.forge.repos.values()) if (candidate.id === Number(decoded.parts[0])) target = candidate;
        if (target === undefined) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        const headTip = ctx.forge.refTip(target, `refs/heads/${headRef}`);
        const baseTip = ctx.forge.refTip(target, `refs/heads/${baseRef}`);
        if (headTip === undefined || baseTip === undefined) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        const existing = target.pulls.find((entry) => entry.state === 'open' && entry.headRef === headRef && entry.baseRef === baseRef);
        const pull = existing ?? ctx.forge.createPull(target, String(input.title ?? ''), String(input.body ?? ''), headRef, headTip, baseRef, baseTip);
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(target, pull) };
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.pullRequestId === 'string' ? parseGid(input.pullRequestId) : null;
        if (decoded === null || decoded.kind !== 'PullRequest') return { __typename: 'MergePullRequestPayload', pullRequest: null };
        for (const candidate of ctx.forge.repos.values()) {
          if (candidate.id !== Number(decoded.parts[0])) continue;
          const pull = candidate.pulls.find((entry) => entry.number === Number(decoded.parts[1]));
          if (pull === undefined) return { __typename: 'MergePullRequestPayload', pullRequest: null };
          if (pull.state === 'closed') return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(candidate, pull) };
          const result = squashMerge(ctx.forge, candidate, pull);
          if ('conflict' in result) {
            ctx.errors.push({ message: 'Merge conflict' });
            return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(candidate, pull) };
          }
          return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(candidate, pull) };
        }
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.subjectId === 'string' ? parseGid(input.subjectId) : null;
        if (decoded === null || decoded.kind !== 'Issue') return { __typename: 'AddCommentPayload', commentEdge: null };
        for (const candidate of ctx.forge.repos.values()) {
          if (candidate.id !== Number(decoded.parts[0])) continue;
          const issue = candidate.issues.find((entry) => entry.number === Number(decoded.parts[1]));
          if (issue === undefined) return { __typename: 'AddCommentPayload', commentEdge: null };
          const comment = ctx.forge.addComment(candidate, issue, String(input.body ?? ''));
          return {
            __typename: 'AddCommentPayload',
            commentEdge: {
              __typename: 'IssueCommentEdge',
              node: { __typename: 'IssueComment', id: gid('IssueComment', candidate.id, issue.number, comment.id), body: comment.body },
              cursor: cursorFor(comment.id),
            },
          };
        }
        return { __typename: 'AddCommentPayload', commentEdge: null };
      }
      break;
    }
    case 'User': {
      if (field.name === 'login') return obj.login;
      if (field.name === 'id') return obj.id;
      if (field.name === 'name') return obj.name;
      if (field.name === 'email') return obj.email;
      break;
    }
    case 'Repository': {
      if (repo === undefined) return null;
      if (field.name === 'id') return repoGid(repo);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return { __typename: 'User', login: repo.owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
      if (field.name === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' };
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
      if (field.name === 'issue') {
        const number = Number(args.number);
        const issue = repo.issues.find((entry) => entry.number === number);
        return issue === undefined ? null : issueObject(repo, issue);
      }
      if (field.name === 'issues') return issuesConnection(repo, args);
      if (field.name === 'pullRequest') {
        const number = Number(args.number);
        const pull = repo.pulls.find((entry) => entry.number === number);
        return pull === undefined ? null : pullObject(repo, pull);
      }
      if (field.name === 'pullRequests') return pullsConnection(repo, args);
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return obj.name;
      if (field.name === 'prefix') return obj.prefix;
      break;
    }
    case 'Issue': {
      const issue = obj.issue as Issue;
      if (field.name === 'id') return issueGid(repo as Repo, issue);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issueState(issue);
      if (field.name === 'body') return issue.body;
      if (field.name === 'url') return `https://github.com/${(repo as Repo).owner}/${(repo as Repo).name}/issues/${issue.number}`;
      if (field.name === 'author') return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
      break;
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return obj.nodes;
      if (field.name === 'edges') return obj.edges;
      if (field.name === 'pageInfo') return obj.pageInfo;
      if (field.name === 'totalCount') return obj.totalCount;
      break;
    }
    case 'IssueEdge': {
      if (field.name === 'node') return obj.node;
      if (field.name === 'cursor') return obj.cursor;
      break;
    }
    case 'PullRequest': {
      const pull = obj.pull as Pull;
      if (repo === undefined) return null;
      if (field.name === 'id') return pullGid(repo, pull);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'state') return pullState(pull);
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'mergeable') {
        if (pull.state !== 'open') return 'UNKNOWN';
        return mergeConflict(ctx.forge, repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      }
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'headRef') return { __typename: 'Ref', name: pull.headRef, prefix: 'refs/heads/' };
      if (field.name === 'baseRef') return { __typename: 'Ref', name: pull.baseRef, prefix: 'refs/heads/' };
      if (field.name === 'body') return pull.body;
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      if (field.name === 'files') return filesConnection(ctx, repo, pull, args);
      break;
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return obj.nodes;
      if (field.name === 'edges') return obj.edges;
      if (field.name === 'pageInfo') return obj.pageInfo;
      break;
    }
    case 'PullRequestEdge': {
      if (field.name === 'node') return obj.node;
      if (field.name === 'cursor') return obj.cursor;
      break;
    }
    case 'PullRequestFile': {
      if (field.name === 'path') return obj.path;
      if (field.name === 'additions') return obj.additions;
      if (field.name === 'deletions') return obj.deletions;
      if (field.name === 'changes') return obj.changes;
      if (field.name === 'status') return obj.status;
      break;
    }
    case 'PullRequestFileConnection': {
      if (field.name === 'nodes') return obj.nodes;
      if (field.name === 'edges') return obj.edges;
      if (field.name === 'pageInfo') return obj.pageInfo;
      break;
    }
    case 'PullRequestFileEdge': {
      if (field.name === 'node') return obj.node;
      if (field.name === 'cursor') return obj.cursor;
      break;
    }
    case 'IssueComment': {
      if (field.name === 'id') return obj.id;
      if (field.name === 'body') return obj.body;
      if (field.name === 'author') return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
      break;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return obj.node;
      if (field.name === 'cursor') return obj.cursor;
      break;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return obj.hasNextPage;
      if (field.name === 'hasPreviousPage') return obj.hasPreviousPage;
      if (field.name === 'startCursor') return obj.startCursor;
      if (field.name === 'endCursor') return obj.endCursor;
      break;
    }
    case '__Type': {
      if (field.name === 'name') return obj.name;
      if (field.name === 'kind') return obj.kind;
      if (field.name === 'fields') return obj.fields;
      if (field.name === 'enumValues') return obj.enumValues;
      if (field.name === 'description') return obj.description;
      break;
    }
    case '__Field': {
      if (field.name === 'name') return obj.name;
      if (field.name === 'description') return null;
      if (field.name === 'args') return [];
      if (field.name === 'type') return { __typename: '__Type', name: 'String', kind: 'SCALAR', fields: null, enumValues: null, description: null };
      break;
    }
    case '__EnumValue': {
      if (field.name === 'name') return obj.name;
      if (field.name === 'description') return null;
      break;
    }
    default: {
      // Payload objects (CreateIssuePayload and friends) expose their one field directly.
      if (field.name in obj) return obj[field.name];
      break;
    }
  }
  return undefined;
}

/** Resolve a selection set against an object of `typeName`; unknown fields become errors. */
function resolveSelections(typeName: string, obj: AnyObject, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeName !== typeName) continue;
      const nested = resolveSelections(typeName, obj, selection.children, ctx);
      if (nested === null) return null;
      Object.assign(out, nested);
      continue;
    }
    const known = (TYPE_FIELDS[typeName] ?? []).includes(selection.name)
      || typeName === 'Query'
      || typeName === 'Mutation'
      || (typeName.endsWith('Payload') && selection.name in obj);
    if (!known && typeName !== 'Query' && typeName !== 'Mutation') {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      return null;
    }
    const value = resolveField(typeName, obj, selection, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      return null;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveValueNode(value, selection.children, ctx);
    if (out[key] === null && ctx.errors.length > 0) return null;
  }
  return out;
}

/** Walk a resolved value, applying child selections to objects and lists of objects. */
function resolveValueNode(value: unknown, children: SelectionNode[], ctx: ExecContext): unknown {
  if (children.length === 0 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => resolveValueNode(entry, children, ctx));
  if (typeof value === 'object') {
    const obj = value as AnyObject;
    const typeName = String(obj.__typename ?? '');
    if (typeName === '') return value;
    return resolveSelections(typeName, obj, children, ctx);
  }
  return value;
}

export interface GraphQLResult {
  data: unknown;
  errors?: Array<{ message: string }>;
}

/** Execute one operation document (or a batched array of them). */
export function executeGraphQL(forge: Forge, body: unknown): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) return body.map((entry) => executeOne(forge, entry));
  return executeOne(forge, body);
}

function executeOne(forge: Forge, body: unknown): GraphQLResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'GraphQL body must be an object with query and variables' }] };
  }
  const query = (body as Record<string, unknown>).query;
  const variables = (body as Record<string, unknown>).variables;
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'GraphQL body must include a query string' }] };
  }
  const vars: Record<string, unknown> = typeof variables === 'object' && variables !== null && !Array.isArray(variables)
    ? (variables as Record<string, unknown>)
    : {};
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  const operation = operations[0] as Operation;
  const ctx: ExecContext = { forge, variables: vars, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyObject = { __typename: rootType };
  const data = resolveSelections(rootType, root, operation.selections, ctx);
  if (data === null || ctx.errors.length > 0) {
    return { data: null, errors: ctx.errors.length > 0 ? ctx.errors : [{ message: 'GraphQL execution failed' }] };
  }
  return { data };
}
