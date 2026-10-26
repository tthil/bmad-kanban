import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

let child: ChildProcess;
let base = '';
let tmp = '';
let statusFile = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

let project = '';
let port = 0;

function startCli(): Promise<string> {
  child = spawn(process.execPath, [path.resolve('dist/cli.js'), project, '--no-open', '--port', String(port)], {
    env: { ...process.env, BMAD_KANBAN_CONFIG_DIR: path.join(tmp, 'config') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`CLI did not start:\n${out}`)), 15_000);
    child.stdout!.on('data', (b: Buffer) => {
      out += b.toString();
      const m = /BMAD Kanban running at (\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    child.stderr!.on('data', (b: Buffer) => (out += b.toString()));
    child.once('exit', (code) => reject(new Error(`CLI exited early (${code}):\n${out}`)));
  });
}

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-kanban-e2e-'));
  project = path.join(tmp, 'mixed');
  fs.cpSync(path.resolve('test/fixtures/mixed'), project, { recursive: true });
  statusFile = path.join(project, '_bmad-output/implementation-artifacts/sprint-status.yaml');
  port = await freePort();
  base = await startCli();
});

test.afterAll(() => {
  child?.kill();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('mixed project: tags, boards, swimlanes, detail and live update', async ({ page }) => {
  await page.goto(base);
  const sidebar = page.getByRole('navigation', { name: 'Projects' });
  await expect(sidebar.getByText('v6', { exact: true })).toBeVisible();
  await expect(sidebar.getByText('v7', { exact: true })).toBeVisible();

  await sidebar.getByRole('button', { name: /v6 sprint/ }).click();
  const done = page.getByRole('region', { name: 'Done' });
  await expect(done.getByRole('button', { name: /User login/ })).toBeVisible();

  await page.getByRole('button', { name: 'Swimlanes' }).click();
  await expect(page.getByText('Accounts').first()).toBeVisible();
  await page.getByRole('button', { name: 'Columns' }).click();

  await page.getByRole('button', { name: /User login/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /Story 1\.1: User login/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // a story on the board without a file yet: "No file yet", no error
  await page.getByRole('button', { name: /Password reset/i }).click();
  await expect(dialog.getByText('No file yet')).toBeVisible();
  await expect(dialog.locator('.notice.error')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  const reset = /Password reset/i;
  await expect(page.getByRole('region', { name: 'In progress' }).getByRole('button', { name: reset })).toBeVisible();
  fs.writeFileSync(statusFile, fs.readFileSync(statusFile, 'utf8').replace('1-2-password-reset: contexted', '1-2-password-reset: done'));
  await expect(done.getByRole('button', { name: reset })).toBeVisible({ timeout: 3000 });
});

test('refetches the board after the event stream reconnects', async ({ page }) => {
  await page.goto(base);
  const sidebar = page.getByRole('navigation', { name: 'Projects' });
  await sidebar.getByRole('button', { name: /v6 sprint/ }).click();
  const plant = /Plant data model/;
  await expect(page.getByRole('region', { name: 'Ready' }).getByRole('button', { name: plant })).toBeVisible();

  // the server goes away; the change happens while no watcher is running
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  await exited;
  fs.writeFileSync(statusFile, fs.readFileSync(statusFile, 'utf8').replace('2-1-plant-data-model: ready-for-dev', '2-1-plant-data-model: review'));
  base = await startCli();

  await expect(page.getByRole('region', { name: 'Review' }).getByRole('button', { name: plant })).toBeVisible({ timeout: 15_000 });
});
