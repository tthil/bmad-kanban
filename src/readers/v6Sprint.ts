import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { BmadConfig } from '../bmad/config.js';
import type { Board, Epic, Notice, Story } from '../model.js';
import { mapStatus } from '../status.js';

// Heading patterns and kebab rule mirror BMAD 6.12 sprint_plan.py.
const EPIC_RE = /^#{1,3}\s*Epic\s+(\d+)\s*:?\s*(.*?)\s*#*\s*$/i;
const STORY_RE = /^#{2,4}\s*Story\s+(\d+)\.(\d+)([a-z]?)\s*:?\s*(.*?)\s*#*\s*$/i;
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;
const EPIC_KEY_RE = /^epic-(\d+)$/;
const RETRO_KEY_RE = /^epic-(\d+)-retrospective$/;
const STORY_KEY_RE = /^(\d+)-(\d+)([a-z]?)-.+/i;

const STATUS_FILE = 'sprint-status.yaml';

function slug(text: string): string {
  let s = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_]+/gu, '-').replace(/^-+|-+$/g, '');
  s = s.slice(0, 60).replace(/^-+|-+$/g, '');
  return s || createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

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

function mdFiles(dir: string, filter: (name: string) => boolean): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && filter(e.name))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

function epicFiles(cfg: BmadConfig): string[] {
  const dir = cfg.planningArtifacts;
  const single = path.join(dir, 'epics.md');
  return [
    ...(isFile(single) ? [single] : []),
    ...mdFiles(dir, (n) => /^epic-.*\.md$/.test(n)),
    ...mdFiles(path.join(dir, 'epics'), () => true),
  ];
}

export function detectV6Sprint(cfg: BmadConfig): boolean {
  return isFile(path.join(cfg.implementationArtifacts, STATUS_FILE)) || epicFiles(cfg).length > 0;
}

interface PlannedStory { key: string; epic: string; num: number; suffix: string; title: string }

function parseEpicFiles(files: string[]): { epics: Map<string, string>; stories: PlannedStory[] } {
  const epics = new Map<string, string>();
  const stories: PlannedStory[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    let inFence = false;
    for (const line of text.split(/\r?\n/)) {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const e = EPIC_RE.exec(line);
      if (e) {
        const id = String(Number(e[1]));
        if (!epics.has(id) || epics.get(id) === '') epics.set(id, e[2]);
        continue;
      }
      const s = STORY_RE.exec(line);
      if (s) {
        const epic = String(Number(s[1]));
        const num = Number(s[2]);
        const suffix = s[3].toLowerCase();
        const key = `${epic}-${num}${suffix}-${slug(s[4])}`;
        if (!epics.has(epic)) epics.set(epic, '');
        if (seen.has(key)) continue;
        seen.add(key);
        stories.push({ key, epic, num, suffix, title: s[4] });
      }
    }
  }
  return { epics, stories };
}

function readStatusMap(cfg: BmadConfig, notices: Notice[]): [string, unknown][] {
  const file = path.join(cfg.implementationArtifacts, STATUS_FILE);
  const text = readText(file);
  if (text === null) return [];
  try {
    const doc = parseYaml(text) as { development_status?: unknown } | null;
    const ds = doc?.development_status;
    if (typeof ds === 'object' && ds !== null && !Array.isArray(ds)) return Object.entries(ds);
    notices.push({ level: 'warn', text: `${STATUS_FILE} has no development_status map` });
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    notices.push({ level: 'error', text: `Could not parse ${STATUS_FILE}: ${msg}` });
  }
  return [];
}

const prefixOf = (epic: string, num: string, suffix: string): string =>
  `${Number(epic)}-${Number(num)}${suffix.toLowerCase()}`;

const rawOf = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function readV6Sprint(cfg: BmadConfig, sourceId: string): Board {
  const notices: Notice[] = [];
  const planned = parseEpicFiles(epicFiles(cfg));
  const epicMap = new Map<string, Epic>();
  for (const [id, title] of planned.epics) epicMap.set(id, { id, title: title || `Epic ${id}` });
  const ensureEpic = (id: string): Epic => {
    let e = epicMap.get(id);
    if (!e) {
      e = { id, title: `Epic ${id}` };
      epicMap.set(id, e);
    }
    return e;
  };

  const stories: Story[] = [];
  const have = new Set<string>();
  const addStory = (key: string, epic: string, num: number, suffix: string, title: string, raw: string | null) => {
    const m = mapStatus('v6-sprint', raw);
    const story: Story = {
      key,
      id: `${epic}.${num}${suffix}`,
      title,
      epicId: epic,
      column: m.column,
      rawStatus: raw,
    };
    if (m.unknownStatus !== undefined) story.unknownStatus = m.unknownStatus;
    stories.push(story);
    have.add(key);
  };

  // Join status keys to epic-file stories on (epic, story number, suffix): keys are often renamed,
  // zero-padded or slugged differently. Only when two status keys share that prefix is the full key used.
  const statusRows = readStatusMap(cfg, notices);
  const prefixCount = new Map<string, number>();
  for (const [key] of statusRows) {
    const m = STORY_KEY_RE.exec(key);
    if (m) {
      const p = prefixOf(m[1]!, m[2]!, m[3]!);
      prefixCount.set(p, (prefixCount.get(p) ?? 0) + 1);
    }
  }
  const matched = new Set<PlannedStory>();
  const findPlanned = (key: string, prefix: string): PlannedStory | undefined => {
    const free = planned.stories.filter((s) => !matched.has(s));
    const exact = free.find((s) => s.key === key);
    if (exact || (prefixCount.get(prefix) ?? 0) > 1) return exact;
    return free.find((s) => prefixOf(s.epic, String(s.num), s.suffix) === prefix);
  };

  for (const [key, value] of statusRows) {
    const raw = rawOf(value);
    let m: RegExpExecArray | null;
    if ((m = RETRO_KEY_RE.exec(key))) {
      const e = ensureEpic(String(Number(m[1])));
      if (raw === 'optional' || raw === 'done') e.retrospective = raw;
    } else if ((m = EPIC_KEY_RE.exec(key))) {
      const e = ensureEpic(String(Number(m[1])));
      if (raw !== null) e.status = raw;
    } else if ((m = STORY_KEY_RE.exec(key))) {
      const epic = String(Number(m[1]));
      ensureEpic(epic);
      const hit = findPlanned(key, prefixOf(m[1]!, m[2]!, m[3]!));
      if (hit) matched.add(hit);
      addStory(key, epic, Number(m[2]), m[3]!.toLowerCase(), hit?.title ?? key, raw);
    }
  }

  for (const s of planned.stories) {
    if (!matched.has(s) && !have.has(s.key)) addStory(s.key, s.epic, s.num, s.suffix, s.title, null);
  }

  return { sourceId, kind: 'v6-sprint', label: 'v6 sprint', epics: [...epicMap.values()], stories, notices };
}

export function v6SprintDetailPath(cfg: BmadConfig, storyKey: string): string | null {
  // Unicode slugs are valid keys; containment is re-checked against the real path by the caller.
  if (storyKey === '' || storyKey.startsWith('.') || /[/\\\0]/.test(storyKey)) return null;
  const file = path.join(cfg.implementationArtifacts, `${storyKey}.md`);
  return isFile(file) ? file : null;
}
