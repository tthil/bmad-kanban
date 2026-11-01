import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBmadConfig } from '../src/bmad/config.js';
import { addDoneTimes, clearDoneCache, frontmatterLine, gitStats, sprintLine } from '../src/git/doneAt.js';
import type { Board, Story } from '../src/model.js';
import { readBoard } from '../src/readers/detect.js';
import { watchProject } from '../src/server/watch.js';

const fx = (n: string) => path.join(import.meta.dirname, 'fixtures', n);
const tmps: string[] = [];
beforeEach(() => clearDoneCache());
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A copy of a fixture in a temp folder (not a repo yet). */
const copy = (n: string): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doneat-')));
  tmps.push(d);
  fs.cpSync(fx(n), d, { recursive: true });
  return d;
};

const gitEnv = (date?: string): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
});
const git = (dir: string, args: string[], date?: string): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    env: gitEnv(date),
    encoding: 'utf8',
  });
const init = (dir: string) => git(dir, ['init', '-q', '-b', 'main']);
const commit = (dir: string, date: string, paths: string[] = ['-A']) => {
  git(dir, ['add', ...paths]);
  git(dir, ['commit', '-q', '-m', `at ${date}`], date);
};

const hasUv = (() => {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const C1 = '2026-10-20T09:00:00Z';
const C2 = '2026-10-24T12:30:00Z';
const C3 = '2026-10-28T14:05:00Z';

const SPRINT = '_bmad-output/implementation-artifacts/sprint-status.yaml';
const setSprint = (dir: string, from: RegExp, to: string) => {
  const f = path.join(dir, SPRINT);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(from, to));
};

const story = (b: Board, key: string): Story => {
  const s = b.stories.find((x) => x.key === key);
  if (!s) throw new Error(`no story ${key}`);
  return s;
};
const fields = (s: Story) => ({ doneAt: s.doneAt, doneUncommitted: s.doneUncommitted });

describe('line matchers', () => {
  it('matches a sprint key line, quoted or with a comment, for that key only', () => {
    const m = sprintLine('1-1-user-login');
    expect(m('  1-1-user-login: done')).toBe(true);
    expect(m("  '1-1-user-login': 'done'")).toBe(true);
    expect(m('  "1-1-user-login": "done"   # shipped')).toBe(true);
    expect(m('  1-10-user-login: done')).toBe(false);
    expect(m('  1-1-user-login: review')).toBe(false);
    expect(m('  1-1-user-login-x: done')).toBe(false);
    expect(m('  x1-1-user-login: done')).toBe(false);
    expect(m('  1-1-user-login: Done')).toBe(true);
    expect(m("  1-1-user-login: 'done\"")).toBe(false);
  });
  it('matches a top-level frontmatter status line, case-sensitively', () => {
    expect(frontmatterLine('status: done')).toBe(true);
    expect(frontmatterLine("status: 'done'")).toBe(true);
    expect(frontmatterLine('Status: done')).toBe(false);
    expect(frontmatterLine('  status: done')).toBe(false);
    expect(frontmatterLine('status: done-ish')).toBe(false);
    expect(frontmatterLine('status: done  # shipped')).toBe(true);
    expect(frontmatterLine('status: "DONE"')).toBe(true);
    expect(frontmatterLine(`status: 'done"`)).toBe(false);
  });
});

describe('done times from git history', () => {
  it('committed done: the commit date, and nothing on other columns', async () => {
    const d = copy('v6-sprint');
    init(d);
    commit(d, C3);
    const b = await readBoard(d, 'v6-sprint');
    expect(fields(story(b, '1-1-user-login'))).toEqual({ doneAt: C3, doneUncommitted: undefined });
    for (const s of b.stories.filter((x) => x.key !== '1-1-user-login')) expect(fields(s)).toEqual({ doneAt: undefined, doneUncommitted: undefined });
  });

  it('reopened then done again: the latest done commit', async () => {
    const d = copy('v6-sprint');
    init(d);
    commit(d, C1);
    setSprint(d, /1-1-user-login: done/, '1-1-user-login: review');
    commit(d, C2);
    setSprint(d, /1-1-user-login: review/, '1-1-user-login: done');
    commit(d, C3);
    expect(story(await readBoard(d, 'v6-sprint'), '1-1-user-login').doneAt).toBe(C3);
  });

  it('a commit that only reformats or moves a done line keeps the earlier date', async () => {
    const d = copy('v6-sprint');
    init(d);
    commit(d, C1);
    setSprint(d, /  1-1-user-login: done\n/, '');
    setSprint(d, /  epic-1-retrospective: optional\n/, "  epic-1-retrospective: optional\n  '1-1-user-login': done  # moved\n");
    commit(d, C2);
    expect(story(await readBoard(d, 'v6-sprint'), '1-1-user-login').doneAt).toBe(C1);
  });

  it('frontmatter status with a trailing comment counts as committed', async () => {
    const d = copy('v6-quick');
    const spec = path.join(d, '_bmad-output/implementation-artifacts/spec-fix-typo.md');
    fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace('status: done', 'status: done  # x'));
    init(d);
    commit(d, C2);
    expect(fields(story(await readBoard(d, 'v6-sprint'), 'spec-fix-typo'))).toEqual({ doneAt: C2, doneUncommitted: undefined });
  });

  it('a status written as Done gets a time', async () => {
    const d = copy('v6-sprint');
    setSprint(d, /1-1-user-login: done/, '1-1-user-login: Done');
    init(d);
    commit(d, C3);
    const s = story(await readBoard(d, 'v6-sprint'), '1-1-user-login');
    expect(s.rawStatus).toBe('Done');
    expect(s.doneAt).toBe(C3);
  });

  it('a repo with no commits yet: not committed', async () => {
    const d = copy('v6-sprint');
    init(d);
    expect(fields(story(await readBoard(d, 'v6-sprint'), '1-1-user-login'))).toEqual({ doneAt: undefined, doneUncommitted: true });
  });

  it('done only in the worktree: not committed', async () => {
    const d = copy('v6-sprint');
    setSprint(d, /1-1-user-login: done/, '1-1-user-login: review');
    init(d);
    commit(d, C1);
    setSprint(d, /1-1-user-login: review/, '1-1-user-login: done');
    expect(fields(story(await readBoard(d, 'v6-sprint'), '1-1-user-login'))).toEqual({ doneAt: undefined, doneUncommitted: true });
  });

  it('new untracked quick spec marked done: not committed', async () => {
    const d = copy('v6-quick');
    const spec = path.join(d, '_bmad-output/implementation-artifacts/spec-fix-typo.md');
    const text = fs.readFileSync(spec, 'utf8');
    fs.rmSync(spec);
    init(d);
    commit(d, C1);
    fs.writeFileSync(spec, text);
    const b = await readBoard(d, 'v6-sprint');
    expect(fields(story(b, 'spec-fix-typo'))).toEqual({ doneAt: undefined, doneUncommitted: true });
    expect(story(b, '1-1-user-login').doneAt).toBe(C1);
  });

  it('committed quick spec: the commit date', async () => {
    const d = copy('v6-quick');
    init(d);
    commit(d, C2);
    expect(story(await readBoard(d, 'v6-sprint'), 'spec-fix-typo').doneAt).toBe(C2);
  });

  it('ignored file: no field', async () => {
    const d = copy('v6-sprint');
    fs.writeFileSync(path.join(d, '.gitignore'), '_bmad-output/\n');
    init(d);
    commit(d, C1);
    expect(fields(story(await readBoard(d, 'v6-sprint'), '1-1-user-login'))).toEqual({ doneAt: undefined, doneUncommitted: undefined });
  });

  it('renamed file (v6 spec): still found', async () => {
    const d = copy('v6-spec');
    init(d);
    commit(d, C1);
    const dir = '_bmad-output/specs/spec-checkout/stories';
    git(d, ['mv', `${dir}/2-apply-discount.md`, `${dir}/2-discount-codes.md`]);
    commit(d, C3);
    const b = await readBoard(d, 'v6-spec:spec-checkout');
    expect(story(b, '2').doneAt).toBe(C1);
    expect(fields(story(b, '1'))).toEqual({ doneAt: undefined, doneUncommitted: undefined });
  });

  it('not a repo, or no git: no fields', async () => {
    const d = copy('v6-sprint');
    expect(fields(story(await readBoard(d, 'v6-sprint'), '1-1-user-login'))).toEqual({ doneAt: undefined, doneUncommitted: undefined });
    init(d);
    commit(d, C1);
    vi.stubEnv('PATH', '');
    const b = await readBoard(d, 'v6-sprint');
    expect(b.notices.filter((n) => n.level === 'error')).toEqual([]);
    expect(fields(story(b, '1-1-user-login'))).toEqual({ doneAt: undefined, doneUncommitted: undefined });
  });

  it('sprint key line: quoted with a comment, and 1-10 does not count for 1-1', async () => {
    const d = copy('v6-sprint');
    setSprint(d, /1-1-user-login: done/, '1-1-user-login: review\n  1-10-other-thing: done');
    init(d);
    commit(d, C1);
    setSprint(d, /1-1-user-login: review/, `"1-1-user-login": 'done'  # shipped`);
    commit(d, C3);
    const b = await readBoard(d, 'v6-sprint');
    expect(story(b, '1-1-user-login').doneAt).toBe(C3);
    expect(story(b, '1-10-other-thing').doneAt).toBe(C1);
  });

  it('v7 tree (file reader): the leaf file holding the status', async () => {
    const d = copy('v7');
    init(d);
    commit(d, C2);
    const b = await readBoard(d, 'v7:initiative-checkout', { scripts: false });
    const done = b.stories.filter((s) => s.rawStatus === 'done');
    expect(done.length).toBeGreaterThan(0);
    for (const s of done) expect(s.doneAt).toBe(C2);
    for (const s of b.stories.filter((x) => x.rawStatus !== 'done')) expect(fields(s)).toEqual({ doneAt: undefined, doneUncommitted: undefined });
  });

  it('v7 parent board: done stories in its children get times', async () => {
    const d = copy('v7');
    init(d);
    commit(d, C2);
    const b = await readBoard(d, 'v7:initiative-parent', { scripts: false });
    const done = (b.children ?? []).flatMap((c) => c.stories).filter((s) => s.rawStatus === 'done');
    expect(done.length).toBeGreaterThan(0);
    for (const s of done) expect(s.doneAt).toBe(C2);
  });

  it.skipIf(!hasUv)('v7 (script reader): same file as the file reader', async () => {
    const d = copy('v7');
    init(d);
    commit(d, C2);
    const b = await readBoard(d, 'v7:initiative-checkout');
    const done = b.stories.filter((s) => s.rawStatus === 'done');
    expect(done.length).toBeGreaterThan(0);
    for (const s of done) expect(s.doneAt).toBe(C2);
  });

  it('a card in Done only because of tracker_status gets no time', async () => {
    const d = copy('v6-sprint');
    init(d);
    commit(d, C1);
    const cfg = loadBmadConfig(d);
    const leaf = path.join(d, '_bmad-output/implementation-artifacts/1-1-user-login.md');
    fs.writeFileSync(leaf, '---\nstatus: done\n---\n');
    commit(d, C2);
    const s: Story = { key: 'x', id: '1', title: 't', epicId: null, column: 'done', rawStatus: 'built' };
    const board: Board = { sourceId: 's', kind: 'v7-initiative', label: 'l', epics: [], stories: [s], notices: [] };
    await addDoneTimes(cfg, 'v7', board, () => leaf);
    expect(fields(s)).toEqual({ doneAt: undefined, doneUncommitted: undefined });
    s.rawStatus = 'done';
    await addDoneTimes(cfg, 'v7', board, () => leaf);
    expect(s.doneAt).toBe(C2);
  });

  it('runs no repo-configured programs (untrusted projects)', async () => {
    const d = copy('v6-sprint');
    init(d);
    const marker = path.join(d, 'ran');
    const evil = path.join(d, 'evil.sh');
    fs.writeFileSync(evil, `#!/bin/sh\necho x >> "${marker}"\ncat "$@" 2>/dev/null\n`, { mode: 0o755 });
    for (const [k, v] of [
      ['core.pager', evil], ['core.fsmonitor', evil], ['diff.external', evil], ['diff.evil.textconv', evil],
      ['log.showSignature', 'true'], ['gpg.program', evil], ['pager.log', evil], ['pager.show', evil],
    ] as const) git(d, ['config', k, v]);
    fs.writeFileSync(path.join(d, '.gitattributes'), '* diff=evil\n');
    commit(d, C1);
    fs.rmSync(marker, { force: true });
    expect(story(await readBoard(d, 'v6-sprint'), '1-1-user-login').doneAt).toBe(C1);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('caches history while HEAD is unchanged (200 done stories)', async () => {
    const d = copy('v6-sprint');
    const rows = Array.from({ length: 200 }, (_, i) => `  9-${i + 1}-story-${i + 1}: done`).join('\n');
    setSprint(d, /development_status:\n/, `development_status:\n${rows}\n`);
    init(d);
    commit(d, C1);
    const first = gitStats.log;
    const b = await readBoard(d, 'v6-sprint');
    expect(b.stories.filter((s) => s.doneAt === C1)).toHaveLength(201);
    const afterFirst = gitStats.log;
    expect(afterFirst - first).toBe(1);
    await readBoard(d, 'v6-sprint');
    expect(gitStats.log).toBe(afterFirst);
    fs.writeFileSync(path.join(d, 'x.txt'), 'x');
    commit(d, C2);
    await readBoard(d, 'v6-sprint');
    expect(gitStats.log).toBe(afterFirst + 1);
  });

  it('a commit fires the project watcher', async () => {
    const d = copy('v6-sprint');
    init(d);
    commit(d, C1);
    let fired = 0;
    const stop = watchProject(d, () => fired++);
    try {
      await stop.ready;
      // an empty commit touches no project file: only the HEAD reflog can fire
      git(d, ['commit', '-q', '--allow-empty', '-m', 'empty'], C2);
      await vi.waitFor(() => expect(fired).toBeGreaterThan(0), { timeout: 5000, interval: 100 });
    } finally {
      stop();
    }
  });
});
