#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import openBrowser, { apps, type AppName } from 'open';
import { findProjectRoot } from './bmad/config.js';
import { findRunning, loadToken, removeLock, writeLock } from './instance.js';
import { configDir, Registry } from './registry.js';
import { startServer, type RunningServer, type ServerOptions } from './server/app.js';

export interface CliDeps {
  /** `browser` undefined: the system default browser. */
  open: (url: string, browser?: string) => Promise<unknown>;
  startServer: (opts: ServerOptions) => Promise<RunningServer>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

/** Browser names that `open` resolves per platform; any other name is passed to the OS as an app name. */
const KNOWN_BROWSERS: readonly string[] = ['chrome', 'brave', 'firefox', 'edge', 'safari'];

const browserApp = (browser: string): string | readonly string[] =>
  KNOWN_BROWSERS.includes(browser.toLowerCase()) ? apps[browser.toLowerCase() as AppName] : browser;

/** Orca's CLI; on Linux a bare `orca` is usually the GNOME screen reader. */
const orcaCommand = (): string =>
  process.env.ORCA_CLI_COMMAND || (process.platform === 'linux' ? 'orca-ide' : 'orca');

/** Open `url` in a tab of Orca's built-in browser, in the workspace shown in Orca. */
const openInOrca = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(orcaCommand(), ['tab', 'create', '--url', url, '--worktree', 'active', '--json'], { timeout: 15_000 }, (err, _out, stderr) => {
      if (err === null) return resolve();
      const why = stderr.trim().split('\n').pop() || err.message;
      reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? `${orcaCommand()} command not found` : why));
    });
  });

/** Open `url` in `browser`; rejects when that browser is not installed. */
export async function launch(url: string, browser?: string): Promise<void> {
  if (browser === undefined) return void (await openBrowser(url));
  if (browser.toLowerCase() === 'orca') return openInOrca(url);
  const child = await openBrowser(url, { app: { name: browserApp(browser) } });
  // open() resolves even for a missing app, but its launcher fails at once, so give it a moment
  await new Promise<void>((resolve, reject) => {
    const done = setTimeout(resolve, 1500);
    child.once('error', (e) => (clearTimeout(done), reject(e)));
    child.once('exit', (code) => (clearTimeout(done), code ? reject(new Error(`not found (exit code ${code})`)) : resolve()));
  });
}

const defaultDeps: CliDeps = {
  open: launch,
  startServer,
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
};

const HELP = `Usage: bmad-kanban [path] [--port N] [--browser NAME] [--no-open] [--no-scripts]

Read-only Kanban board for BMAD Method projects.

  path            project folder (default: current directory)
  --port N        port to listen on (default: 4310)
  --browser NAME  browser to open: chrome, brave, firefox, edge, safari, orca or any
                  app name (default: $BMAD_KANBAN_BROWSER, else the system browser)
  --no-open       do not open a browser
  --no-scripts    never run the project's own BMAD scripts (read the files only)
  --help          show this help
  --version       show the version
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
        browser: { type: 'string' },
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
  if (!values['no-open']) {
    const browser = values.browser || process.env.BMAD_KANBAN_BROWSER || undefined;
    try {
      await d.open(url, browser);
    } catch (e) {
      d.stderr(`Could not open ${browser ?? 'a browser'}: ${(e as Error).message}. Open the address below yourself.\n`);
    }
  }
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
