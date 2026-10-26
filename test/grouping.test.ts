import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBmadConfig } from '../src/bmad/config.js';
import type { Board, Story } from '../src/model.js';
import { readV6Sprint } from '../src/readers/v6Sprint.js';
import { byColumn, copyText, epicColor, swimlanes } from '../web/grouping.js';

const story = (key: string, column: Story['column'], epicId: string | null = '1'): Story => ({
  key, id: key, title: key, epicId, column, rawStatus: column,
});

const board = (stories: Story[]): Board => ({
  sourceId: 's', kind: 'v7-initiative', label: 'x',
  epics: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }],
  stories, notices: [],
});

describe('byColumn', () => {
  const stories = [story('a', 'backlog'), story('b', 'dropped'), story('c', 'done', '2'), story('d', 'done')];

  it('excludes dropped stories unless showDropped', () => {
    const hidden = byColumn(stories, false, null);
    expect(Object.keys(hidden)).toEqual(['backlog', 'ready', 'in-progress', 'review', 'done', 'dropped']);
    expect(hidden.backlog.map((s) => s.key)).toEqual(['a']);
    expect(hidden.done.map((s) => s.key)).toEqual(['c', 'd']);
    expect(hidden.dropped).toEqual([]);
    const shown = byColumn(stories, true, null);
    expect(shown.dropped.map((s) => s.key)).toEqual(['b']);
  });

  it('keeps only stories of the filtered epic', () => {
    const g = byColumn(stories, true, '2');
    expect(Object.values(g).flat().map((s) => s.key)).toEqual(['c']);
  });
});

describe('swimlanes', () => {
  it('counts done/total per epic for the v6-sprint fixture', () => {
    const b = readV6Sprint(loadBmadConfig(path.join(import.meta.dirname, 'fixtures', 'v6-sprint')), 's');
    const lanes = swimlanes(b, false);
    expect(lanes.map((l) => l.epic?.id ?? null)).toEqual(['1', '2']);
    expect(lanes[0]).toMatchObject({ done: 1, total: 2 });
    expect(lanes[0]!.cells.done.map((s) => s.key)).toEqual(['1-1-user-login']);
    expect(lanes[0]!.cells['in-progress'].map((s) => s.key)).toEqual(['1-2-password-reset']);
  });

  it('puts stories with no or unknown epic in a final null lane', () => {
    const lanes = swimlanes(board([story('a', 'ready', '1'), story('b', 'review', 'nope'), story('c', 'backlog', null)]), false);
    expect(lanes.map((l) => l.epic?.id ?? null)).toEqual(['1', '2', null]);
    expect(lanes[2]!.cells.review.map((s) => s.key)).toEqual(['b']);
    expect(lanes[2]!.cells.backlog.map((s) => s.key)).toEqual(['c']);
  });

  it('omits the null lane when empty and excludes dropped from total', () => {
    const lanes = swimlanes(board([story('a', 'done'), story('b', 'dropped')]), false);
    expect(lanes.map((l) => l.epic?.id ?? null)).toEqual(['1', '2']);
    expect(lanes[0]).toMatchObject({ done: 1, total: 1 });
    expect(lanes[0]!.cells.dropped).toEqual([]);
    expect(swimlanes(board([story('b', 'dropped')]), true)[0]!.cells.dropped.map((s) => s.key)).toEqual(['b']);
    expect(swimlanes(board([story('b', 'dropped')]), true)[0]!.total).toBe(0);
  });
});

describe('epicColor', () => {
  it('cycles a fixed 8-colour palette', () => {
    const colors = Array.from({ length: 8 }, (_, i) => epicColor(i));
    expect(new Set(colors).size).toBe(8);
    expect(epicColor(8)).toBe(epicColor(0));
    expect(epicColor(-1)).toBe(epicColor(7));
  });
});

describe('copyText', () => {
  it('joins the display id and title', () => {
    expect(copyText({ ...story('epic-pricing-rules/2', 'review'), id: '1.2', title: 'Tax rules' })).toBe('1.2 Tax rules');
  });

  it('uses the title alone when it already is the id', () => {
    expect(copyText({ ...story('2-9-orphan-story', 'review'), id: '2.9', title: '2-9-orphan-story' })).toBe('2-9-orphan-story');
  });

  it('trims surrounding whitespace from the title', () => {
    expect(copyText({ ...story('x', 'backlog'), id: '3', title: '  Only story \n' })).toBe('3 Only story');
  });
});
