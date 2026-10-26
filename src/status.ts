import type { Column } from './model.js';

export type Layout = 'v6-sprint' | 'v6-spec' | 'v7';

export const COLUMNS: Column[] = ['backlog', 'ready', 'in-progress', 'review', 'done'];

interface Entry { column: Column; blocked?: boolean }

const TABLES: Record<Layout, Record<string, Entry>> = {
  'v6-sprint': {
    'backlog': { column: 'backlog' },
    'ready-for-dev': { column: 'ready' },
    'drafted': { column: 'ready' },
    'in-progress': { column: 'in-progress' },
    'contexted': { column: 'in-progress' },
    'review': { column: 'review' },
    'done': { column: 'done' },
  },
  'v6-spec': {
    'draft': { column: 'backlog' },
    'backlog': { column: 'backlog' },
    'ready-for-dev': { column: 'ready' },
    'in-progress': { column: 'in-progress' },
    'review': { column: 'review' },
    'in-review': { column: 'review' },
    'done': { column: 'done' },
  },
  'v7': {
    'draft': { column: 'backlog' },
    'ready-for-dev': { column: 'ready' },
    'in-progress': { column: 'in-progress' },
    'blocked': { column: 'in-progress', blocked: true },
    'in-review': { column: 'review' },
    'built': { column: 'review' },
    'done': { column: 'done' },
    'dropped': { column: 'dropped' },
  },
};

export function mapStatus(
  layout: Layout,
  raw: string | null | undefined,
): { column: Column; blocked?: boolean; unknownStatus?: string } {
  const key = (raw ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (key === '') return { column: 'backlog' };
  const table = TABLES[layout];
  const hit = Object.hasOwn(table, key) ? table[key] : undefined;
  if (hit) return hit.blocked ? { column: hit.column, blocked: true } : { column: hit.column };
  return { column: 'backlog', unknownStatus: (raw ?? '').trim() };
}

const V7_STATES: Record<string, Column> = {
  'backlog': 'backlog',
  'in-progress': 'in-progress',
  'review': 'review',
  'done': 'done',
  'dropped': 'dropped',
};

/** Map a v7 `state` value (tickets.py) to a column. */
export function mapV7State(state: string): Column {
  const key = state.trim().toLowerCase();
  return Object.hasOwn(V7_STATES, key) ? V7_STATES[key] : 'backlog';
}
