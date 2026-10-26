import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBmadConfig } from '../src/bmad/config.js';
import { detectV6Sprint, readV6Sprint, v6SprintDetailPath } from '../src/readers/v6Sprint.js';

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
