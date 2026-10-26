import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Registry } from '../src/registry.js';
import { startServer } from '../src/server/app.js';

const fixtures = path.resolve('test/fixtures');
let tmp: string;
let server: Awaited<ReturnType<typeof startServer>> | null;
let base: string;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmad-kanban-srv-'));
  const webRoot = path.join(tmp, 'web');
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<html>app</html>');
  fs.writeFileSync(path.join(webRoot, 'a.js'), 'x');
  server = await startServer({ registry: new Registry(path.join(tmp, 'cfg', 'projects.json')), port: 0, webRoot });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server?.close();
  server = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const copyFixture = (name: string): string => {
  const dest = path.join(tmp, name);
  fs.cpSync(path.join(fixtures, name), dest, { recursive: true });
  return dest;
};
const json = { 'Content-Type': 'application/json' };
const post = (p: string) =>
  fetch(`${base}/api/projects`, { method: 'POST', headers: json, body: JSON.stringify({ path: p }) });

function rawGet(urlPath: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server!.port, path: urlPath, headers: { Host: host } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const hashTree = (dir: string): string => {
  const h = createHash('sha1');
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else h.update(path.relative(dir, f)).update(fs.readFileSync(f));
    }
  };
  walk(dir);
  return h.digest('hex');
};

describe('server', () => {
  it('adds a project and serves its board', async () => {
    const res = await post(copyFixture('v6-sprint'));
    expect(res.status).toBe(201);
    const summary = await res.json();
    expect(summary.missing).toBe(false);
    const board = await (await fetch(`${base}/api/projects/${summary.id}/boards/v6-sprint`)).json();
    expect(board.stories).toHaveLength(4);
    expect((await (await fetch(`${base}/api/projects`)).json()).map((p: { id: string }) => p.id)).toEqual([summary.id]);
  });

  it('rejects bad hosts, non-JSON writes and non-BMAD paths', async () => {
    expect((await rawGet('/api/projects', 'evil.com')).status).toBe(403);
    expect((await rawGet('/api/projects', `localhost:${server!.port}`)).status).toBe(200);
    const r = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    expect(r.status).toBe(415);
    const bad = await post(tmp);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Not a BMAD project/);
    const inv = await fetch(`${base}/api/projects`, { method: 'POST', headers: json, body: '{nope' });
    expect(inv.status).toBe(400);
  });

  it('reports a removed folder as missing and 410', async () => {
    const dir = copyFixture('v6-sprint');
    const { id } = await (await post(dir)).json();
    fs.rmSync(dir, { recursive: true, force: true });
    const [p] = await (await fetch(`${base}/api/projects`)).json();
    expect(p).toMatchObject({ missing: true, sources: [], tags: [], version: null, defaultSourceId: null });
    expect((await fetch(`${base}/api/projects/${id}/boards/v6-sprint`)).status).toBe(410);
  });

  it('emits exactly one change event for a burst of writes', async () => {
    const dir = copyFixture('v6-sprint');
    const { id } = await (await post(dir)).json();
    await fetch(`${base}/api/projects/${id}/boards/v6-sprint`); // starts the watcher
    const events: string[] = [];
    const req = http.get(`${base}/api/events`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => events.push(...c.split('\n\n').filter((e) => e.startsWith('event: change'))));
    });
    await new Promise((r) => setTimeout(r, 100));
    const file = path.join(dir, '_bmad-output/implementation-artifacts/sprint-status.yaml');
    fs.appendFileSync(file, '# one\n');
    await new Promise((r) => setTimeout(r, 50));
    fs.appendFileSync(file, '# two\n');
    const start = Date.now();
    while (events.length === 0 && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 25));
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(`"projectId":"${id}"`);
    await new Promise((r) => setTimeout(r, 600));
    expect(events).toHaveLength(1);
    req.destroy();
  });

  it('never resolves traversal story keys to files', async () => {
    const { id } = await (await post(copyFixture('v6-sprint'))).json();
    const r = await fetch(`${base}/api/projects/${id}/boards/v6-sprint/stories/..%2F..%2Fetc%2Fpasswd`);
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('root:');
  });

  it('maps unknown project and source to 404 and handles prefs/state', async () => {
    expect((await fetch(`${base}/api/projects/nope/boards/x`)).status).toBe(404);
    const { id } = await (await post(copyFixture('v6-sprint'))).json();
    expect((await fetch(`${base}/api/projects/${id}/boards/nope`)).status).toBe(404);
    const put = await fetch(`${base}/api/projects/${id}/prefs`, { method: 'PUT', headers: json, body: '{"view":"swimlanes"}' });
    expect(put.status).toBe(204);
    expect((await fetch(`${base}/api/projects/${id}/prefs`, { method: 'PUT', body: '{}' })).status).toBe(415);
    await fetch(`${base}/api/state`, { method: 'PUT', headers: json, body: JSON.stringify({ lastViewed: id }) });
    expect(await (await fetch(`${base}/api/state`)).json()).toEqual({ lastViewed: id });
    expect((await fetch(`${base}/api/projects/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await (await fetch(`${base}/api/projects`)).json()).toEqual([]);
  });

  it('serves static files with index.html fallback and never escapes webRoot', async () => {
    const js = await fetch(`${base}/a.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(await (await fetch(`${base}/some/route`)).text()).toBe('<html>app</html>');
    const esc = await rawGet('/..%2Fcfg%2Fprojects.json', `127.0.0.1:${server!.port}`);
    expect(esc.body).toBe('<html>app</html>');
  });

  it('answers 404 "web app not built" without a web root', async () => {
    await server!.close();
    server = await startServer({ registry: new Registry(path.join(tmp, 'r2.json')), port: 0, webRoot: path.join(tmp, 'none') });
    const r = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(r.status).toBe(404);
    expect(await r.text()).toBe('web app not built');
  });

  it('is read-only: GET routes leave the fixture untouched', async () => {
    const dir = copyFixture('v6-sprint');
    const before = hashTree(dir);
    const { id } = await (await post(dir)).json();
    await fetch(`${base}/api/projects`);
    await fetch(`${base}/api/state`);
    await fetch(`${base}/api/projects/${id}/boards/v6-sprint`);
    await fetch(`${base}/api/projects/${id}/boards/v6-sprint/stories/1-1-user-login`);
    await fetch(`${base}/api/projects/${id}/boards/v6-sprint/stories/..%2F..%2Fx`);
    expect(hashTree(dir)).toBe(before);
  });
});
