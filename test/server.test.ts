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
// every API call in these tests carries the server's token unless it sets its own Authorization
const fetch = (url: string, init: RequestInit = {}) =>
  globalThis.fetch(url, { ...init, headers: { Authorization: `Bearer ${server!.token}`, ...init.headers } });
const json = { 'Content-Type': 'application/json' };
const post = (p: string) =>
  fetch(`${base}/api/projects`, { method: 'POST', headers: json, body: JSON.stringify({ path: p }) });

function rawGet(urlPath: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server!.port, path: urlPath, headers: { Host: host, Authorization: `Bearer ${server!.token}` } },
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

/** Hash every directory entry (dirs, files, symlinks) and file content under `dir`. */
const hashTree = (dir: string): string => {
  const h = createHash('sha1');
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      const rel = path.relative(dir, f);
      if (e.isSymbolicLink()) h.update(`l:${rel}->${fs.readlinkSync(f)}\0`);
      else if (e.isDirectory()) {
        h.update(`d:${rel}\0`);
        walk(f);
      } else h.update(`f:${rel}\0`).update(fs.readFileSync(f)).update('\0');
    }
  };
  walk(dir);
  return h.digest('hex');
};

/** Open the SSE stream and collect `change` events. */
async function openEvents(): Promise<{ events: string[]; close: () => void }> {
  const events: string[] = [];
  const req = http.get(`${base}/api/events?token=${server!.token}`, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c: string) => events.push(...c.split('\n\n').filter((e) => e.startsWith('event: change'))));
  });
  await new Promise((r) => setTimeout(r, 100));
  return { events, close: () => req.destroy() };
}
const waitFor = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 25));
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
    const req = http.get(`${base}/api/events?token=${server!.token}`, (res) => {
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

  it('does not hang when a project has no output folders', async () => {
    const dir = copyFixture('v6-sprint');
    fs.rmSync(path.join(dir, '_bmad-output'), { recursive: true });
    const { id } = await (await post(dir)).json();
    const r = await fetch(`${base}/api/projects/${id}/boards/v6-sprint`, { signal: AbortSignal.timeout(3000) });
    expect(r.status).toBe(404);
  });

  it('emits change when a malformed config is fixed', async () => {
    const dir = copyFixture('v6-sprint');
    const cfgFile = path.join(dir, '_bmad/config.toml');
    const good = fs.readFileSync(cfgFile, 'utf8');
    fs.writeFileSync(cfgFile, 'this is = = not toml [');
    const { id } = await (await post(dir)).json();
    await fetch(`${base}/api/projects/${id}/boards/v6-sprint`, { signal: AbortSignal.timeout(3000) });
    const events: string[] = [];
    const req = http.get(`${base}/api/events?token=${server!.token}`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => events.push(...c.split('\n\n').filter((e) => e.startsWith('event: change'))));
    });
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(cfgFile, good);
    const start = Date.now();
    while (events.length === 0 && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 600));
    expect(events).toHaveLength(1);
    req.destroy();
  });

  it('live-refreshes a _bmad-only project when its output folder appears (no board GET)', async () => {
    const dir = copyFixture('v6-sprint');
    fs.rmSync(path.join(dir, '_bmad-output'), { recursive: true });
    const { id, sources } = await (await post(dir)).json();
    expect(sources).toEqual([]);
    const sse = await openEvents();
    fs.mkdirSync(path.join(dir, '_bmad-output/planning-artifacts'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_bmad-output/planning-artifacts/epics.md'), '## Epic 1: A\n### Story 1.1: B\n');
    await waitFor(() => sse.events.length > 0);
    sse.close();
    expect(sse.events.length).toBeGreaterThan(0);
    expect(sse.events[0]).toContain(`"projectId":"${id}"`);
    const [p] = await (await fetch(`${base}/api/projects`)).json();
    expect(p.sources.map((s: { id: string }) => s.id)).toContain('v6-sprint');
  });

  it('follows a config change that moves the planning folder', async () => {
    const dir = copyFixture('v6-sprint');
    const { id } = await (await post(dir)).json();
    const cfgFile = path.join(dir, '_bmad/config.toml');
    fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, 'utf8').replace('_bmad-output/planning-artifacts', 'docs/plan'));
    await new Promise((r) => setTimeout(r, 700));
    const sse = await openEvents();
    fs.mkdirSync(path.join(dir, 'docs/plan'), { recursive: true });
    await new Promise((r) => setTimeout(r, 700));
    sse.events.length = 0;
    fs.writeFileSync(path.join(dir, 'docs/plan/epics.md'), '## Epic 7: Moved\n');
    await waitFor(() => sse.events.length > 0);
    sse.close();
    expect(sse.events[0]).toContain(`"projectId":"${id}"`);
  });

  it('watches projects registered before the server started', async () => {
    const dir = copyFixture('v6-sprint');
    const reg = new Registry(path.join(tmp, 'pre.json'));
    const { id } = reg.add(dir);
    await server!.close();
    server = await startServer({ registry: reg, port: 0, webRoot: path.join(tmp, 'web') });
    base = `http://127.0.0.1:${server.port}`;
    const sse = await openEvents();
    fs.appendFileSync(path.join(dir, '_bmad-output/implementation-artifacts/sprint-status.yaml'), '# x\n');
    await waitFor(() => sse.events.length > 0);
    sse.close();
    expect(sse.events[0]).toContain(`"projectId":"${id}"`);
  });

  it('still gets events for a project living under a node_modules path', async () => {
    const dir = path.join(tmp, 'node_modules', 'proj');
    fs.cpSync(path.join(fixtures, 'v6-sprint'), dir, { recursive: true });
    const { id } = await (await post(dir)).json();
    await fetch(`${base}/api/projects/${id}/boards/v6-sprint`);
    const sse = await openEvents();
    fs.appendFileSync(path.join(dir, '_bmad-output/implementation-artifacts/sprint-status.yaml'), '# x\n');
    await waitFor(() => sse.events.length > 0);
    sse.close();
    expect(sse.events[0]).toContain(`"projectId":"${id}"`);
  });

  it('includes stored prefs in the project list', async () => {
    const { id } = await (await post(copyFixture('v6-sprint'))).json();
    const list = async () => (await (await fetch(`${base}/api/projects`)).json())[0];
    expect((await list()).prefs).toEqual({ view: 'columns', showDropped: false, sourceId: null });
    const body = JSON.stringify({ view: 'swimlanes', showDropped: true, sourceId: 'v6-sprint' });
    expect((await fetch(`${base}/api/projects/${id}/prefs`, { method: 'PUT', headers: json, body })).status).toBe(204);
    expect((await list()).prefs).toEqual({ view: 'swimlanes', showDropped: true, sourceId: 'v6-sprint' });
  });

  it('answers 404 when deleting an unknown project', async () => {
    expect((await fetch(`${base}/api/projects/nope`, { method: 'DELETE' })).status).toBe(404);
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

  it('requires the access token on every API route', async () => {
    const bare = (u: string, init?: RequestInit) => globalThis.fetch(`${base}${u}`, init);
    expect((await bare('/api/projects')).status).toBe(401);
    expect((await bare('/api/state', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await bare(`/api/projects?token=${server!.token}`)).status).toBe(401); // the query only works for events
    expect((await bare('/api/events')).status).toBe(401);
    expect((await bare('/api/projects', { method: 'POST', headers: json, body: '{"path":"/"}' })).status).toBe(401);
    expect((await bare('/')).status).toBe(200); // the web app itself needs no token
  });

  it('with scripts off never runs the project script', async () => {
    await server!.close();
    server = await startServer({ registry: new Registry(path.join(tmp, 'r3.json')), port: 0, webRoot: path.join(tmp, 'web'), scripts: false });
    base = `http://127.0.0.1:${server.port}`;
    expect(server.scripts).toBe(false);
    const dir = copyFixture('v7');
    const marker = path.join(tmp, 'script-ran');
    fs.writeFileSync(path.join(dir, '_bmad', 'method', 'scripts', 'tickets.py'), `open(${JSON.stringify(marker)}, "w").close()\n`);
    const { id } = await (await post(dir)).json();
    const [summary] = await (await fetch(`${base}/api/projects`)).json();
    const ref = (summary.sources as { id: string; kind: string }[]).find((r) => r.kind === 'v7-parent')!;
    const board = await (await fetch(`${base}/api/projects/${id}/boards/${encodeURIComponent(ref.id)}`)).json();
    expect((board.notices as { text: string }[]).some((n) => n.text.includes('--no-scripts'))).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('answers 404 "web app not built" without a web root', async () => {
    await server!.close();
    server = await startServer({ registry: new Registry(path.join(tmp, 'r2.json')), port: 0, webRoot: path.join(tmp, 'none') });
    const r = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(r.status).toBe(404);
    expect(await r.text()).toBe('web app not built');
  });

  it('is read-only: a full run over every fixture leaves them untouched', async () => {
    const root = path.join(tmp, 'all');
    fs.cpSync(fixtures, root, { recursive: true });
    const before = hashTree(root);
    const enc = encodeURIComponent;
    let boards = 0;
    let details = 0;
    for (const name of fs.readdirSync(root).sort()) {
      const res = await post(path.join(root, name));
      expect(res.status, name).toBe(201);
      const { id } = await res.json();
      const [summary] = (await (await fetch(`${base}/api/projects`)).json()).filter((p: { id: string }) => p.id === id);
      const refs = (summary.sources as { id: string; children?: { id: string }[] }[]).flatMap((r) => [r, ...(r.children ?? [])]);
      for (const ref of refs) {
        const board = await (await fetch(`${base}/api/projects/${id}/boards/${enc(ref.id)}`)).json();
        boards++;
        const story = [board, ...(board.children ?? [])].flatMap((b: { stories: { key: string }[] }) => b.stories)[0];
        if (story) {
          await fetch(`${base}/api/projects/${id}/boards/${enc(ref.id)}/stories/${enc(story.key)}`);
          details++;
        }
        await fetch(`${base}/api/projects/${id}/boards/${enc(ref.id)}/stories/..%2F..%2Fx`);
      }
      await fetch(`${base}/api/projects/${id}/boards/v6-sprint`);
    }
    await fetch(`${base}/api/state`);
    expect(boards).toBeGreaterThan(8);
    expect(details).toBeGreaterThan(5);
    expect(hashTree(root)).toBe(before);
  }, 60_000);
});
