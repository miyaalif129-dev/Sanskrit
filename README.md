# github-forge

A GitHub-compatible git forge, written from scratch in TypeScript with only the Node standard
library — no dependencies, no git binary, no network access at runtime. It is the entry for the
make.fun bounty **"Build a GitHub-compatible git forge"** (github-core-clone-01).

## What it serves

- **Git smart HTTP** (`/{owner}/{repo}.git`): protocol v2 upload-pack (`ls-refs`, `fetch` with
  shallow/deepen, thin packs), v0 advertisements, and v0 receive-pack with `report-status`,
  `side-band-64k` and `delete-refs`. Fast-forward only: a non-fast-forward push is refused per ref
  with `ng <ref> non-fast-forward`, and a mixed push applies the fast-forward ref and refuses the
  other. Packfiles are built and read here (zlib + SHA-1, plain objects, ofs/ref delta decoding on
  read); git objects live in memory.
- **REST v3** (`/api/v3`): repos (create/list/get/patch/delete, paginated with `Link` next),
  branches, commits, git refs, file contents (PUT create/update with stale-sha 409, DELETE),
  labels, issues (with comments), pull requests (with files, squash merge, 405 on conflict).
  Every reply is `application/json` with a non-empty `X-GitHub-Request-Id`; unknown routes are
  404 JSON, malformed JSON is 400, a missing or wrong token is 401, and the same repo name under
  another owner is 404, never 403.
- **GraphQL v4** (`/api/graphql`): viewer, repository, node, `__type` introspection, issues and
  pull requests with cursor pagination, and the five mutations (createIssue, closeIssue,
  createPullRequest, mergePullRequest, addComment). Batched arrays answer arrays in order;
  unknown fields answer HTTP 200 with an `errors` array naming the field.
- **MCP** (`/mcp`): JSON-RPC 2.0, modern era 2026-07-28 (`server/discover`) with the 2025-11-25
  `initialize` fallback. Tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request` — the same store as REST, so a repo created by one
  surface reads back identically from the others.

## Layout

Flat, one file per surface, so the code uploads cleanly through the GitHub web UI:

| file | what it holds |
| --- | --- |
| `main.ts` | the entry <-> env lifecycle (bind, register, wait for done) — kept as the starter ships it |
| `app.ts` | the HTTP server and router |
| `store.ts` | the in-memory forge: repos, objects, refs, issues, pulls; deterministic ids and times |
| `git.ts` | pkt-lines, packfiles, git objects, smart HTTP, squash merge |
| `rest.ts` | REST v3 handlers |
| `graphql.ts` | the GraphQL parser and executor |
| `mcp.ts` | the MCP endpoint and tools |

## Determinism

The trial replays the same requests and expects byte-identical answers, so the entry never reads
the wall clock, never calls `Math.random`, and never stores a time: every timestamp comes from
`MAKEFUN_TRIAL_NOW`, every id comes from a counter, and every commit SHA comes from its bytes.
The viewer is the scenario's fixed token owner, `adaiversen` (id 1000) — the shop token itself
carries no login.

## Running it

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL`, `MAKEFUN_SHOP_TOKEN`, `MAKEFUN_TRIAL_NOW` and `MAKEFUN_TRIAL_SEED` come from
the environment. The entry binds an ephemeral port, registers it, and exits 0 when the env says
the trial is done. To grade it locally, from inside the kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/github-forge --driver process
```
