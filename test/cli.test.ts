import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launch, main } from '../src/cli.js';
import { writeLock } from '../src/instance.js';
import { Registry } from '../src/registry.js';
import { startServer, type RunningServer } from '../src/server/app.js';

let tmp: string;
let out: string[];
let err: string[];
const started: RunningServer[] = [];
const fixture = path.resolve('test/fixtures/v6-sprint');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-kanban-cli-'));
  process.env.BMAD_KANBAN_CONFIG_DIR = path.join(tmp, 'cfg');
  out = [];
  err = [];
});
afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.close()));
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  delete process.env.BMAD_KANBAN_CONFIG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const io = () => ({ stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) });
const realStart = vi.fn(async (o: Parameters<typeof startServer>[0]) => {
  const s = await startServer(o);
  started.push(s);
  return s;
});

describe('cli', () => {
  it('path outside a project -> exit 1, message, nothing started', async () => {
    const open = vi.fn();
    const start = vi.fn();
    const code = await main([tmp], { ...io(), open, startServer: start });
    expect(code).toBe(1);
    expect(err.join('')).toBe(`Not a BMAD project: ${tmp}\n`);
    expect(start).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('reuses a running instance without starting a server', async () => {
    const server = await startServer({ registry: new Registry(path.join(tmp, 'r.json')), port: 0, webRoot: tmp });
    started.push(server);
    writeLock(path.join(tmp, 'cfg', 'server.json'), { port: server.port, pid: process.pid, token: server.token, scripts: true });
    const open = vi.fn(async () => undefined);
    const start = vi.fn();
    const code = await main([fixture], { ...io(), open, startServer: start });
    expect(code).toBe(0);
    expect(start).not.toHaveBeenCalled();
    const url = open.mock.calls[0]![0] as string;
    expect(url).toBe(`http://127.0.0.1:${server.port}/?project=${url.match(/project=([0-9a-f]{12})/)![1]}#token=${server.token}`);
    expect(out.join('')).toBe(`Opened v6-sprint in the running board at ${url}\n`);
  });

  it('fresh start: starts server, adds project, opens browser with project id, writes lock', async () => {
    realStart.mockClear();
    const open = vi.fn(async () => undefined);
    const code = await main([fixture, '--port', '0'], { ...io(), open, startServer: realStart });
    expect(code).toBe(0);
    expect(realStart).toHaveBeenCalledOnce();
    const { port, token } = started[0]!;
    const url = open.mock.calls[0]![0] as string;
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?project=[0-9a-f]{12}#token=${token}$`));
    expect(out.join('')).toBe(`BMAD Kanban running at ${url}\n`);
    const lock = JSON.parse(fs.readFileSync(path.join(tmp, 'cfg', 'server.json'), 'utf8'));
    expect(lock).toEqual({ port, pid: process.pid, token, scripts: true });
    expect(fs.readFileSync(path.join(tmp, 'cfg', 'token'), 'utf8')).toBe(token); // kept for the next start
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const projects = await (await fetch(`http://127.0.0.1:${port}/api/projects`, auth)).json();
    expect(JSON.stringify(projects)).toContain('v6-sprint');
  });

  it('--no-open skips the browser', async () => {
    const open = vi.fn();
    const code = await main([fixture, '--port', '0', '--no-open'], { ...io(), open, startServer: realStart });
    expect(code).toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect(out.join('')).toContain('BMAD Kanban running at');
  });

  it('--no-scripts starts a server with scripts off', async () => {
    realStart.mockClear();
    const code = await main([fixture, '--port', '0', '--no-open', '--no-scripts'], { ...io(), open: vi.fn(), startServer: realStart });
    expect(code).toBe(0);
    expect(realStart.mock.calls[0]![0]).toMatchObject({ scripts: false });
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'cfg', 'server.json'), 'utf8')).scripts).toBe(false);
  });

  it('--no-scripts refuses to reuse a board that runs scripts', async () => {
    const server = await startServer({ registry: new Registry(path.join(tmp, 'r.json')), port: 0, webRoot: tmp });
    started.push(server);
    writeLock(path.join(tmp, 'cfg', 'server.json'), { port: server.port, pid: process.pid, token: server.token, scripts: true });
    const open = vi.fn();
    const code = await main([fixture, '--no-scripts'], { ...io(), open, startServer: vi.fn() });
    expect(code).toBe(1);
    expect(err.join('')).toContain('Stop it first to use --no-scripts');
    expect(open).not.toHaveBeenCalled();
  });

  it('--browser picks the browser, BMAD_KANBAN_BROWSER sets the default', async () => {
    const open = vi.fn(async () => undefined);
    await main([fixture, '--port', '0', '--browser', 'firefox'], { ...io(), open, startServer: realStart });
    expect(open.mock.calls[0]![1]).toBe('firefox');
    process.env.BMAD_KANBAN_BROWSER = 'safari';
    try {
      await main([fixture], { ...io(), open, startServer: realStart });
      expect(open.mock.calls[1]![1]).toBe('safari');
      await main([fixture, '--browser', 'chrome'], { ...io(), open, startServer: realStart });
      expect(open.mock.calls[2]![1]).toBe('chrome'); // the flag wins
    } finally {
      delete process.env.BMAD_KANBAN_BROWSER;
    }
    await main([fixture], { ...io(), open, startServer: realStart });
    expect(open.mock.calls[3]![1]).toBeUndefined(); // system browser
  });

  it('a browser that cannot be opened still prints the address', async () => {
    const open = vi.fn(async () => {
      throw new Error('app not found');
    });
    const code = await main([fixture, '--port', '0', '--browser', 'nope'], { ...io(), open, startServer: realStart });
    expect(code).toBe(0);
    expect(err.join('')).toContain('Could not open nope: app not found.');
    expect(out.join('')).toMatch(/BMAD Kanban running at http:\/\/127\.0\.0\.1:\d+\/\?project=\w+#token=/);
  });

  it.skipIf(process.platform === 'win32')('--browser orca opens a tab in Orca through its CLI', async () => {
    const fake = path.join(tmp, 'orca');
    const log = path.join(tmp, 'orca-args.json');
    fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    process.env.ORCA_CLI_COMMAND = fake;
    try {
      await launch('http://127.0.0.1:1/#token=t', 'Orca');
      expect(JSON.parse(fs.readFileSync(log, 'utf8'))).toEqual(['tab', 'create', '--url', 'http://127.0.0.1:1/#token=t', '--worktree', 'active', '--json']);
      fs.writeFileSync(fake, '#!/bin/sh\necho "Orca is not running" >&2\nexit 1\n');
      await expect(launch('http://127.0.0.1:1/', 'orca')).rejects.toThrow('Orca is not running');
      process.env.ORCA_CLI_COMMAND = path.join(tmp, 'missing-orca');
      await expect(launch('http://127.0.0.1:1/', 'orca')).rejects.toThrow('command not found');
    } finally {
      delete process.env.ORCA_CLI_COMMAND;
    }
  });

  it('--version and --help', async () => {
    expect(await main(['--version'], io())).toBe(0);
    expect(out.join('')).toMatch(/^\d+\.\d+\.\d+/);
    expect(await main(['--help'], io())).toBe(0);
    expect(out.join('')).toContain('Usage: bmad-kanban');
  });
});
