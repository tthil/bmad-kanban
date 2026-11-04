// Regenerates the README images in docs/screenshots/ from a made-up demo project.
// Run it with `npm run screenshots`, which builds the board first.
import { chromium } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'docs', 'screenshots');
const VIEWPORT = { width: 1280, height: 800 };
// Fixed dates and a frozen browser clock keep the images the same from run to run.
const NOW = '2026-11-04T12:00:00Z';
const PLANNED = '2026-10-01T09:00:00Z';

const EPICS = [
  { id: 1, title: 'Accounts' },
  { id: 2, title: 'Plant library' },
  { id: 3, title: 'Watering reminders' },
];

// `doneAt` is when the card was committed as done. `uncommitted` leaves it done but not committed.
const STORIES = [
  { key: '1-1-sign-up-with-email', title: 'Sign up with email', status: 'done', doneAt: '2026-10-16T09:20:00Z' },
  { key: '1-2-log-in-and-out', title: 'Log in and out', status: 'done', doneAt: '2026-10-19T16:45:00Z' },
  { key: '1-3-password-reset', title: 'Password reset', status: 'done', doneAt: '2026-10-23T11:10:00Z' },
  { key: '2-1-plant-data-model', title: 'Plant data model', status: 'done', doneAt: '2026-10-27T14:30:00Z' },
  { key: '2-2-add-a-plant', title: 'Add a plant', status: 'done', doneAt: '2026-11-01T10:05:00Z' },
  { key: '2-3-search-and-filter', title: 'Search and filter', status: 'done', uncommitted: true },
  { key: '2-4-plant-photos', title: 'Plant photos', status: 'review' },
  { key: '2-5-care-notes', title: 'Care notes', status: 'in-progress' },
  { key: '3-1-watering-schedule', title: 'Watering schedule', status: 'in-progress' },
  { key: '3-2-push-notifications', title: 'Push notifications', status: 'ready-for-dev' },
  { key: '3-3-snooze-a-reminder', title: 'Snooze a reminder', status: 'ready-for-dev' },
  { key: '3-4-weekly-summary', title: 'Weekly summary', status: 'backlog' },
  { key: '3-5-calendar-export', title: 'Calendar export', status: 'backlog' },
];

const storyId = (s) => s.key.split('-').slice(0, 2).join('.');
const epicOf = (s) => Number(s.key.split('-')[0]);

function sprintStatus(isDone) {
  const lines = ['project: greenhouse', 'development_status:'];
  for (const epic of EPICS) {
    const mine = STORIES.filter((s) => epicOf(s) === epic.id);
    lines.push(`  epic-${epic.id}: ${mine.every((s) => s.status === 'done') ? 'done' : 'in-progress'}`);
    for (const s of mine) lines.push(`  ${s.key}: ${s.status === 'done' && !isDone(s) ? 'in-progress' : s.status}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Writes the demo project and its git history, and returns its folder. */
function createDemoProject(tmp) {
  const project = path.join(tmp, 'greenhouse');
  const output = path.join(project, '_bmad-output');
  const impl = path.join(output, 'implementation-artifacts');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(path.join(project, '_bmad/config.toml'), [
    '[core]', 'output_folder = "{project-root}/_bmad-output"', '',
    '[modules.bmm]',
    'planning_artifacts = "{project-root}/_bmad-output/planning-artifacts"',
    'implementation_artifacts = "{project-root}/_bmad-output/implementation-artifacts"', '',
  ].join('\n'));
  write(path.join(project, '_bmad/_config/manifest.yaml'), 'installation:\n  version: 6.12.4\n');
  write(path.join(output, 'planning-artifacts/epics.md'), EPICS.map((e) => [
    `## Epic ${e.id}: ${e.title}`,
    ...STORIES.filter((s) => epicOf(s) === e.id).map((s) => `### Story ${storyId(s)}: ${s.title}`),
  ].join('\n')).join('\n') + '\n');
  for (const s of STORIES) {
    if (s.status === 'backlog') continue;
    write(path.join(impl, `${s.key}.md`), `# Story ${storyId(s)}: ${s.title}\n\nStatus: ${s.status}\n`);
  }

  // Nothing from this machine's git setup or a surrounding git hook may affect the demo repo.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (args, date = PLANNED) => execFileSync('git', [
    '-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], {
    cwd: project,
    stdio: 'pipe',
    env: { ...env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });

  const statusFile = path.join(impl, 'sprint-status.yaml');
  const finished = new Set();
  write(statusFile, sprintStatus((s) => finished.has(s)));
  git(['init', '-q']);
  git(['add', '.']);
  git(['commit', '-qm', 'Plan the sprint']);
  for (const s of STORIES.filter((x) => x.doneAt !== undefined)) {
    finished.add(s);
    write(statusFile, sprintStatus((x) => finished.has(x)));
    git(['commit', '-qam', `Finish ${s.key}`], s.doneAt);
  }
  write(statusFile, sprintStatus(() => true));
  return project;
}

function startBoard(project, tmp) {
  const child = spawn(process.execPath, [path.join(REPO, 'dist/cli.js'), project, '--no-open', '--port', '0'], {
    env: { ...process.env, BMAD_KANBAN_CONFIG_DIR: path.join(tmp, 'config') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`The board did not start:\n${out}`)), 15_000);
    const read = (b) => {
      out += b.toString();
      const m = /BMAD Kanban running at (\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`The board exited early (${code}):\n${out}`));
    });
  });
  return { child, url };
}

async function openBoard(browser, url, colorScheme) {
  const context = await browser.newContext({
    viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme, locale: 'en-GB', timezoneId: 'UTC',
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  await page.goto(url);
  await page.locator('.card-done').first().waitFor();
  await page.locator('.badge.uncommitted').first().waitFor();
  const times = await page.locator('.card-done').count();
  const expected = STORIES.filter((s) => s.doneAt !== undefined).length;
  if (times !== expected) throw new Error(`Expected ${expected} done times on the board, found ${times}`);
  return page;
}

const showView = async (page, name) => {
  await page.getByRole('group', { name: 'Board view' }).getByRole('button', { name }).click();
  await page.mouse.move(0, 0);
};

/** Makes the window just tall enough for `selector`, so nothing is cut off and no empty space is left below it. */
const fitHeight = async (page, selector) => {
  const box = await page.locator(selector).boundingBox();
  await page.setViewportSize({ width: VIEWPORT.width, height: Math.ceil(box.y + box.height) + 24 });
};

async function capture(url) {
  const shot = { animations: 'disabled', scale: 'device' };
  const file = (name) => path.join(OUT, `${name}.png`);
  const browser = await chromium.launch();
  try {
    const light = await openBoard(browser, url, 'light');
    await showView(light, /columns/i);
    await fitHeight(light, '.column.col-done');
    await light.screenshot({ ...shot, path: file('board-columns') });
    await light.locator('.column.col-done').screenshot({ ...shot, path: file('done-column') });
    await showView(light, /swimlanes/i);
    await light.locator('.lanes').waitFor();
    await fitHeight(light, '.lanes');
    await light.screenshot({ ...shot, path: file('board-swimlanes') });
    const dark = await openBoard(browser, url, 'dark');
    await showView(dark, /columns/i);
    await fitHeight(dark, '.column.col-done');
    await dark.screenshot({ ...shot, path: file('board-dark') });
  } finally {
    await browser.close();
  }
}

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bmad-kanban-screenshots-'));
let board;
try {
  const project = createDemoProject(tmp);
  board = startBoard(project, tmp);
  fs.mkdirSync(OUT, { recursive: true });
  await capture(await board.url);
  for (const f of fs.readdirSync(OUT).sort()) {
    console.log(`${f}  ${Math.round(fs.statSync(path.join(OUT, f)).size / 1024)} KB`);
  }
} finally {
  board?.child.removeAllListeners('exit');
  board?.child.kill();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
