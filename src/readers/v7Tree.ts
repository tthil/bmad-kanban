import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { BmadConfig } from '../bmad/config.js';
import { FrontmatterError, readFrontmatter } from '../bmad/frontmatter.js';
import type { Board, Epic, Notice, Story } from '../model.js';
import { mapStatus } from '../status.js';

export type V7FolderKind = 'initiative' | 'parent' | 'backlog' | 'pre-release';

type Obj = Record<string, unknown>;
type LeafType = 'story' | 'spike' | 'bug';

const BREAKDOWN = 'tickets.toml';
const TICKETS = 'tickets';
const LEAF_TYPES: readonly string[] = ['story', 'spike', 'bug'];
const REDUCED =
  'Read directly from the ticket files (reduced fidelity): prerequisites, "next" ordering and tracker status are not applied. Install uv and the BMad method scripts for the full view.';

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function firstLine(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}

/** Parse a tickets.toml; `null` doc when the file is absent, `error` when it is malformed. */
function readBreakdown(dir: string): { doc: Obj | null; error?: string } {
  const text = readText(path.join(dir, BREAKDOWN));
  if (text === null) return { doc: null };
  try {
    const doc = parseToml(text);
    return { doc: isObj(doc) ? doc : {} };
  } catch (err) {
    return { doc: null, error: firstLine(err) };
  }
}

function tables(doc: Obj | null, kind: string): Obj[] {
  const rows = doc !== null && Object.hasOwn(doc, kind) ? doc[kind] : undefined;
  return Array.isArray(rows) ? rows.filter(isObj) : [];
}

const present = (v: unknown): boolean => v !== null && v !== undefined && String(v) !== '';

/** A container's breakdown folder: `<folder>/tickets` when it exists, else the folder itself (backlog). */
function ticketsDirOf(folder: string): string {
  const t = path.join(folder, TICKETS);
  return isDir(t) ? t : folder;
}

function safeSegment(s: string): boolean {
  return s !== '' && !s.startsWith('.') && !s.includes('/') && !s.includes('\\') && !s.includes('\0');
}

interface Leaf {
  file: string;
  stem: string;
  fm: Obj;
}
interface Plan {
  file: string;
  ticket: string;
  status: unknown;
}

function scanDir(dir: string, notices?: Notice[]): { leaves: Leaf[]; plans: Plan[] } {
  const leaves: Leaf[] = [];
  const plans: Plan[] = [];
  const names = listDir(dir)
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    const file = path.join(dir, name);
    let fm: Obj;
    try {
      fm = readFrontmatter(readText(file) ?? '').data;
    } catch (err) {
      if (!(err instanceof FrontmatterError)) throw err;
      notices?.push({ level: 'warn', text: `${name}: ${err.message}` });
      continue;
    }
    if (typeof fm.type === 'string' && LEAF_TYPES.includes(fm.type)) {
      leaves.push({ file, stem: name.slice(0, -3), fm });
    } else if (name.endsWith('-plan.md') && present(fm.ticket)) {
      plans.push({ file, ticket: String(fm.ticket), status: fm.status });
    }
  }
  return { leaves, plans };
}

export function findV7Plan(ticketsDir: string, id: string): string | null {
  return scanDir(ticketsDir).plans.find((p) => p.ticket === id)?.file ?? null;
}

interface Row {
  id: string;
  entry: Obj | null;
  leaf: Leaf | null;
  plan: Plan | null;
}

/** Entries in order, joined to leaf files by `id`, then unlisted leaves; plans join by `ticket`. */
function buildRows(dir: string, entries: Obj[], notices: Notice[], backlog: boolean): Row[] {
  const { leaves, plans } = scanDir(dir, notices);
  const rows: Row[] = [];
  const byId = new Map<string, Row>();
  for (const e of entries) {
    if (!present(e.id)) {
      notices.push({ level: 'warn', text: `Skipped an entry without an id in ${path.basename(path.dirname(dir))}/${BREAKDOWN}` });
      continue;
    }
    const id = String(e.id);
    if (byId.has(id)) {
      notices.push({ level: 'warn', text: `Duplicate entry id ${id} in ${path.basename(path.dirname(dir))}/${BREAKDOWN}` });
      continue;
    }
    const row: Row = { id, entry: e, leaf: null, plan: null };
    byId.set(id, row);
    rows.push(row);
  }
  const unlisted: Row[] = [];
  for (const leaf of leaves) {
    const lid = present(leaf.fm.id) ? String(leaf.fm.id) : null;
    const hit = !backlog && lid !== null ? byId.get(lid) : undefined;
    if (hit) {
      hit.leaf ??= leaf;
    } else {
      unlisted.push({ id: backlog || lid === null ? leaf.stem : lid, entry: null, leaf, plan: null });
    }
  }
  unlisted.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  rows.push(...unlisted);
  for (const plan of plans) {
    const row = rows.find((r) => r.id === plan.ticket) ?? rows.find((r) => r.leaf?.stem === plan.ticket);
    if (row && row.plan === null) row.plan = plan;
  }
  return rows;
}

function toStory(row: Row, slug: string, epicId: string | null, backlog: boolean): Story {
  const raw = row.plan !== null ? row.plan.status : row.leaf?.fm.status;
  const rawStatus = raw === null || raw === undefined ? null : String(raw);
  const m = mapStatus('v7', rawStatus);
  const typeRaw = row.entry?.type ?? row.leaf?.fm.type;
  const type: LeafType = typeof typeRaw === 'string' && LEAF_TYPES.includes(typeRaw) ? (typeRaw as LeafType) : 'story';
  const leafTitle = row.leaf !== null && present(row.leaf.fm.title) ? String(row.leaf.fm.title) : null;
  const entryTitle = row.entry !== null && present(row.entry.title) ? String(row.entry.title) : null;
  const story: Story = {
    key: `${slug}/${row.id}`,
    id: epicId !== null && !backlog ? `${epicId}.${row.id}` : row.id,
    title: leafTitle ?? entryTitle ?? row.id,
    epicId,
    column: m.column,
    rawStatus,
    type,
  };
  if (m.blocked) story.blocked = true;
  if (m.unknownStatus !== undefined) story.unknownStatus = m.unknownStatus;
  return story;
}

function folderKind(dir: string): V7FolderKind | null {
  const name = path.basename(dir);
  const { doc } = readBreakdown(path.join(dir, TICKETS));
  if (isFile(path.join(dir, TICKETS, BREAKDOWN))) return tables(doc, 'initiative').length > 0 ? 'parent' : 'initiative';
  if (isFile(path.join(dir, BREAKDOWN))) return 'pre-release';
  if (name === 'backlog' && listDir(dir).some((e) => e.isFile() && e.name.endsWith('.md'))) return 'backlog';
  return null;
}

export function listV7Folders(cfg: BmadConfig): { path: string; name: string; kind: V7FolderKind }[] {
  const out: { path: string; name: string; kind: V7FolderKind }[] = [];
  for (const e of listDir(cfg.outputFolder)) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = path.join(cfg.outputFolder, e.name);
    const kind = folderKind(p);
    if (kind !== null) out.push({ path: p, name: e.name, kind });
  }
  return out.sort((a, b) => {
    if ((a.kind === 'backlog') !== (b.kind === 'backlog')) return a.kind === 'backlog' ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

export function epicTitleFromFile(epicFolder: string, slug: string): string {
  const text = readText(path.join(epicFolder, `${slug}.md`));
  if (text !== null) {
    try {
      const t = readFrontmatter(text).data.title;
      if (present(t)) return String(t);
    } catch {
      // fall back to the slug
    }
  }
  return slug;
}

function readInitiative(folder: string, sourceId: string): Board {
  const name = path.basename(folder);
  const notices: Notice[] = [{ level: 'info', text: REDUCED }];
  const epics: Epic[] = [];
  const stories: Story[] = [];
  const board: Board = { sourceId, kind: 'v7-initiative', label: name, epics, stories, notices };

  const tdir = ticketsDirOf(folder);
  const { doc, error } = readBreakdown(tdir);
  if (error !== undefined) {
    notices.push({ level: 'error', text: `Could not parse ${BREAKDOWN} in ${name}: ${error}` });
    return board;
  }

  const listed: { id: string; slug: string; title: string }[] = [];
  for (const t of tables(doc, 'epic')) {
    if (typeof t.slug !== 'string' || !safeSegment(t.slug) || !present(t.id)) {
      notices.push({ level: 'warn', text: `Skipped an epic without a usable id or slug in ${name}/${BREAKDOWN}` });
      continue;
    }
    if (listed.some((l) => l.slug === t.slug || l.id === String(t.id))) {
      notices.push({ level: 'warn', text: `Duplicate epic ${String(t.id)} (${t.slug}) in ${name}/${BREAKDOWN}` });
      continue;
    }
    listed.push({ id: String(t.id), slug: t.slug, title: present(t.title) ? String(t.title) : t.slug });
  }
  const unlistedSlugs = listDir(tdir)
    .filter((e) => e.isDirectory() && e.name.startsWith('epic-') && !listed.some((l) => l.slug === e.name))
    .map((e) => e.name)
    .sort();
  const all = [
    ...listed,
    ...unlistedSlugs.map((slug) => ({ id: slug, slug, title: epicTitleFromFile(path.join(tdir, slug), slug) })),
  ];

  if (all.length === 0) {
    for (const row of buildRows(tdir, tables(doc, 'entry'), notices, false)) stories.push(toStory(row, name, null, false));
    return board;
  }
  for (const ep of all) {
    epics.push({ id: ep.id, title: ep.title });
    const epicFolder = path.join(tdir, ep.slug);
    if (!isDir(epicFolder)) continue;
    const edir = ticketsDirOf(epicFolder);
    const eb = readBreakdown(edir);
    if (eb.error !== undefined) {
      notices.push({ level: 'error', text: `Could not parse ${BREAKDOWN} in ${ep.slug}: ${eb.error}` });
    }
    for (const row of buildRows(edir, tables(eb.doc, 'entry'), notices, false)) {
      stories.push(toStory(row, ep.slug, ep.id, false));
    }
  }
  return board;
}

function readBacklog(folder: string, sourceId: string): Board {
  const notices: Notice[] = [];
  const stories = buildRows(folder, [], notices, true).map((r) => toStory(r, path.basename(folder), null, true));
  return { sourceId, kind: 'v7-backlog', label: path.basename(folder), epics: [], stories, notices };
}

function readParent(folder: string, sourceId: string): Board {
  const name = path.basename(folder);
  const notices: Notice[] = [{ level: 'info', text: REDUCED }];
  const children: Board[] = [];
  const board: Board = { sourceId, kind: 'v7-parent', label: name, epics: [], stories: [], notices, children };
  const { doc, error } = readBreakdown(ticketsDirOf(folder));
  if (error !== undefined) {
    notices.push({ level: 'error', text: `Could not parse ${BREAKDOWN} in ${name}: ${error}` });
    return board;
  }
  for (const t of tables(doc, 'initiative')) {
    if (typeof t.slug !== 'string' || !safeSegment(t.slug)) {
      notices.push({ level: 'warn', text: `Skipped a child initiative without a usable slug in ${name}/${BREAKDOWN}` });
      continue;
    }
    const dir = path.join(path.dirname(folder), t.slug);
    const kind = isDir(dir) ? folderKind(dir) : null;
    if (kind === 'parent') {
      notices.push({ level: 'warn', text: `Child ${t.slug} is itself a parent initiative; a parent holds initiatives, not other parents` });
      continue;
    }
    if (kind === null || kind === 'backlog') {
      notices.push({ level: 'warn', text: `Child initiative ${t.slug} has no folder yet` });
      continue;
    }
    children.push(readV7Tree(dir, kind, `v7:${t.slug}`));
  }
  return board;
}

export function readV7Tree(folder: string, kind: V7FolderKind, sourceId: string): Board {
  const name = path.basename(folder);
  switch (kind) {
    case 'backlog':
      return readBacklog(folder, sourceId);
    case 'parent':
      return readParent(folder, sourceId);
    case 'pre-release':
      return {
        sourceId,
        kind: 'v7-initiative',
        label: name,
        epics: [],
        stories: [],
        notices: [
          {
            level: 'warn',
            text: `${name} uses the pre-release ticket layout; run "bmad migrate method" to move it into tickets/ folders.`,
          },
        ],
      };
    default:
      return readInitiative(folder, sourceId);
  }
}

/** Resolve a story key to its breakdown folder and the row id/stem inside it. */
function locate(folder: string, storyKey: string): { dir: string; rest: string; entries: Obj[] } | null {
  if (!storyKey.includes('/')) return null;
  const idx = storyKey.indexOf('/');
  const slug = storyKey.slice(0, idx);
  const rest = storyKey.slice(idx + 1);
  if (!safeSegment(slug) || !safeSegment(rest)) return null;
  const base = path.resolve(folder);
  const dir = slug === path.basename(base) ? ticketsDirOf(base) : ticketsDirOf(path.join(ticketsDirOf(base), slug));
  if (slug !== path.basename(base) && !isDir(path.join(ticketsDirOf(base), slug))) return null;
  if (!inside(base, dir)) return null;
  return { dir, rest, entries: tables(readBreakdown(dir).doc, 'entry') };
}

function inside(base: string, target: string): boolean {
  try {
    const b = fs.realpathSync(base);
    const t = fs.realpathSync(target);
    return t === b || t.startsWith(b + path.sep);
  } catch {
    return false;
  }
}

export function v7DetailPath(folder: string, storyKey: string): string | null {
  const loc = locate(folder, storyKey);
  if (loc === null) return null;
  const { leaves, plans } = scanDir(loc.dir);
  const leaf = leaves.find((l) => present(l.fm.id) && String(l.fm.id) === loc.rest) ?? leaves.find((l) => l.stem === loc.rest);
  const plan = plans.find((p) => p.ticket === loc.rest) ?? (leaf ? plans.find((p) => p.ticket === leaf.stem) : undefined);
  const found = plan?.file ?? leaf?.file ?? null;
  return found !== null && inside(path.resolve(folder), found) ? found : null;
}

export function v7EntryText(folder: string, storyKey: string): string | null {
  const loc = locate(folder, storyKey);
  if (loc === null) return null;
  const entry = loc.entries.find((e) => present(e.id) && String(e.id) === loc.rest);
  if (!entry) return null;
  const parts: string[] = [];
  if (present(entry.description)) parts.push(String(entry.description));
  if (present(entry.verify)) parts.push(`Verify: ${String(entry.verify)}`);
  return parts.length > 0 ? parts.join('\n\n') : null;
}
