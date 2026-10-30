import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBmadConfig } from '../src/bmad/config.js';
import { detectV6Sprint, QUICK_EPIC_ID, readV6Sprint, v6SprintDetailPath } from '../src/readers/v6Sprint.js';

const fx = (n: string) => loadBmadConfig(path.join(import.meta.dirname, 'fixtures', n));

describe('readV6Sprint', () => {
  const cfg = fx('v6-sprint');
  const board = readV6Sprint(cfg, 'src1');

  it('reports kind, label and source id', () => {
    expect(detectV6Sprint(cfg)).toBe(true);
    expect(board.kind).toBe('v6-sprint');
    expect(board.label).toBe('v6 sprint');
    expect(board.sourceId).toBe('src1');
    expect(board.notices).toEqual([]);
  });

  it('builds epics with status and retrospective', () => {
    expect(board.epics).toEqual([
      { id: '1', title: 'Accounts', status: 'in-progress', retrospective: 'optional' },
      { id: '2', title: 'Plants', status: 'backlog' },
    ]);
  });

  it('maps stories in status-file order', () => {
    expect(board.stories.map((s) => s.key)).toEqual([
      '1-1-user-login',
      '1-2-password-reset',
      '2-1-plant-data-model',
      '2-9-orphan-story',
    ]);
    const [a, b, c, d] = board.stories;
    expect(a).toMatchObject({ id: '1.1', title: 'User login', epicId: '1', column: 'done' });
    expect(b.column).toBe('in-progress');
    expect(c.column).toBe('ready');
    expect(d).toMatchObject({ id: '2.9', title: '2-9-orphan-story', epicId: '2', column: 'review' });
  });

  it('never emits epic or retrospective keys as stories', () => {
    for (const s of board.stories) {
      expect(s.key).not.toContain('retrospective');
      expect(s.key).not.toMatch(/^epic-/);
    }
  });

  it('resolves detail paths only for existing files', () => {
    expect(v6SprintDetailPath(cfg, '1-1-user-login')).toMatch(/1-1-user-login\.md$/);
    expect(v6SprintDetailPath(cfg, '1-2-password-reset')).toBeNull();
    expect(v6SprintDetailPath(cfg, '../x')).toBeNull();
  });
});

describe('planning only', () => {
  it('lists epic-file stories as backlog', () => {
    const cfg = fx('v6-planning-only');
    expect(detectV6Sprint(cfg)).toBe(true);
    const b = readV6Sprint(cfg, 'p');
    expect(b.stories.map((s) => s.key)).toEqual([
      '1-1-user-login',
      '1-2-password-reset',
      '2-1-plant-data-model',
    ]);
    expect(b.stories.every((s) => s.column === 'backlog')).toBe(true);
    expect(b.notices).toEqual([]);
  });
});

describe('broken status file', () => {
  it('returns epics.md stories plus an error notice without throwing', () => {
    const b = readV6Sprint(fx('v6-broken'), 'b');
    expect(b.stories).toHaveLength(3);
    const errs = b.notices.filter((n) => n.level === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].text).toContain('sprint-status.yaml');
  });
});

describe('sharded epics', () => {
  it('parses epics/*.md like epics.md', () => {
    const cfg = fx('v6-sharded');
    expect(detectV6Sprint(cfg)).toBe(true);
    const b = readV6Sprint(cfg, 's');
    expect(b.epics.map((e) => e.title)).toEqual(['Accounts', 'Plants']);
    expect(b.stories.map((s) => s.id)).toEqual(['1.1', '1.2', '2.1']);
  });
});

describe('nothing present', () => {
  it('is empty without notices', () => {
    const cfg = { ...fx('v6-sprint'), planningArtifacts: '/nonexistent/a', implementationArtifacts: '/nonexistent/b' };
    expect(detectV6Sprint(cfg)).toBe(false);
    const b = readV6Sprint(cfg, 'n');
    expect(b.stories).toEqual([]);
    expect(b.notices).toEqual([]);
  });
});

describe('unknown status', () => {
  it('lands in backlog with unknownStatus set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-unknown-'));
    try {
      fs.writeFileSync(path.join(dir, 'sprint-status.yaml'), 'development_status:\n  3-1-thing: wibble\n  3-2-other: 7\n');
      const cfg = { ...fx('v6-sprint'), planningArtifacts: path.join(dir, 'none'), implementationArtifacts: dir };
      const [a, b] = readV6Sprint(cfg, 'u').stories;
      expect(a).toMatchObject({ column: 'backlog', rawStatus: 'wibble', unknownStatus: 'wibble' });
      expect(b).toMatchObject({ column: 'backlog', rawStatus: '7', unknownStatus: '7' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('status keys that differ from epic-file keys', () => {
  const cfg = fx('v6-keys');
  const board = readV6Sprint(cfg, 'k');
  const byKey = (k: string) => board.stories.find((s) => s.key === k);

  it('joins on epic/story number and suffix, not the full key', () => {
    expect(board.stories.map((s) => s.key)).toEqual([
      '1-1-users-profile-settings',
      '1-02-logout',
      '1-3-größe-ändern',
      '1-4-data-export',
      '2-1-plant-data-model',
      '2-1-plant-data-model-v2',
      '2-2-watering-schedule',
    ]);
  });

  it('takes the title from the epic file for an apostrophe/ampersand title', () => {
    expect(byKey('1-1-users-profile-settings')).toMatchObject({ id: '1.1', title: "User's profile & settings", column: 'done' });
  });

  it('matches a zero-padded story number', () => {
    expect(byKey('1-02-logout')).toMatchObject({ id: '1.2', title: 'Logout', column: 'review' });
  });

  it('matches a renamed / LLM-written key', () => {
    expect(byKey('1-4-data-export')).toMatchObject({ id: '1.4', title: 'Export data', column: 'ready' });
  });

  it('falls back to full-key matching when two status keys share a prefix', () => {
    expect(byKey('2-1-plant-data-model')).toMatchObject({ title: 'Plant data model', column: 'done' });
    expect(byKey('2-1-plant-data-model-v2')).toMatchObject({ title: '2-1-plant-data-model-v2', column: 'backlog' });
  });

  it('keeps unmatched epic-file stories as backlog', () => {
    expect(byKey('2-2-watering-schedule')).toMatchObject({ id: '2.2', title: 'Watering schedule', column: 'backlog', rawStatus: null });
  });

  it('resolves detail paths for non-ASCII keys', () => {
    expect(v6SprintDetailPath(cfg, '1-3-größe-ändern')).toMatch(/1-3-größe-ändern\.md$/);
    expect(v6SprintDetailPath(cfg, 'a/b')).toBeNull();
    expect(v6SprintDetailPath(cfg, 'a\\b')).toBeNull();
    expect(v6SprintDetailPath(cfg, 'a\0b')).toBeNull();
    expect(v6SprintDetailPath(cfg, '.hidden')).toBeNull();
  });
});

describe('quick-flow specs', () => {
  const cfg = fx('v6-quick');
  const board = readV6Sprint(cfg, 'q');
  const byKey = (k: string) => board.stories.find((s) => s.key === k);

  it('adds spec-*.md files after the sprint stories, in a Quick specs lane', () => {
    expect(board.stories.map((s) => s.key)).toEqual([
      '1-1-user-login',
      '1-2-password-reset',
      'spec-broken',
      'spec-fix-typo',
      'spec-gh-2-by-country-catch-up-job',
    ]);
    expect(board.epics.at(-1)).toEqual({ id: QUICK_EPIC_ID, title: 'Quick specs', quick: true });
    expect(byKey('1-1-user-login')?.quick).toBeUndefined();
  });

  it('reads title, type and status from the frontmatter; a repeated status keeps the last one', () => {
    expect(byKey('spec-gh-2-by-country-catch-up-job')).toEqual({
      key: 'spec-gh-2-by-country-catch-up-job',
      id: 'spec-gh-2-by-country-catch-up-job',
      title: 'GH #2 -- by-country queue and catch-up in their own job (by-country-catch-up)',
      epicId: QUICK_EPIC_ID,
      column: 'in-progress',
      rawStatus: 'in-progress',
      type: 'feature',
      quick: true,
    });
  });

  it('falls back to the first heading for the title', () => {
    expect(byKey('spec-fix-typo')).toMatchObject({ title: 'Fix the typo in the footer', type: 'bug', column: 'done' });
  });

  it('keeps a spec with broken frontmatter in backlog and warns', () => {
    expect(byKey('spec-broken')).toMatchObject({ title: 'spec-broken', column: 'backlog', rawStatus: null });
    expect(board.notices).toEqual([{ level: 'warn', text: expect.stringContaining('spec-broken.md') }]);
  });

  it('opens the spec file as the card detail', () => {
    expect(v6SprintDetailPath(cfg, 'spec-fix-typo')).toMatch(/spec-fix-typo\.md$/);
  });

  it("treats a story's own spec (BMAD 6.12 spec-<epic>-<story>-*.md) as that story's file, not a quick card", () => {
    expect(board.stories.filter((s) => s.id === '1.1' || s.id === '1.2').every((s) => !s.quick)).toBe(true);
    expect(v6SprintDetailPath(cfg, '1-1-user-login')).toMatch(/spec-1-1-user-login\.md$/);
    expect(v6SprintDetailPath(cfg, '1-2-password-reset')).toMatch(/spec-1-2-reset-a-password\.md$/);
    expect(v6SprintDetailPath(cfg, '1-3-not-there')).toBeNull();
  });

  it('shows a board for a project with only quick specs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-quick-'));
    try {
      fs.writeFileSync(path.join(dir, 'spec-one.md'), '---\ntitle: One\nstatus: ready-for-dev\n---\n');
      const only = { ...fx('v6-sprint'), planningArtifacts: path.join(dir, 'none'), implementationArtifacts: dir };
      expect(detectV6Sprint(only)).toBe(true);
      const b = readV6Sprint(only, 'o');
      expect(b.epics).toEqual([{ id: QUICK_EPIC_ID, title: 'Quick specs', quick: true }]);
      expect(b.stories).toMatchObject([{ key: 'spec-one', title: 'One', column: 'ready', quick: true }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds no Quick specs lane without quick specs', () => {
    expect(readV6Sprint(fx('v6-sprint'), 's').epics.some((e) => e.quick)).toBe(false);
  });
});
