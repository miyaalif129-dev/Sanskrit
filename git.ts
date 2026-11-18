// git.ts — the git half of the forge: pkt-lines, packfiles, git objects, smart HTTP.
//
// This is a from-scratch git, written against the wire as the kit's wire.ts settles it. It knows
// four object types (blob, tree, commit, tag), plain packfiles (no deltas on write — the suite only
// ever checks that fetched objects resolve, never that a pack contains deltas), protocol v2
// upload-pack (ls-refs, fetch, shallow), v0 advertisements, and v0 receive-pack with report-status.
//
// Packs are read with node's zlib: each object's data is one zlib stream inside the pack, and the
// Inflate stream's bytesWritten tells exactly how many input bytes that stream consumed, which is
// how the reader finds the next entry. A pack's trailer is the SHA-1 of everything before it.

import { createHash } from 'node:crypto';
import { createInflate, deflateSync } from 'node:zlib';
import type { Forge, GitObject, Pull, Repo } from './store.ts';
import { identityLine, objectId, trialEpochSec, trialIso } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const MAIN_REF = 'refs/heads/main';

/** What the client sends as the branch name of the default branch (refs/heads/main). */
const UPLOAD_CAPS_V2 = ['ls-refs=unborn', 'fetch=shallow', 'object-format=sha1', 'agent=github-forge/1.0'];
const UPLOAD_CAPS_V0 = [
  'multi_ack', 'thin-pack', 'side-band', 'side-band-64k', 'ofs-delta', 'shallow', 'no-progress',
  'symref=HEAD:refs/heads/main', 'agent=github-forge/1.0',
];
const RECEIVE_CAPS_V0 = [
  'report-status', 'side-band-64k', 'delete-refs', 'ofs-delta',
  'symref=HEAD:refs/heads/main', 'agent=github-forge/1.0',
];

// ------------------------------------------------------------------ pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const hex = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(hex, 'ascii'), body]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');

export type PktItem = { kind: 'line'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Split a buffer into pkt-line items; throws on a malformed length or trailing bytes. */
export function parsePktLines(buf: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) throw new Error('bad pkt-line length');
    if (len === 0) { items.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { items.push({ kind: 'delim' }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error('pkt-line overruns its buffer');
    items.push({ kind: 'line', data: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  if (off !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return items;
}

/** Join pkt-line items back into bytes (lines get a length prefix; flush/delim are literal). */
export function joinPktLines(items: PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item.kind === 'flush') parts.push(FLUSH_PKT);
    else if (item.kind === 'delim') parts.push(DELIM_PKT);
    else parts.push(pktLine(item.data));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ zlib

/** Inflate exactly one zlib stream starting at `offset`; `consumed` is its byte length. */
export function inflateAt(buf: Buffer, offset: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    stream.on('error', (err: Error) => reject(err));
    stream.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: stream.bytesWritten }));
    stream.end(buf.subarray(offset));
  });
}

// ------------------------------------------------------------------ packfiles

export interface PackEntry {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
  oid: string;
}

const TYPE_NAMES = ['invalid', 'commit', 'tree', 'blob', 'tag', 'invalid', 'ofs-delta', 'ref-delta'] as const;

/** Read a whole packfile, resolving ofs/ref deltas, and verifying its trailer checksum. */
export async function readPack(buf: Buffer): Promise<PackEntry[]> {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  if (buf.readUInt32BE(4) !== 2) throw new Error('unsupported pack version');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const sum = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!sum.equals(trailer)) throw new Error('pack checksum mismatch');

  interface Raw { type: number; data: Buffer; oid: string; baseOid?: string; baseOff?: number; offset: number }
  const raw: Raw[] = [];
  let off = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = off;
    let byte = buf[off];
    off += 1;
    const type = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off];
      off += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOff: number | undefined;
    if (type === 6) {
      byte = buf[off];
      off += 1;
      baseOff = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[off];
        off += 1;
        baseOff = ((baseOff + 1) << 7) | (byte & 0x7f);
      }
    } else if (type === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = await inflateAt(buf, off);
    off += inflated.consumed;
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    raw.push({ type, data: inflated.data, oid: '', baseOid, baseOff, offset: entryOffset });
  }

  const byOffset = new Map<number, Raw>();
  for (const entry of raw) byOffset.set(entry.offset, entry);
  const byOid = new Map<string, PackEntry>();
  const resolve = (entry: Raw): PackEntry => {
    if (entry.type <= 4) {
      const type = TYPE_NAMES[entry.type] as 'commit' | 'tree' | 'blob' | 'tag';
      const oid = objectId(type, entry.data);
      const resolved: PackEntry = { type, data: entry.data, oid };
      byOid.set(oid, resolved);
      return resolved;
    }
    let base: PackEntry;
    if (entry.type === 6) {
      const baseRaw = byOffset.get(entry.offset - (entry.baseOff ?? 0));
      if (baseRaw === undefined) throw new Error('ofs-delta base not found');
      base = resolve(baseRaw);
    } else {
      base = byOid.get(entry.baseOid ?? '') as PackEntry;
      if (base === undefined) throw new Error('ref-delta base not found');
    }
    const data = applyDelta(base.data, entry.data);
    const resolved: PackEntry = { type: base.type, data, oid: objectId(base.type, data) };
    byOid.set(resolved.oid, resolved);
    return resolved;
  };
  return raw.map((entry) => resolve(entry));
}

/** Apply a git delta stream to a base object, yielding the target bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos]; pos += 1; }
      if (op & 0x02) { offset |= delta[pos] << 8; pos += 1; }
      if (op & 0x04) { offset |= delta[pos] << 16; pos += 1; }
      if (op & 0x08) { offset |= delta[pos] << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos]; pos += 1; }
      if (op & 0x20) { size |= delta[pos] << 8; pos += 1; }
      if (op & 0x40) { size |= delta[pos] << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      written += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || written !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

/** Write a packfile of plain (undeltified) objects, with a SHA-1 trailer. */
export function writePack(entries: Array<{ type: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  const typeCodes: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const entry of entries) {
    const typeCode = typeCodes[entry.type] ?? 0;
    const deflated = deflateSync(entry.data, { level: 6 });
    const size = entry.data.length;
    const head: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest !== 0) first |= 0x80;
    head.push(first);
    while (rest !== 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest !== 0) byte |= 0x80;
      head.push(byte);
    }
    parts.push(Buffer.from(head), deflated);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ------------------------------------------------------------------ objects

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}

/** Parse a commit's bytes into its fields. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let timestamp = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      const match = author.match(/ (\d+) [+-]\d{4}$/);
      if (match) timestamp = Number(match[1]);
    } else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer, timestamp };
}

/** Build a commit's bytes from its fields (the exact layout git uses). */
export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree's bytes into entries (mode, name, 20-byte oid). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, space);
    if (space === -1 || nul === -1) throw new Error('malformed tree');
    const mode = data.subarray(off, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git's tree sort: directory names compare as if they ended in '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Expand a tree (recursively) into path -> {oid, mode} for every file in it. */
export function flattenTree(forge: Forge, repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = forge.getObject(repo, treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(forge, repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build nested trees from a path -> file map; returns the root tree's oid. */
export function buildTreeFromFiles(forge: Forge, repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, file);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return forge.putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** All commits reachable from `tip`, newest first (parents walked depth-first, first parent first). */
export function walkCommits(forge: Forge, repo: Repo, tip: string, limit = 100000): CommitInfo[] {
  const out: CommitInfo[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = forge.getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    out.push({ ...info, message: info.message });
    for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i] as string);
  }
  return out;
}

/** Is `ancestor` reachable from `tip` (walking parents)? */
export function isAncestor(forge: Forge, repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = forge.getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    for (const parent of info.parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The first commit reachable from both tips (the merge base), or null. */
export function mergeBase(forge: Forge, repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stack: string[] = [a];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = forge.getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = forge.getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

// ------------------------------------------------------------------ REST-made commits and merges

export interface FileChange {
  path: string;
  /** null deletes the file. */
  oid: string | null;
  mode?: string;
}

/**
 * Commit a set of file changes on `branch`, creating the branch from the default tip when it does
 * not exist yet, and return the new commit. The commit's author/committer are the viewer, stamped
 * with the trial's opening time — never the wall clock.
 */
export function commitFiles(forge: Forge, repo: Repo, branch: string, message: string, changes: FileChange[]): { commitOid: string; parent: string | null } {
  const ref = `refs/heads/${branch}`;
  let tip = forge.refTip(repo, ref);
  if (tip === undefined && branch !== repo.defaultBranch) tip = forge.headTip(repo);
  const files = new Map<string, { oid: string; mode: string }>();
  if (tip !== undefined) {
    const tipObj = forge.getObject(repo, tip);
    if (tipObj !== undefined && tipObj.type === 'commit') {
      for (const [path, file] of flattenTree(forge, repo, parseCommit(tipObj.data).tree)) files.set(path, file);
    }
  }
  for (const change of changes) {
    if (change.oid === null) files.delete(change.path);
    else files.set(change.path, { oid: change.oid, mode: change.mode ?? '100644' });
  }
  const treeOid = buildTreeFromFiles(forge, repo, files);
  const who = identityLine();
  const commit = buildCommit({
    tree: treeOid,
    parents: tip === undefined ? [] : [tip],
    message,
    author: who,
    committer: who,
    timestamp: trialEpochSec(),
  });
  const commitOid = forge.putObject(repo, 'commit', commit);
  forge.setRef(repo, ref, commitOid);
  return { commitOid, parent: tip ?? null };
}

interface ThreeWay {
  conflict: boolean;
  merged: Map<string, { oid: string; mode: string }>;
}

/** Three-way merge of `headTip` onto `baseTip` over their merge base; reports conflicts. */
export function threeWay(forge: Forge, repo: Repo, baseTip: string, headTip: string): ThreeWay {
  const base = mergeBase(forge, repo, baseTip, headTip);
  const merged = new Map<string, { oid: string; mode: string }>();
  if (base === null) return { conflict: true, merged };
  const baseObj = forge.getObject(repo, base);
  const headObj = forge.getObject(repo, headTip);
  const tipObj = forge.getObject(repo, baseTip);
  if (baseObj === undefined || headObj === undefined || tipObj === undefined) return { conflict: true, merged };
  const baseFiles = flattenTree(forge, repo, parseCommit(baseObj.data).tree);
  const headFiles = flattenTree(forge, repo, parseCommit(headObj.data).tree);
  const tipFiles = flattenTree(forge, repo, parseCommit(tipObj.data).tree);
  for (const [path, file] of tipFiles) merged.set(path, file);
  const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of allPaths) {
    const fromBase = baseFiles.get(path);
    const fromHead = headFiles.get(path);
    const fromTip = tipFiles.get(path);
    const headChanged = (fromBase?.oid ?? null) !== (fromHead?.oid ?? null);
    const tipChanged = (fromBase?.oid ?? null) !== (fromTip?.oid ?? null);
    if (headChanged && tipChanged && (fromHead?.oid ?? null) !== (fromTip?.oid ?? null)) {
      return { conflict: true, merged };
    }
    if (headChanged) {
      if (fromHead === undefined) merged.delete(path);
      else merged.set(path, fromHead);
    }
  }
  return { conflict: false, merged };
}

/** Would this pull request merge cleanly (no three-way conflict)? */
export function mergeConflict(forge: Forge, repo: Repo, pull: Pull): boolean {
  const baseTip = forge.refTip(repo, `refs/heads/${pull.baseRef}`);
  const headTip = forge.refTip(repo, `refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return true;
  return threeWay(forge, repo, baseTip, headTip).conflict;
}

/**
 * Squash-merge a pull request onto its base branch: one commit whose tree is the three-way merge,
 * parented on the base tip. Returns the merge commit's sha, or a conflict.
 */
export function squashMerge(forge: Forge, repo: Repo, pull: Pull): { sha: string } | { conflict: true } {
  const baseTip = forge.refTip(repo, `refs/heads/${pull.baseRef}`);
  const headTip = forge.refTip(repo, `refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return { conflict: true };
  const result = threeWay(forge, repo, baseTip, headTip);
  if (result.conflict) return { conflict: true };
  const treeOid = buildTreeFromFiles(forge, repo, result.merged);
  const who = identityLine();
  const message = `${pull.title} (#${pull.number})\n`;
  const commit = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    message,
    author: who,
    committer: who,
    timestamp: trialEpochSec(),
  });
  const sha = forge.putObject(repo, 'commit', commit);
  forge.setRef(repo, `refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = trialIso();
  pull.mergeCommitSha = sha;
  return { sha };
}

// ------------------------------------------------------------------ file diffs

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

function countLines(buf: Buffer | undefined): number {
  return buf === undefined ? 0 : lineCount(buf.toString('utf8'));
}

/** The files a pull request changes: diff(merge-base, head), with line counts. */
export function diffFiles(forge: Forge, repo: Repo, pull: Pull): FileDiff[] {
  const baseTip = forge.refTip(repo, `refs/heads/${pull.baseRef}`);
  const headTip = forge.refTip(repo, `refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return [];
  const base = mergeBase(forge, repo, baseTip, headTip);
  if (base === null) return [];
  const baseObj = forge.getObject(repo, base);
  const headObj = forge.getObject(repo, headTip);
  if (baseObj === undefined || headObj === undefined) return [];
  const baseFiles = flattenTree(forge, repo, parseCommit(baseObj.data).tree);
  const headFiles = flattenTree(forge, repo, parseCommit(headObj.data).tree);
  const blobOf = (file: { oid: string } | undefined): Buffer | undefined => {
    if (file === undefined) return undefined;
    const obj = forge.getObject(repo, file.oid);
    return obj === undefined ? undefined : obj.data;
  };
  const out: FileDiff[] = [];
  const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of allPaths) {
    const fromBase = baseFiles.get(path);
    const fromHead = headFiles.get(path);
    if ((fromBase?.oid ?? null) === (fromHead?.oid ?? null)) continue;
    if (fromBase === undefined && fromHead !== undefined) {
      const additions = countLines(blobOf(fromHead));
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (fromHead === undefined && fromBase !== undefined) {
      const deletions = countLines(blobOf(fromBase));
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (fromBase !== undefined && fromHead !== undefined) {
      const oldLines = (blobOf(fromBase) ?? Buffer.alloc(0)).toString('utf8').split('\n');
      const newLines = (blobOf(fromHead) ?? Buffer.alloc(0)).toString('utf8').split('\n');
      const oldSet = new Map<string, number>();
      for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
      const newSet = new Map<string, number>();
      for (const line of newLines) newSet.set(line, (newSet.get(line) ?? 0) + 1);
      let additions = 0;
      let deletions = 0;
      for (const [line, count] of newSet) additions += Math.max(0, count - (oldSet.get(line) ?? 0));
      for (const [line, count] of oldSet) deletions += Math.max(0, count - (newSet.get(line) ?? 0));
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  return out;
}

// ------------------------------------------------------------------ fetch selection

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

export interface FetchSelection {
  objects: PackEntry[];
  shallow: string[];
  unshallow: string[];
}

/** The objects a fetch must send, per protocol v2's rules. */
export function selectFetch(forge: Forge, repo: Repo, req: FetchRequest): FetchSelection {
  const held = new Set<string>();
  const addClosure = (oid: string, withAncestors: boolean): void => {
    const stack: string[] = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (held.has(current)) continue;
      const obj = forge.getObject(repo, current);
      if (obj === undefined) continue;
      held.add(current);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        if (!held.has(info.tree)) stack.push(info.tree);
        if (withAncestors) for (const parent of info.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        const match = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (match) stack.push(match[1] as string);
      }
    }
  };
  for (const have of req.haves) addClosure(have, true);
  for (const boundary of req.shallow) addClosure(boundary, false);

  // Resolve wants to commits, keeping tag objects themselves on the side.
  const wantCommits: string[] = [];
  const extraObjects: PackEntry[] = [];
  for (const want of req.wants) {
    const obj = forge.getObject(repo, want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      extraObjects.push({ type: 'tag', data: obj.data, oid: want });
      const match = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (match) {
        const target = forge.getObject(repo, match[1] as string);
        if (target !== undefined && target.type === 'commit') wantCommits.push(match[1] as string);
      }
    } else if (obj.type === 'commit') {
      wantCommits.push(want);
    }
  }

  // Depth-limited walk from the wants: generation 0 is a want, 1 its parents, and so on.
  const wanted = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = wantCommits.map((oid) => ({ oid, gen: 0 }));
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (wanted.has(oid)) continue;
    if (req.depth !== null && gen >= req.depth) continue;
    wanted.set(oid, gen);
    const obj = forge.getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, gen: gen + 1 });
  }

  const objects = new Map<string, PackEntry>();
  const addObject = (oid: string): void => {
    if (held.has(oid) || objects.has(oid)) return;
    const obj = forge.getObject(repo, oid);
    if (obj === undefined) return;
    objects.set(oid, { type: obj.type, data: obj.data, oid });
  };
  const addTreeClosure = (treeOid: string): void => {
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (held.has(oid) || objects.has(oid)) continue;
      const obj = forge.getObject(repo, oid);
      if (obj === undefined) continue;
      objects.set(oid, { type: obj.type, data: obj.data, oid });
      if (obj.type === 'tree') for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  };
  for (const [oid] of wanted) {
    if (held.has(oid)) continue;
    addObject(oid);
    const obj = forge.getObject(repo, oid);
    if (obj !== undefined && obj.type === 'commit') addTreeClosure(parseCommit(obj.data).tree);
  }
  for (const extra of extraObjects) if (!held.has(extra.oid)) objects.set(extra.oid, extra);

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (req.depth !== null) {
    for (const [oid, gen] of wanted) {
      if (gen !== req.depth - 1) continue;
      const obj = forge.getObject(repo, oid);
      if (obj !== undefined && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) shallow.push(oid);
    }
    for (const boundary of req.shallow) {
      const obj = forge.getObject(repo, boundary);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length === 0) continue;
      const allSent = parents.every((parent) => objects.has(parent) || held.has(parent));
      if (allSent) unshallow.push(boundary);
    }
  }
  return { objects: [...objects.values()], shallow, unshallow };
}

// ------------------------------------------------------------------ smart HTTP

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const jsonResult = (status: number, body: unknown): GitResult => ({
  status,
  contentType: 'application/json',
  body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'),
});

function notFound(): GitResult {
  return jsonResult(404, { message: 'Not Found' });
}

/** The tag object a ref points at, resolved to its target commit, or null. */
function peelTarget(forge: Forge, repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 8; hops += 1) {
    const obj = forge.getObject(repo, current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const match = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
    if (match === null) return null;
    current = match[1] as string;
  }
  return null;
}

/** The refs of a repo, sorted, with their tip and (for tags) peeled target. */
function sortedRefs(forge: Forge, repo: Repo): Array<{ name: string; oid: string; peeled: string | null }> {
  const out: Array<{ name: string; oid: string; peeled: string | null }> = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const obj = forge.getObject(repo, oid);
    out.push({ name, oid, peeled: obj !== undefined && obj.type === 'tag' ? peelTarget(forge, repo, oid) : null });
  }
  return out;
}

/** A v0 advertisement body: "# service=...", flush, ref lines (first carries the capabilities). */
function v0Advertisement(service: string, caps: string[], forge: Forge, repo: Repo): Buffer {
  const items: PktItem[] = [
    { kind: 'line', data: Buffer.from(`# service=${service}\n`, 'utf8') },
    { kind: 'flush' },
  ];
  const refs = sortedRefs(forge, repo);
  const headTip = forge.headTip(repo);
  const capText = caps.join(' ');
  if (refs.length === 0) {
    items.push({ kind: 'line', data: Buffer.from(`${ZERO_OID} capabilities^{}\0${capText}\n`, 'utf8') });
  } else {
    let first = true;
    const headLine = (headTip ?? ZERO_OID);
    items.push({ kind: 'line', data: Buffer.from(`${headLine} HEAD${first ? `\0${capText}` : ''}\n`, 'utf8') });
    first = false;
    for (const ref of refs) {
      items.push({ kind: 'line', data: Buffer.from(`${ref.oid} ${ref.name}${first ? `\0${capText}` : ''}\n`, 'utf8') });
      first = false;
      if (ref.peeled !== null) items.push({ kind: 'line', data: Buffer.from(`${ref.peeled} ${ref.name}^{}\n`, 'utf8') });
    }
  }
  return joinPktLines(items);
}

/** A v2 advertisement body: "version 2", capability lines, flush. */
function v2Advertisement(): Buffer {
  const items: PktItem[] = [{ kind: 'line', data: Buffer.from('version 2\n', 'utf8') }];
  for (const cap of UPLOAD_CAPS_V2) items.push({ kind: 'line', data: Buffer.from(`${cap}\n`, 'utf8') });
  items.push({ kind: 'flush' });
  return joinPktLines(items);
}

/** GET /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack */
export async function gitInfoRefs(forge: Forge, owner: string, name: string, service: string, v2: boolean): Promise<GitResult> {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return notFound();
  if (service === 'git-upload-pack') {
    if (v2) return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement('git-upload-pack', UPLOAD_CAPS_V0, forge, repo) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement('git-receive-pack', RECEIVE_CAPS_V0, forge, repo) };
  }
  return jsonResult(400, { message: `unknown service ${service}` });
}

/** Wrap bytes in sideband band-1 packets (each pkt-line at most 65520 bytes). */
export function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunkSize = 65515;
  for (let off = 0; off < data.length; off += chunkSize) {
    const chunk = data.subarray(off, Math.min(off + chunkSize, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

/** Parse an ls-refs request's arguments. */
function lsRefsArgs(items: PktItem[]): { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] } {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const item of items) {
    if (item.kind !== 'line') continue;
    const arg = item.data.toString('utf8').trim();
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  return { peel, symrefs, unborn, prefixes };
}

/** Parse a fetch request's arguments. */
function fetchArgs(items: PktItem[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const item of items) {
    if (item.kind !== 'line') continue;
    const arg = item.data.toString('utf8').trim();
    if (arg.startsWith('want ')) req.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) req.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) req.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) req.depth = n;
    }
  }
  return req;
}

/** POST /{owner}/{repo}.git/git-upload-pack — v2 (ls-refs / fetch) or v0 (want/have/done). */
export async function gitUploadPack(forge: Forge, owner: string, name: string, body: Buffer, v2: boolean): Promise<GitResult> {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return notFound();
  const resultType = 'application/x-git-upload-pack-result';
  try {
    if (v2) {
      const items = parsePktLines(body);
      const commandLine = items.find((item) => item.kind === 'line');
      const command = commandLine === undefined ? '' : commandLine.data.toString('utf8').trim();
      if (command.startsWith('command=ls-refs')) {
        const args = lsRefsArgs(items);
        const out: PktItem[] = [];
        const refs = sortedRefs(forge, repo);
        const headTip = forge.headTip(repo);
        const includeHead = args.prefixes.length === 0 || args.prefixes.some((prefix) => `refs/heads/${repo.defaultBranch}`.startsWith(prefix));
        if (refs.length === 0) {
          if (args.unborn) out.push({ kind: 'line', data: Buffer.from(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`, 'utf8') });
        } else {
          if (includeHead && headTip !== undefined) {
            out.push({ kind: 'line', data: Buffer.from(`${headTip} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`, 'utf8') });
          }
          for (const ref of refs) {
            if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
            let line = `${ref.oid} ${ref.name}`;
            if (args.peel && ref.peeled !== null) line += ` peeled:${ref.peeled}`;
            out.push({ kind: 'line', data: Buffer.from(`${line}\n`, 'utf8') });
          }
        }
        out.push({ kind: 'flush' });
        return { status: 200, contentType: resultType, body: joinPktLines(out) };
      }
      if (command.startsWith('command=fetch')) {
        const req = fetchArgs(items);
        const selection = selectFetch(forge, repo, req);
        const out: Buffer[] = [];
        const ackLines: string[] = [];
        for (const have of req.haves) {
          if (req.wants.some((want) => isAncestor(forge, repo, have, want))) ackLines.push(`ACK ${have}`);
        }
        if (ackLines.length === 0) ackLines.push('NAK');
        out.push(Buffer.from('acknowledgments\n', 'utf8'));
        for (const line of ackLines) out.push(pktLine(`${line}\n`));
        if (selection.objects.length > 0) out.push(pktLine('ready\n'));
        out.push(FLUSH_PKT);
        if (req.depth !== null || req.shallow.length > 0) {
          out.push(Buffer.from('shallow-info\n', 'utf8'));
          for (const oid of selection.shallow) out.push(pktLine(`shallow ${oid}\n`));
          for (const oid of selection.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
          out.push(FLUSH_PKT);
        }
        out.push(Buffer.from('packfile\n', 'utf8'));
        out.push(sideband(writePack(selection.objects)));
        return { status: 200, contentType: resultType, body: Buffer.concat(out) };
      }
      return jsonResult(400, { message: `unknown upload-pack command ${command}` });
    }
    // v0 fetch: want/have/done lines, then a sideband pack.
    const items = parsePktLines(body);
    const req = fetchArgs(items);
    const selection = selectFetch(forge, repo, req);
    const out: Buffer[] = [];
    let acked = false;
    for (const have of req.haves) {
      if (req.wants.some((want) => isAncestor(forge, repo, have, want))) {
        out.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) out.push(pktLine('NAK\n'));
    for (const oid of selection.shallow) out.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
    out.push(sideband(writePack(selection.objects)));
    return { status: 200, contentType: resultType, body: Buffer.concat(out) };
  } catch (err) {
    return jsonResult(400, { message: err instanceof Error ? err.message : 'bad upload-pack request' });
  }
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack — v0, with a report-status answer. */
export async function gitReceivePack(forge: Forge, owner: string, name: string, body: Buffer): Promise<GitResult> {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return notFound();
  const resultType = 'application/x-git-receive-pack-result';
  try {
    // Split the command pkt-lines from the raw pack that follows the flush.
    let off = 0;
    const commandItems: PktItem[] = [];
    while (off + 4 <= body.length) {
      const len = parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
      if (Number.isNaN(len) || len < 0) throw new Error('bad pkt-line length');
      if (len === 0) { off += 4; break; }
      if (len === 1) { off += 4; continue; }
      if (len < 4 || off + len > body.length) throw new Error('pkt-line overruns its buffer');
      commandItems.push({ kind: 'line', data: Buffer.from(body.subarray(off + 4, off + len)) });
      off += len;
    }
    const commands: PushCommand[] = [];
    for (const item of commandItems) {
      if (item.kind !== 'line') continue;
      const text = item.data.toString('utf8');
      const nul = text.indexOf('\0');
      const head = nul === -1 ? text : text.slice(0, nul);
      const parts = head.trim().split(' ');
      if (parts.length !== 3) throw new Error('bad receive-pack command');
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    const pack = body.subarray(off);
    let entries: PackEntry[] = [];
    let unpackError: string | null = null;
    if (pack.length > 0) {
      try {
        entries = await readPack(pack);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : 'unpack failed';
      }
    }
    // Every unpacked object is stored, even when its ref is refused.
    if (unpackError === null) {
      for (const entry of entries) repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
    }
    const reportLines: string[] = [];
    if (unpackError !== null) {
      reportLines.push(`unpack ${unpackError}`);
      for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed`);
    } else {
      reportLines.push('unpack ok');
      for (const command of commands) {
        const current = forge.refTip(repo, command.ref);
        if (command.newOid === ZERO_OID) {
          // Delete.
          if (current === undefined) reportLines.push(`ng ${command.ref} remote ref does not exist`);
          else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reportLines.push(`ng ${command.ref} non-fast-forward`);
          else {
            forge.deleteRef(repo, command.ref);
            reportLines.push(`ok ${command.ref}`);
          }
        } else if (command.oldOid === ZERO_OID) {
          // Create.
          if (current !== undefined) {
            reportLines.push(`ng ${command.ref} non-fast-forward`);
          } else if (forge.getObject(repo, command.newOid) === undefined) {
            reportLines.push(`ng ${command.ref} object not found`);
          } else {
            forge.setRef(repo, command.ref, command.newOid);
            reportLines.push(`ok ${command.ref}`);
          }
        } else {
          // Update: fast-forward only.
          if (current === undefined) {
            reportLines.push(`ng ${command.ref} remote ref does not exist`);
          } else if (current !== command.oldOid) {
            reportLines.push(`ng ${command.ref} non-fast-forward`);
          } else if (!isAncestor(forge, repo, command.oldOid, command.newOid)) {
            reportLines.push(`ng ${command.ref} non-fast-forward`);
          } else if (forge.getObject(repo, command.newOid) === undefined) {
            reportLines.push(`ng ${command.ref} object not found`);
          } else {
            forge.setRef(repo, command.ref, command.newOid);
            reportLines.push(`ok ${command.ref}`);
          }
        }
      }
    }
    const reportItems: PktItem[] = reportLines.map((line) => ({ kind: 'line', data: Buffer.from(`${line}\n`, 'utf8') }));
    reportItems.push({ kind: 'flush' });
    return { status: 200, contentType: resultType, body: sideband(joinPktLines(reportItems)) };
  } catch (err) {
    return jsonResult(400, { message: err instanceof Error ? err.message : 'bad receive-pack request' });
  }
}
