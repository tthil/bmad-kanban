import type { Board, Column, DoneSort, Epic, Story } from '../src/model.js';

export const BOARD_COLUMNS: Column[] = ['backlog', 'ready', 'in-progress', 'review', 'done', 'dropped'];

export const COLUMN_LABELS: Record<Column, string> = {
  'backlog': 'Backlog',
  'ready': 'Ready',
  'in-progress': 'In progress',
  'review': 'Review',
  'done': 'Done',
  'dropped': 'Dropped',
};

export interface Lane { epic: Epic | null; done: number; total: number; cells: Record<Column, Story[]> }

const emptyCells = (): Record<Column, Story[]> =>
  ({ 'backlog': [], 'ready': [], 'in-progress': [], 'review': [], 'done': [], 'dropped': [] });

/** Group stories by column, the Done column in `doneSort` order. `dropped` is always present but stays empty unless `showDropped`. */
export function byColumn(
  stories: Story[], showDropped: boolean, epicFilter: string | null, doneSort: DoneSort = 'build',
): Record<Column, Story[]> {
  const cells = emptyCells();
  for (const s of stories) {
    if (s.column === 'dropped' && !showDropped) continue;
    if (epicFilter !== null && s.epicId !== epicFilter) continue;
    cells[s.column].push(s);
  }
  cells.done = sortDone(cells.done, doneSort);
  return cells;
}

/** One lane per epic in epic order, then a `null` lane for stories without a known epic (only if non-empty). */
export function swimlanes(board: Board, showDropped: boolean, doneSort: DoneSort = 'build'): Lane[] {
  const known = new Set(board.epics.map((e) => e.id));
  const lane = (epic: Epic | null, stories: Story[]): Lane => ({
    epic,
    done: stories.filter((s) => s.column === 'done').length,
    total: stories.filter((s) => s.column !== 'dropped').length,
    cells: byColumn(stories, showDropped, null, doneSort),
  });
  const lanes = board.epics.map((e) => lane(e, board.stories.filter((s) => s.epicId === e.id)));
  const orphans = board.stories.filter((s) => s.epicId === null || !known.has(s.epicId));
  const visible = orphans.filter((s) => showDropped || s.column !== 'dropped');
  if (visible.length > 0) lanes.push(lane(null, orphans));
  return lanes;
}

const PALETTE = ['#3b82f6', '#a855f7', '#f59e0b', '#10b981', '#ef4444', '#06b6d4', '#ec4899', '#84cc16'];

export function epicColor(index: number): string {
  const n = PALETTE.length;
  return PALETTE[((index % n) + n) % n]!;
}

/** The text a card's copy button puts on the clipboard: `<id> <title>`, or the title alone when it is the story key. */
export function copyText(story: Story): string {
  const title = story.title.trim();
  return title === story.key ? title : `${story.id} ${title}`;
}

/** `28 Oct, 14:05`, with the year when it isn't the current one. */
export function doneLabel(iso: string, now = new Date()): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleString('en-GB', opts);
}

export const DONE_SORT_LABELS: Record<DoneSort, string> = { newest: 'Newest first', oldest: 'Oldest first', build: 'Build order' };

export const isDoneSort = (v: unknown): v is DoneSort => v === 'newest' || v === 'oldest' || v === 'build';

/**
 * Done cards in the chosen order; the input is in build order and ties keep it.
 * Newest: not committed, then dated newest to oldest, then undated. Oldest: dated oldest to newest,
 * then not committed, then undated.
 */
export function sortDone(stories: Story[], mode: DoneSort): Story[] {
  if (mode === 'build') return [...stories];
  const time = (s: Story): number | null => {
    if (s.doneAt === undefined) return null;
    const t = Date.parse(s.doneAt);
    return Number.isNaN(t) ? null : t;
  };
  // rank 0 comes first; within a rank, dated cards compare by time
  const rank = (s: Story): number => {
    const dated = time(s) !== null;
    if (mode === 'newest') return s.doneUncommitted && !dated ? 0 : dated ? 1 : 2;
    return dated ? 0 : s.doneUncommitted ? 1 : 2;
  };
  return stories
    .map((s, i) => ({ s, i, r: rank(s), t: time(s) }))
    .sort((a, b) => a.r - b.r || (a.t !== null && b.t !== null ? (mode === 'newest' ? b.t - a.t : a.t - b.t) : 0) || a.i - b.i)
    .map((x) => x.s);
}
