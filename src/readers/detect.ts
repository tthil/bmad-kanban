import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { loadBmadConfig, type BmadConfig } from '../bmad/config.js';
import type { Board, SourceKind, SourceRef, StoryDetail } from '../model.js';
import { detectV6Sprint, readV6Sprint, v6SprintDetailPath } from './v6Sprint.js';
import { findSpecFolders, readV6Spec, v6SpecDetailPath } from './v6Spec.js';
import { listV7Folders, v7DetailPath, v7EntryText, type V7FolderKind } from './v7Tree.js';
import { readV7 } from './v7Script.js';

export class UnknownSourceError extends Error {
  constructor(sourceId: string) {
    super(`Unknown source: ${sourceId}`);
    this.name = 'UnknownSourceError';
  }
}

export class UnknownStoryError extends Error {
  constructor(storyKey: string) {
    super(`Unknown story: ${storyKey}`);
    this.name = 'UnknownStoryError';
  }
}

/** `scripts: false` never runs the project's own scripts (--no-scripts). */
export interface ReadOptions {
  scripts?: boolean;
}

export interface SourceListing {
  sources: SourceRef[];
  defaultSourceId: string | null;
  tags: ('v6' | 'v7')[];
  version: string | null;
  error?: string;
}

type Target =
  | { type: 'v6-sprint'; id: string; label: string; path: string }
  | { type: 'v6-spec'; id: string; label: string; path: string }
  | { type: 'v7'; id: string; label: string; path: string; folderKind: V7FolderKind };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Child initiative slugs named by a parent's tickets.toml `[[initiative]]` tables. */
function childSlugs(folder: string): string[] {
  try {
    const doc = parseToml(fs.readFileSync(path.join(folder, 'tickets', 'tickets.toml'), 'utf8'));
    const rows = Array.isArray(doc.initiative) ? doc.initiative : [];
    return rows.flatMap((r) => (typeof r === 'object' && r !== null && typeof (r as { slug?: unknown }).slug === 'string' ? [(r as { slug: string }).slug] : []));
  } catch {
    return [];
  }
}

function v7Kind(kind: V7FolderKind): SourceKind {
  return kind === 'parent' ? 'v7-parent' : kind === 'backlog' ? 'v7-backlog' : 'v7-initiative';
}

function v7Target(f: { path: string; name: string; kind: V7FolderKind }): Target {
  return f.kind === 'backlog'
    ? { type: 'v7', id: 'v7-backlog', label: 'Backlog', path: f.path, folderKind: f.kind }
    : { type: 'v7', id: `v7:${f.name}`, label: f.name, path: f.path, folderKind: f.kind };
}

function kindOf(t: Target): SourceKind {
  return t.type === 'v7' ? v7Kind(t.folderKind) : t.type;
}

const liveCount = (b: Board): number => b.stories.filter((s) => s.column !== 'dropped').length;

function resolveTarget(cfg: BmadConfig, sourceId: string): Target | null {
  if (sourceId === 'v6-sprint') {
    return detectV6Sprint(cfg) ? { type: 'v6-sprint', id: sourceId, label: 'v6 sprint', path: cfg.implementationArtifacts } : null;
  }
  if (sourceId.startsWith('v6-spec:')) {
    const name = sourceId.slice('v6-spec:'.length);
    const folder = findSpecFolders(cfg).find((f) => path.basename(f) === name);
    return folder === undefined ? null : { type: 'v6-spec', id: sourceId, label: name, path: folder };
  }
  const v7 = listV7Folders(cfg);
  if (sourceId === 'v7-backlog') {
    const f = v7.find((x) => x.kind === 'backlog');
    return f === undefined ? null : v7Target(f);
  }
  if (sourceId.startsWith('v7:')) {
    const name = sourceId.slice(3);
    const f = v7.find((x) => x.kind !== 'backlog' && x.name === name);
    return f === undefined ? null : v7Target(f);
  }
  return null;
}

async function loadBoard(cfg: BmadConfig, t: Target, opts: ReadOptions): Promise<Board> {
  if (t.type === 'v6-sprint') return readV6Sprint(cfg, t.id);
  if (t.type === 'v6-spec') return readV6Spec(t.path, t.id);
  return readV7(cfg, t.path, t.folderKind, t.id, opts.scripts === false ? null : undefined);
}

function refFor(t: Target, board: Board | null): SourceRef {
  const ref: SourceRef = {
    id: t.id,
    kind: kindOf(t),
    label: t.type === 'v6-spec' && board !== null ? board.label : t.label,
    path: t.path,
    count: 0,
  };
  if (board === null) return ref;
  if (board.children !== undefined) {
    ref.children = board.children.map((c) => ({
      id: c.sourceId,
      kind: c.kind,
      label: c.label,
      path: path.join(path.dirname(t.path), c.sourceId.slice(3)),
      count: liveCount(c),
    }));
    ref.count = ref.children.reduce((n, c) => n + c.count, 0);
  } else {
    ref.count = liveCount(board);
  }
  return ref;
}

async function refOf(cfg: BmadConfig, t: Target, opts: ReadOptions): Promise<SourceRef> {
  try {
    return refFor(t, await loadBoard(cfg, t, opts));
  } catch {
    return refFor(t, null);
  }
}

export async function listSources(root: string, opts: ReadOptions = {}): Promise<SourceListing> {
  let cfg: BmadConfig;
  try {
    cfg = loadBmadConfig(root);
  } catch (e) {
    return { sources: [], defaultSourceId: null, tags: [], version: null, error: message(e) };
  }
  const targets: Target[] = [];
  if (detectV6Sprint(cfg)) targets.push(resolveTarget(cfg, 'v6-sprint') as Target);
  for (const f of findSpecFolders(cfg)) {
    targets.push({ type: 'v6-spec', id: `v6-spec:${path.basename(f)}`, label: path.basename(f), path: f });
  }
  const folders = listV7Folders(cfg);
  const children = new Set(folders.filter((f) => f.kind === 'parent').flatMap((f) => childSlugs(f.path)));
  for (const f of folders) {
    if (f.kind !== 'backlog' && f.kind !== 'parent' && children.has(f.name)) continue;
    targets.push(v7Target(f));
  }
  const sources = await Promise.all(targets.map((t) => refOf(cfg, t, opts)));

  const flat = sources.flatMap((s) => [s, ...(s.children ?? [])]);
  const active = cfg.activeInitiative === null ? undefined : flat.find((s) => s.id === `v7:${cfg.activeInitiative}`);
  const tags: ('v6' | 'v7')[] = [];
  if (sources.some((s) => s.kind.startsWith('v6'))) tags.push('v6');
  if (sources.some((s) => s.kind.startsWith('v7'))) tags.push('v7');
  return { sources, defaultSourceId: active?.id ?? sources[0]?.id ?? null, tags, version: cfg.version };
}

export async function readBoard(root: string, sourceId: string, opts: ReadOptions = {}): Promise<Board> {
  let cfg: BmadConfig;
  try {
    cfg = loadBmadConfig(root);
  } catch {
    throw new UnknownSourceError(sourceId);
  }
  const t = resolveTarget(cfg, sourceId);
  if (t === null) throw new UnknownSourceError(sourceId);
  try {
    return markNoFile(cfg, t, await loadBoard(cfg, t, opts));
  } catch (e) {
    return {
      sourceId,
      kind: kindOf(t),
      label: t.label,
      epics: [],
      stories: [],
      notices: [{ level: 'error', text: `Could not read this board: ${message(e)}` }],
    };
  }
}

function inside(root: string, file: string): boolean {
  try {
    const base = fs.realpathSync(root);
    const real = fs.realpathSync(file);
    return real === base || real.startsWith(base + path.sep);
  } catch {
    return false;
  }
}

function detailFile(cfg: BmadConfig, t: Target, storyKey: string): string | null {
  return t.type === 'v6-sprint'
    ? v6SprintDetailPath(cfg, storyKey)
    : t.type === 'v6-spec'
      ? v6SpecDetailPath(t.path, storyKey)
      : v7DetailPath(t.path, storyKey);
}

/** Flag stories with nothing to read: no story/plan file and, for v7, no description in tickets.toml. */
function markNoFile(cfg: BmadConfig, t: Target, board: Board): Board {
  for (const s of board.stories) {
    const file = detailFile(cfg, t, s.key);
    const readable = file !== null ? inside(cfg.root, file) : t.type === 'v7' && v7EntryText(t.path, s.key) !== null;
    if (!readable) s.noFile = true;
  }
  for (const c of board.children ?? []) {
    const ct = resolveTarget(cfg, c.sourceId);
    if (ct !== null) markNoFile(cfg, ct, c);
  }
  return board;
}

export async function getStoryDetail(
  root: string,
  sourceId: string,
  storyKey: string,
  opts: ReadOptions = {},
): Promise<StoryDetail> {
  let cfg: BmadConfig;
  try {
    cfg = loadBmadConfig(root);
  } catch {
    throw new UnknownSourceError(sourceId);
  }
  const t = resolveTarget(cfg, sourceId);
  if (t === null) throw new UnknownSourceError(sourceId);
  const file = detailFile(cfg, t, storyKey);
  if (file === null) {
    if (t.type === 'v7') {
      const text = v7EntryText(t.path, storyKey);
      if (text === null) throw new UnknownStoryError(storyKey);
      return { path: null, markdown: text };
    }
    // a story on the board whose file hasn't been written yet is not an error
    const board = await loadBoard(cfg, t, opts);
    if (!board.stories.some((s) => s.key === storyKey)) throw new UnknownStoryError(storyKey);
    return { path: null, markdown: '' };
  }
  if (!inside(cfg.root, file)) throw new UnknownStoryError(storyKey);
  return { path: file, markdown: fs.readFileSync(file, 'utf8') };
}
