import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { loadBmadConfig, type BmadConfig } from '../bmad/config.js';

export type Unwatch = (() => void) & { ready: Promise<void> };

const IGNORED = /(^|[\\/])(\.git|node_modules)([\\/]|$)/;

function configOf(root: string): BmadConfig {
  try {
    return loadBmadConfig(root);
  } catch {
    const out = path.join(root, '_bmad-output');
    return {
      root, outputFolder: out,
      planningArtifacts: path.join(out, 'planning-artifacts'),
      implementationArtifacts: path.join(out, 'implementation-artifacts'),
      activeInitiative: null, version: null,
    };
  }
}

/** Folders watched recursively: `_bmad` plus the configured output/planning/implementation folders. */
function targetsOf(root: string, cfg: BmadConfig): string[] {
  const list = [path.join(root, '_bmad'), cfg.outputFolder, cfg.planningArtifacts, cfg.implementationArtifacts];
  return [...new Set(list.map((p) => path.resolve(p)))].sort();
}

const within = (base: string, p: string): boolean => p === base || p.startsWith(base + path.sep);

/**
 * Watch a project: its root at depth 0 plus `_bmad` and the configured folders (recursively), even
 * before they exist. A change to `_bmad` re-reads the config and re-targets the watcher when the
 * configured folders moved. `onChange` fires once per debounced burst (300 ms).
 */
export function watchProject(projectRoot: string, onChange: () => void): Unwatch {
  const root = path.resolve(projectRoot);
  let targets = targetsOf(root, configOf(root));
  let watcher: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  // Decides from paths alone, relative to the project root (or to an outside target), so a project
  // living under some node_modules/.git directory still gets its events.
  const ignored = (p: string): boolean => {
    const abs = path.resolve(p);
    if (within(root, abs)) {
      const rel = path.relative(root, abs);
      if (rel === '') return false;
      if (IGNORED.test(rel)) return true;
      if (!rel.includes(path.sep)) return false; // depth 0 of the root
      return !targets.some((t) => within(t, abs) || within(abs, t));
    }
    const t = targets.find((x) => within(x, abs) || within(abs, x));
    return t === undefined || (within(t, abs) && IGNORED.test(path.relative(t, abs)));
  };

  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (closed) return;
      const next = targetsOf(root, configOf(root));
      if (next.join('\0') !== targets.join('\0')) {
        targets = next;
        void start();
      }
      onChange();
    }, 300);
  };

  const start = (): Promise<void> => {
    const old = watcher;
    if (old) void old.close();
    if (closed || !fs.existsSync(root)) return Promise.resolve();
    const outside = targets.filter((t) => !within(root, t) && fs.existsSync(t));
    const w = chokidar.watch([root, ...outside], {
      ignoreInitial: true,
      ignored,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    watcher = w;
    w.on('all', fire);
    w.on('error', (e) => console.error('watch error:', e));
    return new Promise<void>((resolve) => w.once('ready', () => resolve()));
  };

  const ready = start();
  const stop = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (watcher) void watcher.close();
    watcher = null;
  };
  return Object.assign(stop, { ready });
}
