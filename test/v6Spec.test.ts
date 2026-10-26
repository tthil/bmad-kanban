import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBmadConfig } from '../src/bmad/config.js';
import { findSpecFolders, readV6Spec, v6SpecDetailPath } from '../src/readers/v6Spec.js';

const root = path.join(import.meta.dirname, 'fixtures', 'v6-spec');
const cfg = loadBmadConfig(root);
const checkout = path.join(root, '_bmad-output', 'specs', 'spec-checkout');

describe('findSpecFolders', () => {
  it('finds spec folders with stories.yaml, sorted', () => {
    expect(findSpecFolders(cfg)).toEqual([path.join(root, '_bmad-output', 'specs', 'spec-broken'), checkout]);
  });

  it('skips spec folders without stories.yaml and de-duplicates', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-'));
    fs.mkdirSync(path.join(tmp, 'specs', 'spec-a'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'specs', 'spec-b'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'specs', 'spec-a', 'stories.yaml'), '[]');
    const c = { ...cfg, outputFolder: tmp, planningArtifacts: tmp, implementationArtifacts: path.join(tmp, 'specs') };
    expect(findSpecFolders(c)).toEqual([path.join(tmp, 'specs', 'spec-a')]);
    fs.rmSync(tmp, { recursive: true });
  });
});

describe('readV6Spec', () => {
  const board = readV6Spec(checkout, 'src1');

  it('reports kind, label, and a single epic', () => {
    expect(board.kind).toBe('v6-spec');
    expect(board.label).toBe('Checkout');
    expect(board.sourceId).toBe('src1');
    expect(board.epics).toEqual([{ id: 'spec-checkout', title: 'Checkout' }]);
    expect(board.notices).toEqual([]);
  });

  it('maps stories in list order from story-file frontmatter', () => {
    expect(board.stories.map((s) => [s.key, s.id, s.column, s.epicId])).toEqual([
      ['1', '1', 'in-progress', 'spec-checkout'],
      ['2', '2', 'done', 'spec-checkout'],
      ['3', '3', 'backlog', 'spec-checkout'],
    ]);
    expect(board.stories[0].title).toBe('Add to cart');
  });

  it('resolves detail paths and rejects unsafe keys', () => {
    expect(v6SpecDetailPath(checkout, '1')?.endsWith(path.join('stories', '1-add-to-cart.md'))).toBe(true);
    expect(v6SpecDetailPath(checkout, '3')).toBeNull();
    expect(v6SpecDetailPath(checkout, '../x')).toBeNull();
    expect(v6SpecDetailPath(checkout, '.hidden')).toBeNull();
    expect(v6SpecDetailPath(checkout, 'a/b')).toBeNull();
  });

  it('returns an error notice for a broken stories.yaml', () => {
    const b = readV6Spec(path.join(root, '_bmad-output', 'specs', 'spec-broken'), 's');
    expect(b.stories).toEqual([]);
    expect(b.notices).toHaveLength(1);
    expect(b.notices[0].level).toBe('error');
    expect(b.label).toBe('spec-broken');
  });

  it('matches story files by "<id>-" prefix only and tolerates bad frontmatter', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-'));
    const dir = path.join(tmp, 'spec-x');
    fs.mkdirSync(path.join(dir, 'stories'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'stories.yaml'), '- id: 1\n  title: One\n- id: "2"\n  title: Two\n');
    fs.writeFileSync(path.join(dir, 'stories', '10-x.md'), '---\nstatus: done\n---\n');
    fs.writeFileSync(path.join(dir, 'stories', '2-two.md'), '---\nstatus: [\n---\n');
    const b = readV6Spec(dir, 's');
    expect(b.stories.map((s) => [s.key, s.column])).toEqual([['1', 'backlog'], ['2', 'backlog']]);
    expect(b.notices).toHaveLength(1);
    expect(b.notices[0].level).toBe('warn');
    expect(b.notices[0].text).toContain('2-two.md');
    expect(v6SpecDetailPath(dir, '1')).toBeNull();
    fs.rmSync(tmp, { recursive: true });
  });
});
