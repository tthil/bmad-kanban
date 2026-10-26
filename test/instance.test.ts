import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRunning, readLock, writeLock } from '../src/instance.js';
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
    writeLock(lock, { port: 1234, pid: 99 });
    expect(readLock(lock)).toEqual({ port: 1234, pid: 99 });
    fs.writeFileSync(lock, 'nope');
    expect(readLock(lock)).toBeNull();
    expect(readLock(path.join(tmp, 'missing.json'))).toBeNull();
  });

  it('dead pid -> null and lock deleted', async () => {
    writeLock(lock, { port: 4310, pid: 2 ** 22 + 12345 });
    expect(await findRunning(lock)).toBeNull();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('live server -> its port', async () => {
    const server = await startServer({ registry: new Registry(path.join(tmp, 'p.json')), port: 0, webRoot: tmp });
    try {
      writeLock(lock, { port: server.port, pid: process.pid });
      expect(await findRunning(lock)).toBe(server.port);
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('live pid but nothing answering on the port -> null, lock deleted', async () => {
    const dummy = http.createServer((_q, r) => r.writeHead(500).end());
    await new Promise<void>((r) => dummy.listen(0, '127.0.0.1', r));
    const port = (dummy.address() as { port: number }).port;
    writeLock(lock, { port, pid: process.pid });
    expect(await findRunning(lock)).toBeNull(); // answers 500, not 200
    expect(fs.existsSync(lock)).toBe(false);
    await new Promise((r) => dummy.close(r));
    writeLock(lock, { port, pid: process.pid });
    expect(await findRunning(lock)).toBeNull(); // closed port
    expect(fs.existsSync(lock)).toBe(false);
  });
});
