import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';
import { findProjectRoot } from './bmad/config.js';

export interface ProjectPrefs {
  view: 'columns' | 'swimlanes';
  showDropped: boolean;
  sourceId: string | null;
}

export interface RegisteredProject {
  id: string;
  path: string;
  name: string;
  prefs: ProjectPrefs;
}

export class NotABmadProjectError extends Error {
  constructor(public readonly requested: string) {
    super(`Not a BMAD project (no _bmad folder found at or above): ${requested}`);
    this.name = 'NotABmadProjectError';
  }
}

export function configDir(): string {
  return process.env.BMAD_KANBAN_CONFIG_DIR || envPaths('bmad-kanban', { suffix: '' }).config;
}

const defaultPrefs = (): ProjectPrefs => ({ view: 'columns', showDropped: false, sourceId: null });
const copy = (p: RegisteredProject): RegisteredProject => ({ ...p, prefs: { ...p.prefs } });

export class Registry {
  private projects: RegisteredProject[] = [];
  lastViewed: string | null = null;

  constructor(private readonly file: string = path.join(configDir(), 'projects.json')) {
    this.load();
  }

  list(): RegisteredProject[] {
    return this.projects.map(copy);
  }

  get(id: string): RegisteredProject | undefined {
    const p = this.projects.find((x) => x.id === id);
    return p && copy(p);
  }

  add(input: string): RegisteredProject {
    const resolved = path.resolve(input);
    const root = fs.existsSync(resolved) ? findProjectRoot(resolved) : null;
    if (!root) throw new NotABmadProjectError(resolved);
    const id = createHash('sha1').update(root).digest('hex').slice(0, 12);
    let p = this.projects.find((x) => x.id === id);
    if (!p) {
      p = { id, path: root, name: path.basename(root), prefs: defaultPrefs() };
      this.projects.push(p);
      this.save();
    }
    return copy(p);
  }

  remove(id: string): void {
    const before = this.projects.length;
    this.projects = this.projects.filter((x) => x.id !== id);
    if (this.projects.length === before) return;
    if (this.lastViewed === id) this.lastViewed = null;
    this.save();
  }

  setPref(id: string, pref: Partial<ProjectPrefs>): void {
    const p = this.projects.find((x) => x.id === id);
    if (!p) return;
    p.prefs = { ...p.prefs, ...pref };
    this.save();
  }

  setLastViewed(id: string): void {
    if (!this.projects.some((x) => x.id === id)) return;
    this.lastViewed = id;
    this.save();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    try {
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.projects)) throw new Error('bad shape');
      this.projects = data.projects.map((p: RegisteredProject) => ({
        id: p.id,
        path: p.path,
        name: p.name,
        prefs: { ...defaultPrefs(), ...p.prefs },
      }));
      this.lastViewed = typeof data.lastViewed === 'string' ? data.lastViewed : null;
    } catch {
      this.projects = [];
      this.lastViewed = null;
      try {
        fs.renameSync(this.file, this.file + '.bak');
      } catch {
        // best effort
      }
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, projects: this.projects, lastViewed: this.lastViewed }, null, 2),
    );
    fs.renameSync(tmp, this.file);
  }
}
