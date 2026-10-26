import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { BmadConfig } from '../bmad/config.js';
import { FrontmatterError, readFrontmatter } from '../bmad/frontmatter.js';
import type { Board, Notice, Story } from '../model.js';
import { mapStatus } from '../status.js';

const STORIES_FILE = 'stories.yaml';

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function specDirsIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('spec-'))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

export function findSpecFolders(cfg: BmadConfig): string[] {
  const roots = [path.join(cfg.outputFolder, 'specs'), cfg.planningArtifacts, cfg.implementationArtifacts];
  const found = new Set<string>();
  for (const r of roots) {
    for (const d of specDirsIn(r)) if (isFile(path.join(d, STORIES_FILE))) found.add(path.resolve(d));
  }
  return [...found].sort();
}

function storyFile(folder: string, id: string): string | null {
  const dir = path.join(folder, 'stories');
  try {
    const names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name.startsWith(`${id}-`))
      .map((e) => e.name)
      .sort();
    return names.length > 0 ? path.join(dir, names[0]) : null;
  } catch {
    return null;
  }
}

function firstHeading(text: string | null): string | null {
  if (text === null) return null;
  const m = /^# +(.+?)\s*#*\s*$/m.exec(text);
  return m ? m[1] : null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function readV6Spec(folder: string, sourceId: string): Board {
  const notices: Notice[] = [];
  const name = path.basename(folder);
  const label = firstHeading(readText(path.join(folder, 'SPEC.md'))) ?? name;
  const stories: Story[] = [];
  const board = (): Board => ({
    sourceId,
    kind: 'v6-spec',
    label,
    epics: [{ id: name, title: label }],
    stories,
    notices,
  });

  const text = readText(path.join(folder, STORIES_FILE));
  if (text === null) {
    notices.push({ level: 'error', text: `Could not read ${STORIES_FILE} in ${name}` });
    return board();
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    notices.push({ level: 'error', text: `Could not parse ${STORIES_FILE} in ${name}: ${msg}` });
    return board();
  }
  if (doc === null || doc === undefined) return board();
  if (!Array.isArray(doc)) {
    notices.push({ level: 'error', text: `${STORIES_FILE} in ${name} is not a list` });
    return board();
  }

  const seen = new Set<string>();
  for (const entry of doc) {
    if (!isObj(entry) || entry.id === null || entry.id === undefined || String(entry.id) === '') {
      notices.push({ level: 'warn', text: `Skipped an entry without an id in ${STORIES_FILE} (${name})` });
      continue;
    }
    const id = String(entry.id);
    if (seen.has(id)) {
      notices.push({ level: 'warn', text: `Duplicate story id ${id} in ${STORIES_FILE} (${name})` });
      continue;
    }
    seen.add(id);

    let raw: string | null = null;
    const file = storyFile(folder, id);
    if (file !== null) {
      try {
        const status = readFrontmatter(readText(file) ?? '').data.status;
        raw = status === null || status === undefined ? null : String(status);
      } catch (err) {
        if (!(err instanceof FrontmatterError)) throw err;
        notices.push({ level: 'warn', text: `${path.basename(file)}: ${err.message}` });
      }
    }
    const m = mapStatus('v6-spec', raw);
    const story: Story = {
      key: id,
      id,
      title: entry.title === null || entry.title === undefined ? id : String(entry.title),
      epicId: name,
      column: m.column,
      rawStatus: raw,
    };
    if (m.unknownStatus !== undefined) story.unknownStatus = m.unknownStatus;
    stories.push(story);
  }
  return board();
}

export function v6SpecDetailPath(folder: string, storyKey: string): string | null {
  if (storyKey === '' || storyKey.includes('/') || storyKey.includes('\\') || storyKey.startsWith('.')) return null;
  return storyFile(folder, storyKey);
}
