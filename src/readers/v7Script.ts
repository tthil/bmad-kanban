import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { BmadConfig } from '../bmad/config.js';
import type { Board, Epic, Notice, Story } from '../model.js';
import { mapStatus, mapV7State } from '../status.js';
import { epicTitleFromFile, listV7Folders, readV7Tree, type V7FolderKind } from './v7Tree.js';

export type RunScript = (
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const present = (v: unknown): boolean => v !== null && v !== undefined && String(v) !== '';
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export const runScript: RunScript = (cmd, args, cwd, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err === null) return resolve({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (typeof e.code === 'number') return resolve({ code: e.code, stdout: String(stdout), stderr: String(stderr) });
      reject(err);
    });
  });

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Epic titles from the initiative's `tickets/tickets.toml` [[epic]] tables, by slug. */
function epicTitles(folder: string): Map<string, string> {
  const titles = new Map<string, string>();
  const src = readText(path.join(folder, 'tickets', 'tickets.toml'));
  if (src === null) return titles;
  try {
    const rows = parseToml(src).epic;
    for (const t of Array.isArray(rows) ? rows : []) {
      if (isObj(t) && typeof t.slug === 'string' && present(t.title)) titles.set(t.slug, String(t.title));
    }
  } catch {
    // titles fall back to the slug
  }
  return titles;
}

function migrateBoard(folder: string, sourceId: string): Board {
  return readV7Tree(folder, 'pre-release', sourceId);
}

function toBoard(doc: Obj, folder: string, kind: V7FolderKind, sourceId: string): Board {
  const name = path.basename(folder);
  const backlog = kind === 'backlog';
  const titles = epicTitles(folder);
  const epics: Epic[] = [];
  const idBySlug = new Map<string, string>();
  for (const e of Array.isArray(doc.epics) ? doc.epics : []) {
    if (!isObj(e) || typeof e.slug !== 'string') continue;
    // An epic folder missing from tickets.toml has no id; the file reader keys it by slug.
    const listed = present(e.id);
    const id = listed ? String(e.id) : e.slug;
    idBySlug.set(e.slug, id);
    const title = listed
      ? (titles.get(e.slug) ?? e.slug)
      : epicTitleFromFile(path.join(folder, 'tickets', e.slug), e.slug);
    epics.push({ id, title });
  }
  const stories: Story[] = [];
  for (const row of Array.isArray(doc.tickets) ? doc.tickets : []) {
    if (!isObj(row)) continue;
    const slug = text(row.epic) || name;
    const file = text(row.file);
    const id = backlog || !present(row.id) ? file.replace(/\.md$/, '') : String(row.id);
    const epicId = backlog ? null : (idBySlug.get(slug) ?? null);
    const status = text(row.status);
    const m = mapStatus('v7', status);
    const column = present(row.tracker_status) ? mapV7State(text(row.state)) : m.column;
    const type = row.type === 'spike' || row.type === 'bug' ? row.type : 'story';
    const story: Story = {
      key: `${backlog ? name : slug}/${id}`,
      id: epicId !== null ? `${epicId}.${id}` : id,
      title: text(row.title) || id,
      epicId,
      column,
      rawStatus: status === '' ? null : status,
      type,
    };
    if (m.blocked || status === 'blocked' || present(row.blocked_at)) story.blocked = true;
    if (!present(row.tracker_status) && m.unknownStatus !== undefined) story.unknownStatus = m.unknownStatus;
    stories.push(story);
  }
  return { sourceId, kind: backlog ? 'v7-backlog' : 'v7-initiative', label: name, epics, stories, notices: [] };
}

async function toParent(
  cfg: BmadConfig,
  doc: Obj,
  folder: string,
  sourceId: string,
  run: RunScript,
): Promise<Board> {
  const name = path.basename(folder);
  const notices: Notice[] = [];
  const children: Board[] = [];
  const known = listV7Folders(cfg);
  for (const i of Array.isArray(doc.initiatives) ? doc.initiatives : []) {
    const slug = isObj(i) && typeof i.slug === 'string' ? i.slug : null;
    if (slug === null) continue;
    const hit = known.find((f) => f.name === slug);
    if (hit === undefined || hit.kind === 'backlog') {
      notices.push({ level: 'warn', text: `Child initiative ${slug} has no folder yet` });
    } else if (hit.kind === 'parent') {
      notices.push({ level: 'warn', text: `Child ${slug} is itself a parent initiative; a parent holds initiatives, not other parents` });
    } else {
      children.push(await readV7(cfg, hit.path, hit.kind, `v7:${slug}`, run));
    }
  }
  return { sourceId, kind: 'v7-parent', label: name, epics: [], stories: [], notices, children };
}

export async function readV7(
  cfg: BmadConfig,
  folder: string,
  kind: V7FolderKind,
  sourceId: string,
  run: RunScript = runScript,
): Promise<Board> {
  const script = path.join(cfg.root, '_bmad', 'method', 'scripts', 'tickets.py');
  if (!fs.existsSync(script)) return readV7Tree(folder, kind, sourceId);
  try {
    const res = await run('uv', ['run', '--no-project', script, 'status', folder], cfg.root, 10000);
    if (res.code !== 0) {
      if (res.code !== null && (res.stderr + res.stdout).includes('bmad migrate')) return migrateBoard(folder, sourceId);
      return readV7Tree(folder, kind, sourceId);
    }
    const doc: unknown = JSON.parse(res.stdout);
    if (!isObj(doc) || (kind === 'parent' ? !Array.isArray(doc.initiatives) : !Array.isArray(doc.tickets))) {
      return readV7Tree(folder, kind, sourceId);
    }
    return kind === 'parent' ? await toParent(cfg, doc, folder, sourceId, run) : toBoard(doc, folder, kind, sourceId);
  } catch {
    return readV7Tree(folder, kind, sourceId);
  }
}
