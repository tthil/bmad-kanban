import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { loadBmadConfig, type BmadConfig } from '../bmad/config.js';
import type { ProjectSummary } from '../model.js';
import { getStoryDetail, listSources, readBoard, UnknownSourceError, UnknownStoryError } from '../readers/detect.js';
import { NotABmadProjectError, type ProjectPrefs, type Registry, type RegisteredProject } from '../registry.js';
import { watchProject, type Unwatch } from './watch.js';

export interface ServerOptions { registry: Registry; port: number; webRoot: string }
export interface RunningServer { port: number; close(): Promise<void> }

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const isMissing = (p: RegisteredProject): boolean => !fs.existsSync(path.join(p.path, '_bmad'));

async function summarize(p: RegisteredProject): Promise<ProjectSummary> {
  const base = { id: p.id, name: p.name, path: p.path };
  if (isMissing(p)) {
    return { ...base, missing: true, sources: [], tags: [], version: null, defaultSourceId: null };
  }
  const l = await listSources(p.path);
  const s: ProjectSummary = {
    ...base, missing: false, sources: l.sources, tags: l.tags, version: l.version, defaultSourceId: l.defaultSourceId,
  };
  if (l.error !== undefined) s.error = l.error;
  return s;
}

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { registry, webRoot } = opts;
  const watchers = new Map<string, Unwatch>();
  const clients = new Set<http.ServerResponse>();
  let actualPort = 0;

  const broadcast = (event: string, data: unknown) => {
    for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const stopWatcher = (id: string) => {
    watchers.get(id)?.();
    watchers.delete(id);
  };
  const ensureWatcher = async (p: RegisteredProject): Promise<void> => {
    const existing = watchers.get(p.id);
    if (existing) return void (await existing.ready);
    let cfg: BmadConfig;
    try {
      cfg = loadBmadConfig(p.path);
    } catch {
      cfg = {
        root: p.path, outputFolder: path.join(p.path, '_bmad-output'),
        planningArtifacts: path.join(p.path, '_bmad-output', 'planning-artifacts'),
        implementationArtifacts: path.join(p.path, '_bmad-output', 'implementation-artifacts'),
        activeInitiative: null, version: null,
      };
    }
    const w = watchProject(p.path, cfg, () => {
      const cur = registry.get(p.id);
      if (!cur) return stopWatcher(p.id);
      if (isMissing(cur)) stopWatcher(p.id);
      broadcast('change', { projectId: p.id });
    });
    watchers.set(p.id, w);
    await w.ready;
  };

  const sendJson = (res: http.ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) {
      res.writeHead(status).end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
  };

  const readJson = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
      throw new HttpError(415, 'Content-Type must be application/json');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 1_000_000) throw new HttpError(413, 'Body too large');
      chunks.push(c as Buffer);
    }
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
      return v as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'Invalid JSON body');
    }
  };

  const project = (id: string): RegisteredProject => {
    const p = registry.get(id);
    if (!p) throw new HttpError(404, `Unknown project: ${id}`);
    return p;
  };

  const serveStatic = (urlPath: string, res: http.ServerResponse) => {
    const notBuilt = () => res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('web app not built');
    let rel: string;
    try {
      rel = decodeURIComponent(urlPath);
    } catch {
      rel = '/';
    }
    const base = path.resolve(webRoot);
    let file = path.resolve(base, '.' + path.posix.normalize('/' + rel));
    const send = (f: string): boolean => {
      try {
        if (!fs.statSync(f).isFile()) return false;
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] ?? 'application/octet-stream' });
        res.end(fs.readFileSync(f));
        return true;
      } catch {
        return false;
      }
    };
    if (file !== base && !file.startsWith(base + path.sep)) file = path.join(base, 'index.html');
    if (send(file)) return;
    if (!send(path.join(base, 'index.html'))) notBuilt();
  };

  const route = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) {
      throw new HttpError(403, 'Forbidden host');
    }
    const method = req.method ?? 'GET';
    const urlPath = (req.url ?? '/').split('?')[0]!;
    // split before decoding so an encoded %2F stays inside a segment
    const seg = urlPath.split('/').filter(Boolean).map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        throw new HttpError(400, 'Bad URL encoding');
      }
    });

    if (seg[0] !== 'api') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(urlPath, res);
    }

    if (seg[1] === 'events' && seg.length === 2 && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      res.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (seg[1] === 'state' && seg.length === 2) {
      if (method === 'GET') return sendJson(res, 200, { lastViewed: registry.lastViewed });
      if (method === 'PUT') {
        const body = await readJson(req);
        if (typeof body.lastViewed === 'string') registry.setLastViewed(body.lastViewed);
        return sendJson(res, 204);
      }
    }

    if (seg[1] === 'projects') {
      if (seg.length === 2 && method === 'GET') {
        return sendJson(res, 200, await Promise.all(registry.list().map(summarize)));
      }
      if (seg.length === 2 && method === 'POST') {
        const body = await readJson(req);
        if (typeof body.path !== 'string' || body.path === '') throw new HttpError(400, 'path is required');
        const added = registry.add(body.path);
        const summary = await summarize(added);
        broadcast('projects', {});
        return sendJson(res, 201, summary);
      }
      const id = seg[2];
      if (id !== undefined && seg.length === 3 && method === 'DELETE') {
        project(id);
        registry.remove(id);
        stopWatcher(id);
        broadcast('projects', {});
        return sendJson(res, 204);
      }
      if (id !== undefined && seg.length === 4 && seg[3] === 'prefs' && method === 'PUT') {
        const p = project(id);
        const body = await readJson(req);
        const prefs: Partial<ProjectPrefs> = {};
        if (body.view === 'columns' || body.view === 'swimlanes') prefs.view = body.view;
        if (typeof body.showDropped === 'boolean') prefs.showDropped = body.showDropped;
        if (typeof body.sourceId === 'string' || body.sourceId === null) prefs.sourceId = body.sourceId;
        registry.setPref(p.id, prefs);
        return sendJson(res, 204);
      }
      if (id !== undefined && seg[3] === 'boards' && seg[4] !== undefined && method === 'GET') {
        const p = project(id);
        if (isMissing(p)) {
          stopWatcher(p.id);
          throw new HttpError(410, 'Project folder is missing');
        }
        await ensureWatcher(p);
        if (seg.length === 5) return sendJson(res, 200, await readBoard(p.path, seg[4]));
        if (seg.length === 7 && seg[5] === 'stories') {
          return sendJson(res, 200, await getStoryDetail(p.path, seg[4], seg[6]!));
        }
      }
    }
    throw new HttpError(404, 'Not found');
  };

  const server = http.createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      let status = 500;
      let msg = e instanceof Error ? e.message : String(e);
      if (e instanceof HttpError) status = e.status;
      else if (e instanceof UnknownSourceError || e instanceof UnknownStoryError) status = 404;
      else if (e instanceof NotABmadProjectError) status = 400;
      else console.error('request failed:', e);
      if (status === 500) msg = 'Internal server error';
      if (res.headersSent) return void res.end();
      sendJson(res, status, { error: msg });
    });
  });

  const listen = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => reject(e);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });

  return (async () => {
    const first = opts.port;
    for (let i = 0; ; i++) {
      try {
        await listen(first === 0 ? 0 : first + i);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || first === 0 || i >= 10) throw e;
      }
    }
    actualPort = (server.address() as AddressInfo).port;
    return {
      port: actualPort,
      close: () =>
        new Promise<void>((resolve) => {
          for (const id of [...watchers.keys()]) stopWatcher(id);
          for (const c of clients) c.end();
          clients.clear();
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    };
  })();
}
