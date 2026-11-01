import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { BmadConfig } from '../bmad/config.js';
import { readFrontmatter } from '../bmad/frontmatter.js';
import type { Board, Story } from '../model.js';

/**
 * All git access of the board lives here. Every command is read-only and safe for untrusted repos:
 * no pager, no fsmonitor, no external diff or textconv drivers, no signature checks, no optional locks.
 */

const MAX_PARALLEL = 8;
let running = 0;
const queue: (() => void)[] = [];

/** Counts `git log` runs, so tests can check the history cache. */
export const gitStats = { log: 0 };

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  // a finished run hands its slot straight to the next waiter, so `running` never exceeds the cap
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => queue.push(resolve));
  else running++;
  try {
    return await fn();
  } finally {
    const next = queue.shift();
    if (next) next();
    else running--;
  }
}

// variables that would point git at some other repo, index or object store than the folder's own
const REPO_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR',
];

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' };
  for (const k of REPO_ENV) delete env[k];
  return env;
}

/** Runs git; `code` is its exit code, or null when git is missing, timed out or was killed. */
function run(cwd: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return slot(
    () =>
      new Promise((resolve) => {
        try {
          execFile(
            'git',
            ['--no-pager', '-c', 'core.fsmonitor=false', ...args],
            { cwd, env: gitEnv(), maxBuffer: 256 * 1024 * 1024, timeout: 30_000, windowsHide: true },
            (err, stdout) => {
              if (!err) return resolve({ code: 0, out: stdout });
              const code = (err as { code?: unknown }).code;
              resolve({ code: typeof code === 'number' && !err.killed ? code : null, out: '' });
            },
          );
        } catch {
          resolve({ code: null, out: '' });
        }
      }),
  );
}

/** Runs git; resolves to stdout, or null when git is missing or the command fails. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  const r = await run(cwd, args);
  return r.code === 0 ? r.out : null;
}

interface Repo { top: string; head: string | null }

/** The repo holding `dir` and its HEAD commit (null before the first commit), or null outside a repo. */
async function repoOf(dir: string): Promise<Repo | null> {
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (top === null || top.trim() === '') return null;
  const head = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  return { top: top.trim(), head: head === null || head.trim() === '' ? null : head.trim() };
}

/** Absolute git dir of the repo holding `dir`, or null. */
export async function gitDirOf(dir: string): Promise<string | null> {
  const out = await git(dir, ['rev-parse', '--absolute-git-dir']);
  return out === null || out.trim() === '' ? null : out.trim();
}

interface Commit { date: string; added: string[]; removed: string[] }
interface FileHistory { inHead: string | null; commits: Commit[] | null }

// keyed by repo + file; an entry is reused only while HEAD is unchanged
const cache = new Map<string, { head: string; value: Promise<FileHistory> }>();

const MARK = '\x01bk ';

function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  let cur: Commit | null = null;
  let inHunk = false; // past an `@@` line: `+`/`-` lines are content, not file headers
  for (const raw of out.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith(MARK)) {
      cur = { date: line.slice(MARK.length).trim(), added: [], removed: [] };
      commits.push(cur);
      inHunk = false;
    } else if (cur === null) {
      continue;
    } else if (line.startsWith('diff ')) {
      inHunk = false;
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk && line.startsWith('+')) {
      cur.added.push(line.slice(1));
    } else if (inHunk && line.startsWith('-')) {
      cur.removed.push(line.slice(1));
    }
  }
  return commits;
}

function history(repo: Repo & { head: string }, rel: string): Promise<FileHistory> {
  const key = `${repo.top}\0${rel}`;
  const hit = cache.get(key);
  if (hit && hit.head === repo.head) return hit.value;
  const entry: { head: string; value: Promise<FileHistory> } = { head: repo.head, value: Promise.resolve({ inHead: null, commits: null }) };
  entry.value = (async (): Promise<FileHistory> => {
    const inHead = await git(repo.top, ['show', '--no-textconv', '--no-ext-diff', `${repo.head}:${rel}`]);
    if (inHead === null) return { inHead: null, commits: null };
    gitStats.log++;
    const out = await git(repo.top, [
      'log', '--follow', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-show-signature',
      `--format=${MARK.replace('\x01', '%x01')}%aI`, repo.head, '--', rel,
    ]);
    // a failed log isn't kept: the next board load tries again
    if (out === null && cache.get(key) === entry) cache.delete(key);
    return { inHead, commits: out === null ? null : parseLog(out) };
  })();
  cache.set(key, entry);
  return entry.value;
}

async function ignored(repo: Repo, rel: string): Promise<boolean> {
  // exit 0: ignored, 1: not ignored; any failure counts as ignored so nothing is shown
  const r = await run(repo.top, ['check-ignore', '--no-index', '-q', '--', rel]);
  return r.code !== 1;
}

type Matcher = (line: string) => boolean;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `done` in any case, optionally quoted (with spaces inside the quotes), then an optional comment
const DONE_VALUE = `(['"]?)\\s*[Dd][Oo][Nn][Ee]\\s*\\2\\s*(#.*)?$`;

/** A `development_status` line of sprint-status.yaml: `  <key>: done`, optionally quoted, with a trailing comment. */
export function sprintLine(key: string): Matcher {
  const re = new RegExp(`^\\s*(['"]?)${escapeRe(key)}\\1\\s*:\\s*${DONE_VALUE}`);
  return (line) => re.test(line);
}

const FRONTMATTER_DONE = new RegExp(`^status:()\\s*${DONE_VALUE}`);
export const frontmatterLine: Matcher = (line) => FRONTMATTER_DONE.test(line);

const isDone = (v: unknown): boolean => v !== null && v !== undefined && String(v).trim().toLowerCase() === 'done';

/** Whether a sprint-status.yaml text gives `key` the status `done`. */
function sprintDone(key: string): (text: string) => boolean {
  return (text) => {
    try {
      const ds = (parseYaml(text) as { development_status?: unknown } | null)?.development_status;
      return typeof ds === 'object' && ds !== null && isDone((ds as Record<string, unknown>)[key]);
    } catch {
      return false;
    }
  };
}

/** Whether a file's frontmatter `status` is `done`. */
function frontmatterDone(text: string): boolean {
  try {
    return isDone(readFrontmatter(text).data.status);
  } catch {
    return false;
  }
}

interface Lookup { story: Story; file: string; match: Matcher; doneIn: (text: string) => boolean }

async function lookup(l: Lookup, repoFor: (dir: string) => Promise<Repo | null>): Promise<void> {
  let real: string;
  try {
    real = fs.realpathSync(l.file);
  } catch {
    return;
  }
  const repo = await repoFor(path.dirname(real));
  if (repo === null) return;
  let top: string;
  try {
    top = fs.realpathSync(repo.top);
  } catch {
    return;
  }
  const rel = path.relative(top, real).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('../') || path.isAbsolute(rel)) return;

  const h = repo.head === null ? { inHead: null, commits: null } : await history({ ...repo, head: repo.head }, rel);
  if (h.inHead === null) {
    if (!(await ignored(repo, rel))) l.story.doneUncommitted = true;
    return;
  }
  if (!l.doneIn(h.inHead)) {
    l.story.doneUncommitted = true;
    return;
  }
  // a commit that removed a done line too only moved or reformatted it
  const c = h.commits?.find((x) => x.added.some(l.match) && !x.removed.some(l.match));
  if (c !== undefined && c.date !== '') l.story.doneAt = c.date;
}

/**
 * Sets `doneAt` (author date of the newest commit that added the story's `done` status line) or
 * `doneUncommitted` on each story whose own status is `done`. `fileOf` names the file holding a
 * story's status for frontmatter layouts. Never throws.
 */
export async function addDoneTimes(
  cfg: BmadConfig,
  kind: 'v6-sprint' | 'v6-spec' | 'v7',
  board: Board,
  fileOf: (story: Story) => string | null,
): Promise<void> {
  const lookups: Lookup[] = [];
  for (const s of board.stories) {
    if (s.column !== 'done' || !isDone(s.rawStatus)) continue;
    if (kind === 'v6-sprint' && !s.quick) {
      const file = path.join(cfg.implementationArtifacts, 'sprint-status.yaml');
      lookups.push({ story: s, file, match: sprintLine(s.key), doneIn: sprintDone(s.key) });
      continue;
    }
    const file = fileOf(s);
    if (file !== null) lookups.push({ story: s, file, match: frontmatterLine, doneIn: frontmatterDone });
  }
  if (lookups.length === 0) return;
  // one repo lookup per folder per board load, so a new HEAD is always seen
  const repoDirs = new Map<string, Promise<Repo | null>>();
  const repoFor = (dir: string): Promise<Repo | null> => {
    let p = repoDirs.get(dir);
    if (!p) {
      p = repoOf(dir).catch(() => null);
      repoDirs.set(dir, p);
    }
    return p;
  };
  await Promise.all(lookups.map((l) => lookup(l, repoFor).catch(() => undefined)));
}

/** Test hook: forget cached history. */
export function clearDoneCache(): void {
  cache.clear();
}
