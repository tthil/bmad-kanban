import { expect, test } from 'vitest';
import type { Column } from '../src/model.js';
import { COLUMNS, mapStatus, mapV7State, type Layout } from '../src/status.js';

const cases: [Layout, string | null, Column, object?][] = [
  ['v6-sprint', 'backlog', 'backlog'], ['v6-sprint', null, 'backlog'],
  ['v6-sprint', 'ready-for-dev', 'ready'], ['v6-sprint', 'drafted', 'ready'],
  ['v6-sprint', 'in-progress', 'in-progress'], ['v6-sprint', 'contexted', 'in-progress'],
  ['v6-sprint', 'review', 'review'], ['v6-sprint', 'done', 'done'],
  ['v6-spec', 'draft', 'backlog'], ['v6-spec', 'in-review', 'review'], ['v6-spec', 'ready-for-dev', 'ready'],
  ['v7', '', 'backlog'], ['v7', 'draft', 'backlog'], ['v7', 'ready-for-dev', 'ready'],
  ['v7', 'blocked', 'in-progress', { blocked: true }], ['v7', 'built', 'review'],
  ['v7', 'in-review', 'review'], ['v7', 'dropped', 'dropped'], ['v7', 'done', 'done'],
  ['v6-sprint', 'wibble', 'backlog', { unknownStatus: 'wibble' }],
  ['v6-sprint', 'in progress', 'in-progress'], ['v6-sprint', 'IN-PROGRESS', 'in-progress'],
  ['v6-sprint', '  Ready For Dev ', 'ready'],
  ['v6-sprint', 'constructor', 'backlog', { unknownStatus: 'constructor' }],
  ['v6-spec', '__proto__', 'backlog', { unknownStatus: '__proto__' }],
  ['v7', 'toString', 'backlog', { unknownStatus: 'toString' }],
];
test.each(cases)('%s %s → %s', (layout, raw, column, extra = {}) =>
  expect(mapStatus(layout, raw)).toEqual({ column, ...extra }));
test('v7 state', () => expect(mapV7State('review')).toBe('review'));
test('v7 state covers all states', () => {
  expect(mapV7State('backlog')).toBe('backlog');
  expect(mapV7State('in-progress')).toBe('in-progress');
  expect(mapV7State('done')).toBe('done');
  expect(mapV7State('dropped')).toBe('dropped');
});
test('v7 state ignores prototype keys', () => {
  expect(mapV7State('constructor')).toBe('backlog');
  expect(mapV7State('__proto__')).toBe('backlog');
});
test('COLUMNS order', () =>
  expect(COLUMNS).toEqual(['backlog', 'ready', 'in-progress', 'review', 'done']));
