// app.ts — the server: one Forge, four surfaces.
//
// Routes, in the order they are tried:
//
//   GET  /healthz                                   the env's boot probe: 200 {"ok":true}
//   /{owner}/{repo}.git/info/refs                   git smart HTTP advertisements (v2 or v0)
//   POST /{owner}/{repo}.git/git-upload-pack        upload-pack, v2 or v0
//   POST /{owner}/{repo}.git/git-receive-pack       receive-pack v0 with report-status
//   /api/v3/*                                       REST v3 (auth: Bearer $MAKEFUN_SHOP_TOKEN)
//   POST /api/graphql                               GraphQL v4 (auth, batched arrays allowed)
//   POST /mcp                                       MCP, JSON-RPC 2.0 (auth first, then parsing)
//
// Every reply carries a deterministic X-GitHub-Request-Id (a counter, never the clock). A handler
// that throws answers 500 JSON instead of dropping the connection, and a body that is not valid
// JSON answers 400 — the git endpoints excepted, where a malformed body is the handler's problem.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, nextRequestId } from './store.ts';
import { gitInfoRefs, gitReceivePack, gitUploadPack } from './git.ts';
import { handleRest, type RestContext } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The shop token the trial sets; empty in local development, where any bearer is accepted. */
function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** Is this request authorised for the authenticated surfaces? */
function isAuthorized(req: IncomingMessage): boolean {
  const token = shopToken();
  if (token === '') return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read the whole request body (a pack can be a few hundred KiB). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; `bodyError` is true when the bytes are present but not valid JSON. */
function parseJsonBody(raw: Buffer): { body: unknown; bodyError: boolean } {
  if (raw.length === 0) return { body: undefined, bodyError: false };
  try {
    return { body: JSON.parse(raw.toString('utf8')), bodyError: false };
  } catch {
    return { body: undefined, bodyError: true };
  }
}

const GIT_ROUTE = /^\/([^/]+)\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = GIT_ROUTE.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const endpoint = gitMatch[3] as string;
          const v2 = req.headers['git-protocol'] === 'version=2';
          if (endpoint === 'info/refs' && method === 'GET') {
            const service = queryOf(req).get('service') ?? '';
            const result = await gitInfoRefs(forge, owner, repoName, service, v2);
            if (result.contentType === 'application/json') sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
            else sendBytes(res, result.status, result.contentType, result.body);
            return;
          }
          if (endpoint === 'git-upload-pack' && method === 'POST') {
            const raw = await readBody(req);
            const result = await gitUploadPack(forge, owner, repoName, raw, v2);
            if (result.contentType === 'application/json') sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
            else sendBytes(res, result.status, result.contentType, result.body);
            return;
          }
          if (endpoint === 'git-receive-pack' && method === 'POST') {
            const raw = await readBody(req);
            const result = await gitReceivePack(forge, owner, repoName, raw);
            if (result.contentType === 'application/json') sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
            else sendBytes(res, result.status, result.contentType, result.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // GraphQL v4: auth, then the executor (a batched array answers an array).
        if (path === '/api/graphql' && method === 'POST') {
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const raw = await readBody(req);
          const { body, bodyError } = parseJsonBody(raw);
          if (bodyError) {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          sendJson(res, 200, executeGraphQL(forge, body));
          return;
        }

        // MCP: auth first (a missing token is a 401 before any parsing), then JSON-RPC.
        if (path === '/mcp' && method === 'POST') {
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const raw = await readBody(req);
          const { body, bodyError } = parseJsonBody(raw);
          const outcome = handleMcp(forge, body, bodyError);
          if (outcome.body === null) {
            sendEmpty(res, outcome.status);
            return;
          }
          sendJson(res, outcome.status, outcome.body);
          return;
        }

        // REST v3: everything under /api/v3, with auth.
        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const raw = await readBody(req);
          const { body, bodyError } = parseJsonBody(raw);
          const stripped = path === '/api/v3' || path === '/api/v3/' ? '' : path.slice('/api/v3/'.length);
          const segments = stripped === '' ? [] : stripped.split('/').map((segment) => decodeURIComponent(segment));
          const host = req.headers.host ?? '127.0.0.1';
          const ctx: RestContext = {
            method,
            path,
            segments,
            query: queryOf(req),
            origin: `http://${host}`,
            body,
            bodyError,
          };
          const outcome = handleRest(forge, ctx);
          if (outcome.status === 204) {
            sendEmpty(res, 204);
            return;
          }
          sendJson(res, outcome.status, outcome.body, outcome.headers ?? {});
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
