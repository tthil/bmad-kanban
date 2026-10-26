import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStoryDetail, listSources, readBoard, UnknownSourceError, UnknownStoryError } from '../src/readers/detect.js';

const boom = vi.hoisted(() => ({ on: false }));
vi.mock('../src/readers/v6Sprint.js', async (orig) => {
  const m = await orig<typeof import('../src/readers/v6Sprint.js')>();
  return {
    ...m,
    readV6Sprint: (...a: Parameters<typeof m.readV6Sprint>) => {
      if (boom.on) throw new Error('kaboom');
      return m.readV6Sprint(...a);
    },
  };
});

const fx = (n: string) => path.join(import.meta.dirname, 'fixtures', n);
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const copy = (n: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-'));
  tmps.push(d);
  fs.cpSync(fx(n), d, { recursive: true });
  return d;
};

describe('listSources', () => {
  it('lists the v6 sprint source', async () => {
    const r = await listSources(fx('v6-sprint'));
    expect(r.sources.map((s) => [s.id, s.kind, s.label, s.count])).toEqual([['v6-sprint', 'v6-sprint', 'v6 sprint', 4]]);
    expect(r.tags).toEqual(['v6']);
    expect(r.defaultSourceId).toBe('v6-sprint');
    expect(r.version).toBe('6.12.4');
  });

  it('lists a v6 spec by its SPEC.md heading', async () => {
    const r = await listSources(fx('v6-spec'));
    expect(r.sources.map((s) => s.id)).toContain('v6-spec:spec-checkout');
    expect(r.sources.find((s) => s.id === 'v6-spec:spec-checkout')?.label).not.toBe('spec-checkout');
  });

  it('nests child initiatives under their parent only', async () => {
    const r = await listSources(fx('v7'));
    expect(r.sources.map((s) => s.id)).toEqual(['v7:initiative-old', 'v7:initiative-parent', 'v7-backlog']);
    const parent = r.sources[1];
    expect(parent.kind).toBe('v7-parent');
    expect(parent.children?.map((c) => c.id)).toEqual(['v7:initiative-checkout', 'v7:initiative-flat']);
    expect(parent.count).toBe(parent.children!.reduce((n, c) => n + c.count, 0));
    expect(r.sources[2].label).toBe('Backlog');
    expect(r.defaultSourceId).toBe('v7:initiative-checkout');
    expect(r.tags).toEqual(['v7']);
  });

  it('finds both kinds in a mixed project and defaults to the active initiative', async () => {
    const r = await listSources(fx('mixed'));
    expect(r.tags).toEqual(['v6', 'v7']);
    expect(r.sources.map((s) => s.id)).toEqual(['v6-sprint', 'v7:initiative-a']);
    expect(r.defaultSourceId).toBe('v7:initiative-a');
  });

  it('excludes dropped stories from counts', async () => {
    const d = copy('mixed');
    expect((await listSources(d)).sources.find((x) => x.id === 'v7:initiative-a')?.count).toBe(1);
    const plan = path.join(d, '_bmad-output/initiative-a/tickets/story-only-story-plan.md');
    fs.writeFileSync(plan, fs.readFileSync(plan, 'utf8').replace('status: in-progress', 'status: dropped'));
    expect((await listSources(d)).sources.find((x) => x.id === 'v7:initiative-a')?.count).toBe(0);
  });

  it('reports a config parse error instead of throwing', async () => {
    const d = copy('v6-sprint');
    fs.writeFileSync(path.join(d, '_bmad/config.toml'), 'this = = bad');
    const r = await listSources(d);
    expect(r).toMatchObject({ sources: [], defaultSourceId: null, tags: [], version: null });
    expect(r.error).toBeTruthy();
  });
});

describe('readBoard', () => {
  it('reads each source kind, including a child initiative', async () => {
    expect((await readBoard(fx('v6-sprint'), 'v6-sprint')).kind).toBe('v6-sprint');
    expect((await readBoard(fx('v7'), 'v7:initiative-parent')).children).toHaveLength(2);
    const child = await readBoard(fx('v7'), 'v7:initiative-checkout');
    expect(child.sourceId).toBe('v7:initiative-checkout');
    expect(child.stories.length).toBeGreaterThan(0);
    expect((await readBoard(fx('v7'), 'v7-backlog')).kind).toBe('v7-backlog');
  });

  it('throws UnknownSourceError for unknown ids', async () => {
    await expect(readBoard(fx('v6-sprint'), 'v7:nope')).rejects.toBeInstanceOf(UnknownSourceError);
    await expect(readBoard(fx('v6-sprint'), 'bogus')).rejects.toBeInstanceOf(UnknownSourceError);
  });

  it('turns a reader fault into an error notice', async () => {
    boom.on = true;
    try {
      const b = await readBoard(fx('v6-sprint'), 'v6-sprint');
      expect(b).toMatchObject({ sourceId: 'v6-sprint', kind: 'v6-sprint', label: 'v6 sprint', stories: [] });
      expect(b.notices).toEqual([{ level: 'error', text: expect.stringContaining('kaboom') }]);
    } finally {
      boom.on = false;
    }
  });
});

describe('getStoryDetail', () => {
  it('returns the story file for v6', async () => {
    const d = await getStoryDetail(fx('v6-sprint'), 'v6-sprint', '1-1-user-login');
    expect(d.path).toBe(path.join(fx('v6-sprint'), '_bmad-output/implementation-artifacts/1-1-user-login.md'));
    expect(d.markdown).toBe(fs.readFileSync(d.path!, 'utf8'));
  });

  it('falls back to the v7 entry text when there is no file', async () => {
    const d = await getStoryDetail(fx('v7'), 'v7:initiative-checkout', 'epic-pricing-rules/3');
    expect(d.path).toBeNull();
    expect(d.markdown).toContain('rounding per line');
  });

  it('returns an empty detail without a path for a known story that has no file yet', async () => {
    expect(await getStoryDetail(fx('v6-sprint'), 'v6-sprint', '1-2-password-reset')).toEqual({ path: null, markdown: '' });
    expect(await getStoryDetail(fx('v6-keys'), 'v6-sprint', '2-2-watering-schedule')).toEqual({ path: null, markdown: '' });
    expect(await getStoryDetail(fx('v6-spec'), 'v6-spec:spec-checkout', '3')).toEqual({ path: null, markdown: '' });
  });

  it('opens a story file with a non-ASCII key', async () => {
    const d = await getStoryDetail(fx('v6-keys'), 'v6-sprint', '1-3-größe-ändern');
    expect(d.path).toMatch(/1-3-größe-ändern\.md$/);
    expect(d.markdown).toContain('# Größe ändern');
  });

  it('throws for unknown stories and sources', async () => {
    await expect(getStoryDetail(fx('v7'), 'v7:initiative-flat', 'initiative-flat/99')).rejects.toBeInstanceOf(UnknownStoryError);
    await expect(getStoryDetail(fx('v6-sprint'), 'v6-sprint', '../x')).rejects.toBeInstanceOf(UnknownStoryError);
    await expect(getStoryDetail(fx('v6-sprint'), 'nope', 'x')).rejects.toBeInstanceOf(UnknownSourceError);
    await expect(getStoryDetail(fx('v6-sprint'), 'v6-sprint', '9-9-not-on-board')).rejects.toBeInstanceOf(UnknownStoryError);
    await expect(getStoryDetail(fx('v6-spec'), 'v6-spec:spec-checkout', '99')).rejects.toBeInstanceOf(UnknownStoryError);
  });

  it('refuses a file whose real path leaves the project root', async () => {
    const d = copy('v6-sprint');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    tmps.push(outside);
    fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
    const link = path.join(d, '_bmad-output/implementation-artifacts/9-9-leak.md');
    fs.symlinkSync(path.join(outside, 'secret.md'), link);
    await expect(getStoryDetail(d, 'v6-sprint', '9-9-leak')).rejects.toBeInstanceOf(UnknownStoryError);
  });
});
