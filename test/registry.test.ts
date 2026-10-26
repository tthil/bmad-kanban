import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotABmadProjectError, Registry } from '../src/registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'v6-sprint');

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-kanban-reg-'));
  file = path.join(tmp, 'cfg', 'projects.json');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Registry', () => {
  it('stores the project root, not the subfolder, and dedupes', () => {
    const reg = new Registry(file);
    const sub = path.join(fixture, '_bmad-output', 'implementation-artifacts');
    const p = reg.add(sub);
    expect(p.path).toBe(fixture);
    expect(p.name).toBe('v6-sprint');
    expect(p.id).toMatch(/^[0-9a-f]{12}$/);
    reg.add(fixture);
    expect(reg.list()).toHaveLength(1);
  });

  it('rejects non-BMAD and missing paths', () => {
    const reg = new Registry(file);
    expect(() => reg.add(tmp)).toThrow(NotABmadProjectError);
    expect(() => reg.add(path.join(tmp, 'nope'))).toThrow(NotABmadProjectError);
  });

  it('defaults prefs and persists them with lastViewed', () => {
    const reg = new Registry(file);
    const p = reg.add(fixture);
    expect(p.prefs).toEqual({ view: 'columns', showDropped: false, sourceId: null });
    reg.setPref(p.id, { view: 'swimlanes', showDropped: true });
    reg.setLastViewed(p.id);
    const again = new Registry(file);
    expect(again.get(p.id)?.prefs).toEqual({ view: 'swimlanes', showDropped: true, sourceId: null });
    expect(again.lastViewed).toBe(p.id);
  });

  it('remove clears lastViewed and ignores unknown ids', () => {
    const reg = new Registry(file);
    const p = reg.add(fixture);
    reg.setLastViewed(p.id);
    reg.remove('unknown');
    reg.setPref('unknown', { view: 'swimlanes' });
    reg.setLastViewed('unknown');
    expect(reg.lastViewed).toBe(p.id);
    reg.remove(p.id);
    expect(reg.list()).toEqual([]);
    expect(reg.lastViewed).toBeNull();
    expect(new Registry(file).list()).toEqual([]);
  });

  it('returns copies', () => {
    const reg = new Registry(file);
    const p = reg.add(fixture);
    p.prefs.view = 'swimlanes';
    reg.get(p.id)!.prefs.showDropped = true;
    expect(reg.get(p.id)?.prefs).toEqual({ view: 'columns', showDropped: false, sourceId: null });
  });

  it('moves a corrupt file to .bak and starts empty', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const reg = new Registry(file);
    expect(reg.list()).toEqual([]);
    expect(fs.existsSync(file + '.bak')).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('does not create the directory on read, and writes atomically', () => {
    const reg = new Registry(file);
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    reg.add(fixture);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(1);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['projects.json']);
  });
});
