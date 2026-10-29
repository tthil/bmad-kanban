import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRunning, loadToken, readLock, writeLock } from '../src/instance.js';
import { Registry } from '../src/registry.js';
import { startServer } from '../src/server/app.js';

let tmp: string;
let lock: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-kanban-inst-'));
  lock = path.join(tmp, 'server.json');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('instance lock', () => {
  it('round-trips and rejects corrupt files', () => {
    writeLock(lock, { port: 1234, pid: 99, token: 't', scripts: false });
    expect(readLock(lock)).toEqual({ port: 1234, pid: 99, token: 't', scripts: false });
    if (process.platform !== 'win32') expect(fs.statSync(lock).mode & 0o777).toBe(0o600);
    fs.writeFileSync(lock, JSON.stringify({ port: 1234, pid: 99 })); // a lock from before tokens
    expect(readLock(lock)).toBeNull();
    fs.writeFileSync(lock, 'nope');
    expect(readLock(lock)).toBeNull();
    expect(readLock(path.join(tmp, 'missing.json'))).toBeNull();
  });

  it('creates a private token once and reuses it', () => {
    const file = path.join(tmp, 'token');
    const t = loadToken(file);
    expect(t).toMatch(/^[\w-]{43}$/);
    expect(loadToken(file)).toBe(t);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(file, 'short');
    expect(loadToken(file)).not.toBe('short');
  });

  it('dead pid -> null and lock deleted', async () => {
    writeLock(lock, { port: 4310, pid: 2 ** 22 + 12345, token: 't', scripts: true });
    expect(await findRunning(lock)).toBeNull();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('live server -> its lock', async () => {
    const server = await startServer({ registry: new Registry(path.join(tmp, 'p.json')), port: 0, webRoot: tmp });
    try {
      const live = { port: server.port, pid: process.pid, token: server.token, scripts: true };
      writeLock(lock, live);
      expect(await findRunning(lock)).toEqual(live);
      writeLock(lock, { ...live, token: 'stale' });
      expect(await findRunning(lock)).toBeNull(); // answers 401 to a wrong token
      writeLock(lock, live);
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('an impostor on the port never receives the token', async () => {
    const seen: string[] = [];
    const impostor = http.createServer((q, r) => {
      seen.push(`${q.url} ${q.headers.authorization ?? ''}`);
      r.writeHead(200, { 'Content-Type': 'application/json' }).end('{"proof":"0000","lastViewed":null}');
    });
    await new Promise<void>((r) => impostor.listen(0, '127.0.0.1', r));
    const port = (impostor.address() as { port: number }).port;
    try {
      writeLock(lock, { port, pid: process.pid, token: 'the-real-token', scripts: true });
      expect(await findRunning(lock)).toBeNull();
      expect(seen).toHaveLength(1);
      expect(seen.join('\n')).not.toContain('the-real-token');
    } finally {
      await new Promise((r) => impostor.close(r));
    }
  });

  it('live pid but nothing answering on the port -> null, lock deleted', async () => {
    const dummy = http.createServer((_q, r) => r.writeHead(500).end());
    await new Promise<void>((r) => dummy.listen(0, '127.0.0.1', r));
    const port = (dummy.address() as { port: number }).port;
    writeLock(lock, { port, pid: process.pid, token: 't', scripts: true });
    expect(await findRunning(lock)).toBeNull(); // answers 500, not 200
    expect(fs.existsSync(lock)).toBe(false);
    await new Promise((r) => dummy.close(r));
    writeLock(lock, { port, pid: process.pid, token: 't', scripts: true });
    expect(await findRunning(lock)).toBeNull(); // closed port
    expect(fs.existsSync(lock)).toBe(false);
  });
});
