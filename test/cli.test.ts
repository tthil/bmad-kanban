import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
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
    writeLock(path.join(tmp, 'cfg', 'server.json'), { port: server.port, pid: process.pid });
    const open = vi.fn(async () => undefined);
    const start = vi.fn();
    const code = await main([fixture], { ...io(), open, startServer: start });
    expect(code).toBe(0);
    expect(start).not.toHaveBeenCalled();
    const url = open.mock.calls[0]![0] as string;
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${server.port}/\\?project=[0-9a-f]{12}$`));
    expect(out.join('')).toBe(`Opened v6-sprint in the running board at ${url}\n`);
  });

  it('fresh start: starts server, adds project, opens browser with project id, writes lock', async () => {
    realStart.mockClear();
    const open = vi.fn(async () => undefined);
    const code = await main([fixture, '--port', '0'], { ...io(), open, startServer: realStart });
    expect(code).toBe(0);
    expect(realStart).toHaveBeenCalledOnce();
    const port = started[0]!.port;
    const url = open.mock.calls[0]![0] as string;
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?project=[0-9a-f]{12}$`));
    expect(out.join('')).toContain(`BMAD Kanban running at http://127.0.0.1:${port}/`);
    const lock = JSON.parse(fs.readFileSync(path.join(tmp, 'cfg', 'server.json'), 'utf8'));
    expect(lock).toEqual({ port, pid: process.pid });
    const projects = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
    expect(JSON.stringify(projects)).toContain('v6-sprint');
  });

  it('--no-open skips the browser', async () => {
    const open = vi.fn();
    const code = await main([fixture, '--port', '0', '--no-open'], { ...io(), open, startServer: realStart });
    expect(code).toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect(out.join('')).toContain('BMAD Kanban running at');
  });

  it('--version and --help', async () => {
    expect(await main(['--version'], io())).toBe(0);
    expect(out.join('')).toMatch(/^\d+\.\d+\.\d+/);
    expect(await main(['--help'], io())).toBe(0);
    expect(out.join('')).toContain('Usage: bmad-kanban');
  });
});
