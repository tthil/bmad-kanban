import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBmadConfig } from '../src/bmad/config.js';
import { findV7Plan, listV7Folders, readV7Tree, v7DetailPath, v7EntryText } from '../src/readers/v7Tree.js';

const root = path.join(import.meta.dirname, 'fixtures', 'v7');
const cfg = loadBmadConfig(root);
const store = path.join(root, 'store');
const checkout = path.join(store, 'initiative-checkout');
const story = (b: ReturnType<typeof readV7Tree>, id: string) => b.stories.find((s) => s.id === id);
const hasReduced = (b: ReturnType<typeof readV7Tree>) =>
  b.notices.some((n) => n.level === 'info' && n.text.includes('reduced fidelity'));

describe('listV7Folders', () => {
  it('lists initiatives, parent, pre-release and backlog, backlog last', () => {
    expect(listV7Folders(cfg).map((f) => [f.name, f.kind])).toEqual([
      ['initiative-checkout', 'initiative'],
      ['initiative-flat', 'initiative'],
      ['initiative-old', 'pre-release'],
      ['initiative-parent', 'parent'],
      ['backlog', 'backlog'],
    ]);
    expect(listV7Folders(cfg)[0].path).toBe(checkout);
  });

  it('skips backlog without .md files and returns [] for a missing output folder', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v7-'));
    fs.mkdirSync(path.join(tmp, 'backlog'));
    expect(listV7Folders({ ...cfg, outputFolder: tmp })).toEqual([]);
    expect(listV7Folders({ ...cfg, outputFolder: path.join(tmp, 'nope') })).toEqual([]);
    fs.rmSync(tmp, { recursive: true });
  });
});

describe('readV7Tree initiative with epics', () => {
  const board = readV7Tree(checkout, 'initiative', 'src1');

  it('has epics in tickets.toml order, including one without a folder', () => {
    expect(board.kind).toBe('v7-initiative');
    expect(board.label).toBe('initiative-checkout');
    expect(board.epics).toEqual([
      { id: '1', title: 'Pricing rules' },
      { id: '2', title: 'Cart rules' },
    ]);
  });

  it('maps plan statuses to columns', () => {
    expect(story(board, '1.1')).toMatchObject({ key: 'epic-pricing-rules/1', epicId: '1', column: 'review', rawStatus: 'built', type: 'story' });
    expect(story(board, '1.2')).toMatchObject({ column: 'in-progress', blocked: true });
    expect(story(board, '1.3')).toMatchObject({ type: 'spike', column: 'backlog', rawStatus: null });
    expect(story(board, '1.4')).toMatchObject({ column: 'dropped' });
  });

  it('uses leaf status only when no plan exists', () => {
    expect(story(board, '1.5')).toMatchObject({ column: 'done', rawStatus: 'done' });
    expect(story(board, '1.2')?.rawStatus).toBe('blocked');
  });

  it('keeps build order and notes reduced fidelity', () => {
    expect(board.stories.map((s) => s.id)).toEqual(['1.1', '1.2', '1.3', '1.4', '1.5']);
    expect(hasReduced(board)).toBe(true);
  });
});

describe('readV7Tree other kinds', () => {
  it('reads a flat initiative without epics', () => {
    const b = readV7Tree(path.join(store, 'initiative-flat'), 'initiative', 's');
    expect(b.epics).toEqual([]);
    expect(b.stories).toHaveLength(1);
    expect(b.stories[0]).toMatchObject({ key: 'initiative-flat/1', id: '1', epicId: null, column: 'in-progress' });
    expect(hasReduced(b)).toBe(true);
  });

  it('reads the backlog', () => {
    const b = readV7Tree(path.join(store, 'backlog'), 'backlog', 's');
    expect(b.kind).toBe('v7-backlog');
    expect(b.stories).toHaveLength(1);
    expect(b.stories[0]).toMatchObject({
      key: 'backlog/bug-checkout-total',
      type: 'bug',
      title: 'Checkout total ignores codes',
      column: 'ready',
      epicId: null,
    });
    expect(hasReduced(b)).toBe(false);
  });

  it('reports the pre-release layout', () => {
    const b = readV7Tree(path.join(store, 'initiative-old'), 'pre-release', 's');
    expect(b.stories).toEqual([]);
    expect(b.notices).toContainEqual({ level: 'warn', text: expect.stringContaining('bmad migrate method') });
    expect(hasReduced(b)).toBe(false);
  });

  it('reads a parent with its children', () => {
    const b = readV7Tree(path.join(store, 'initiative-parent'), 'parent', 's');
    expect(b.kind).toBe('v7-parent');
    expect(b.children?.map((c) => c.label)).toEqual(['initiative-checkout', 'initiative-flat']);
    expect(b.children?.[0].stories).toHaveLength(5);
    expect(hasReduced(b)).toBe(true);
  });

  it('turns a malformed tickets.toml into an error notice', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v7-'));
    const dir = path.join(tmp, 'initiative-bad');
    fs.mkdirSync(path.join(dir, 'tickets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tickets', 'tickets.toml'), '[[entry\nid = ');
    const b = readV7Tree(dir, 'initiative', 's');
    expect(b.stories).toEqual([]);
    expect(b.notices.some((n) => n.level === 'error')).toBe(true);
    fs.rmSync(tmp, { recursive: true });
  });
});

describe('plan and detail lookups', () => {
  const epicTickets = path.join(checkout, 'tickets', 'epic-pricing-rules', 'tickets');

  it('finds a plan by ticket id', () => {
    expect(findV7Plan(epicTickets, '2')).toBe(path.join(epicTickets, 'story-tax-rules-plan.md'));
    expect(findV7Plan(epicTickets, '3')).toBeNull();
    expect(findV7Plan(path.join(store, 'nope'), '1')).toBeNull();
  });

  it('resolves detail paths plan first, then leaf file, else null', () => {
    expect(v7DetailPath(checkout, 'epic-pricing-rules/2')).toBe(path.join(epicTickets, 'story-tax-rules-plan.md'));
    expect(v7DetailPath(checkout, 'epic-pricing-rules/5')).toBe(path.join(epicTickets, 'story-legacy.md'));
    expect(v7DetailPath(checkout, 'epic-pricing-rules/3')).toBeNull();
    expect(v7DetailPath(path.join(store, 'initiative-flat'), 'initiative-flat/1')).toMatch(/story-only-story-plan\.md$/);
    expect(v7DetailPath(path.join(store, 'backlog'), 'backlog/bug-checkout-total')).toBe(
      path.join(store, 'backlog', 'bug-checkout-total.md'),
    );
  });

  it('rejects unsafe keys', () => {
    for (const k of ['../x/1', 'epic-pricing-rules/../../x', 'epic-pricing-rules\\2', '.hidden/1', 'epic-pricing-rules/.x', '', 'epic-pricing-rules', '/etc/passwd']) {
      expect(v7DetailPath(checkout, k)).toBeNull();
      expect(v7EntryText(checkout, k)).toBeNull();
    }
  });

  it('returns entry text when no file exists', () => {
    const t = v7EntryText(checkout, 'epic-pricing-rules/3');
    expect(t).toContain('Finds out whether rounding');
    expect(t).toContain('Verify: A short note states');
    expect(v7EntryText(checkout, 'epic-pricing-rules/99')).toBeNull();
  });
});
