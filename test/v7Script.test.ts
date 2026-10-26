import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBmadConfig } from '../src/bmad/config.js';
import { readV7, type RunScript } from '../src/readers/v7Script.js';
import { readV7Tree } from '../src/readers/v7Tree.js';

const root = path.join(import.meta.dirname, 'fixtures', 'v7');
const cfg = loadBmadConfig(root);
const store = path.join(root, 'store');
const checkout = path.join(store, 'initiative-checkout');
const script = path.join(cfg.root, '_bmad', 'method', 'scripts', 'tickets.py');

const row = (o: Record<string, unknown>) => ({
  epic: 'epic-pricing-rules', id: 1, type: 'story', title: 'T', status: '', tracker_status: '', state: 'backlog', ...o,
});
const ok = (doc: unknown): RunScript => async () => ({ code: 0, stdout: JSON.stringify(doc), stderr: '' });
const checkoutDoc = {
  tickets: [
    row({ id: 1, title: 'Pricing function', status: 'built', state: 'review' }),
    row({ id: 2, status: 'ready-for-dev', state: 'backlog' }),
    row({ id: 3, status: '', tracker_status: 'In Progress', state: 'in-progress' }),
    row({ id: 4, status: null, blocked_at: '2026-10-20' }),
  ],
  epics: [{ slug: 'epic-pricing-rules', id: 1 }],
};
const hasReduced = (b: { notices: { text: string }[] }) => b.notices.some((n) => n.text.includes('reduced fidelity'));

describe('readV7 with an injected script runner', () => {
  it('maps rows to columns and calls uv exactly', async () => {
    const calls: unknown[][] = [];
    const run: RunScript = async (...a) => {
      calls.push(a);
      return ok(checkoutDoc)(...a);
    };
    const b = await readV7(cfg, checkout, 'initiative', 's', run);
    expect(calls).toEqual([['uv', ['run', '--no-project', script, 'status', checkout], cfg.root, 10000]]);
    expect(b.stories.map((s) => [s.id, s.column])).toEqual([
      ['1.1', 'review'], ['1.2', 'ready'], ['1.3', 'in-progress'], ['1.4', 'backlog'],
    ]);
    expect(b.stories[0].key).toBe('epic-pricing-rules/1');
    expect(b.stories[3]).toMatchObject({ blocked: true, rawStatus: null });
    expect(b.epics).toEqual([{ id: '1', title: 'Pricing rules' }]);
    expect(hasReduced(b)).toBe(false);
  });

  it('reports a pre-release layout from the migrate hint', async () => {
    const run: RunScript = async () => ({ code: 1, stdout: '', stderr: 'uses the earlier layout; `bmad migrate` moves it' });
    const b = await readV7(cfg, path.join(store, 'initiative-old'), 'initiative', 's', run);
    expect(b).toEqual(readV7Tree(path.join(store, 'initiative-old'), 'pre-release', 's'));
    expect(b.stories).toEqual([]);
    expect(b.notices[0].text).toContain('bmad migrate method');
  });

  it.each<[string, RunScript]>([
    ['exit 2', async () => ({ code: 2, stdout: '', stderr: 'boom' })],
    ['non-JSON', async () => ({ code: 0, stdout: 'hello', stderr: '' })],
    ['ENOENT', async () => { throw Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' }); }],
  ])('falls back to the file reader on %s', async (_n, run) => {
    const b = await readV7(cfg, checkout, 'initiative', 's', run);
    expect(b).toEqual(readV7Tree(checkout, 'initiative', 's'));
    expect(hasReduced(b)).toBe(true);
  });

  it('falls back when tickets.py is missing, without calling run', async () => {
    let called = false;
    const run: RunScript = async () => { called = true; return { code: 0, stdout: '{}', stderr: '' }; };
    const b = await readV7({ ...cfg, root: store }, checkout, 'initiative', 's', run);
    expect(called).toBe(false);
    expect(hasReduced(b)).toBe(true);
  });

  it('passes the folder for backlog and keys rows by file stem', async () => {
    const dir = path.join(store, 'backlog');
    let seen = '';
    const run: RunScript = async (_c, args) => {
      seen = args[args.length - 1];
      return ok({ tickets: [row({ epic: 'backlog', id: null, file: 'bug-checkout-total.md', type: 'bug', status: 'ready-for-dev' })] })(_c, args, '', 0);
    };
    const b = await readV7(cfg, dir, 'backlog', 's', run);
    expect(seen).toBe(dir);
    expect(b.kind).toBe('v7-backlog');
    expect(b.stories[0]).toMatchObject({ key: 'backlog/bug-checkout-total', id: 'bug-checkout-total', column: 'ready', type: 'bug' });
  });

  it('builds parent children as v7:<folder> and does not recurse into parents', async () => {
    const run: RunScript = async (_c, args) =>
      args[args.length - 1].endsWith('initiative-parent')
        ? { code: 0, stdout: JSON.stringify({ initiatives: [{ slug: 'initiative-checkout' }, { slug: 'initiative-parent' }, { slug: 'nope' }] }), stderr: '' }
        : ok(checkoutDoc)(_c, args, '', 0);
    const b = await readV7(cfg, path.join(store, 'initiative-parent'), 'parent', 'p', run);
    expect(b.kind).toBe('v7-parent');
    expect(b.children?.map((c) => c.sourceId)).toEqual(['v7:initiative-checkout']);
    expect(b.notices.filter((n) => n.level === 'warn')).toHaveLength(2);
  });
});

const hasUv = (() => {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('readV7 with the real tickets.py', () => {
  it.skipIf(!hasUv)('matches the file reader columns', async () => {
    const real = await readV7(cfg, checkout, 'initiative', 's');
    const files = readV7Tree(checkout, 'initiative', 's');
    expect(hasReduced(real)).toBe(false);
    for (const id of ['1.1', '1.2', '1.4']) {
      const a = real.stories.find((s) => s.id === id);
      expect(a).toBeDefined();
      expect(a).toMatchObject({ column: files.stories.find((s) => s.id === id)?.column, key: files.stories.find((s) => s.id === id)?.key });
    }
    expect(real.epics.map((e) => e.id)).toEqual(files.epics.map((e) => e.id));
  }, 30000);
});
