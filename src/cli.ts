#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import openBrowser from 'open';
import { findProjectRoot } from './bmad/config.js';
import { findRunning, loadToken, removeLock, writeLock } from './instance.js';
import { configDir, Registry } from './registry.js';
import { startServer, type RunningServer, type ServerOptions } from './server/app.js';

export interface CliDeps {
  open: (url: string) => Promise<unknown>;
  startServer: (opts: ServerOptions) => Promise<RunningServer>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const defaultDeps: CliDeps = {
  open: (url) => openBrowser(url),
  startServer,
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
};

const HELP = `Usage: bmad-kanban [path] [--port N] [--no-open] [--no-scripts]

Read-only Kanban board for BMAD Method projects.

  path         project folder (default: current directory)
  --port N     port to listen on (default: 4310)
  --no-open    do not open a browser
  --no-scripts never run the project's own BMAD scripts (read the files only)
  --help       show this help
  --version    show the version
`;

function version(): string {
  const pkg = new URL('../package.json', import.meta.url);
  return JSON.parse(fs.readFileSync(pkg, 'utf8')).version as string;
}

export async function main(argv: string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const d = { ...defaultDeps, ...deps };
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: 'string' },
        'no-open': { type: 'boolean' },
        'no-scripts': { type: 'boolean' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
      },
    });
  } catch (e) {
    d.stderr(`${(e as Error).message}\n${HELP}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) return d.stdout(HELP), 0;
  if (values.version) return d.stdout(`${version()}\n`), 0;

  const wanted = values.port === undefined ? 4310 : Number(values.port);
  if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65535) {
    d.stderr(`Invalid port: ${values.port}\n`);
    return 1;
  }
  if (positionals.length > 1) {
    d.stderr(`Expected at most one path argument\n${HELP}`);
    return 1;
  }

  const given = path.resolve(positionals[0] ?? process.cwd());
  const root = findProjectRoot(given);
  if (positionals[0] !== undefined && !root) {
    d.stderr(`Not a BMAD project: ${given}\n`);
    return 1;
  }

  const scripts = !values['no-scripts'];
  const lockFile = path.join(configDir(), 'server.json');
  const running = await findRunning(lockFile);
  const reuse = running !== null;
  if (running !== null && running.scripts && !scripts) {
    d.stderr(`The board running at http://127.0.0.1:${running.port}/ runs project scripts. Stop it first to use --no-scripts.\n`);
    return 1;
  }
  let port: number;
  let token: string;
  if (running !== null) {
    ({ port, token } = running);
  } else {
    const webRoot = fileURLToPath(new URL('./web/', import.meta.url));
    const server = await d.startServer({
      registry: new Registry(), port: wanted, webRoot, scripts, token: loadToken(path.join(configDir(), 'token')),
    });
    ({ port, token } = server);
    writeLock(lockFile, { port, pid: process.pid, token, scripts });
    const cleanup = () => removeLock(lockFile, process.pid);
    process.once('exit', cleanup);
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.once(sig, () => {
        cleanup();
        void server.close().finally(() => process.exit(0));
      });
    }
  }

  const base = `http://127.0.0.1:${port}/`;
  let url = base;
  let name = '';
  if (root) {
    const res = await fetch(`${base}api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: root }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; error?: string };
    if (!res.ok || !body.id) {
      d.stderr(`Could not add project: ${body.error ?? res.statusText}\n`);
      return 1;
    }
    url = `${base}?project=${body.id}`;
    name = body.name ?? path.basename(root);
  }

  // the token rides in the fragment, which the browser never sends to the server
  url += `#token=${token}`;
  if (!values['no-open']) await d.open(url);
  if (reuse) {
    d.stdout(`Opened ${name ? `${name} in` : ''}${name ? ' ' : ''}the running board at ${url}\n`);
    if (!running.scripts && scripts) d.stdout('Project scripts are off in the running board (started with --no-scripts).\n');
  } else {
    d.stdout(`BMAD Kanban running at ${url}\n`);
  }
  return 0;
}

const self = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (self === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (e) => {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
