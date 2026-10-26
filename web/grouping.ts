import type { Board, Column, Epic, Story } from '../src/model.js';

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

/** Group stories by column. `dropped` is always present but stays empty unless `showDropped`. */
export function byColumn(stories: Story[], showDropped: boolean, epicFilter: string | null): Record<Column, Story[]> {
  const cells = emptyCells();
  for (const s of stories) {
    if (s.column === 'dropped' && !showDropped) continue;
    if (epicFilter !== null && s.epicId !== epicFilter) continue;
    cells[s.column].push(s);
  }
  return cells;
}

/** One lane per epic in epic order, then a `null` lane for stories without a known epic (only if non-empty). */
export function swimlanes(board: Board, showDropped: boolean): Lane[] {
  const known = new Set(board.epics.map((e) => e.id));
  const lane = (epic: Epic | null, stories: Story[]): Lane => ({
    epic,
    done: stories.filter((s) => s.column === 'done').length,
    total: stories.filter((s) => s.column !== 'dropped').length,
    cells: byColumn(stories, showDropped, null),
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
