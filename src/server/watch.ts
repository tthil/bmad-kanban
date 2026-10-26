import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import type { BmadConfig } from '../bmad/config.js';

export type Unwatch = (() => void) & { ready: Promise<void> };

const IGNORED = /(^|[\\/])(\.git|node_modules)([\\/]|$)/;

/** Watch a project's BMAD folders; `onChange` fires once per debounced burst (300 ms). */
export function watchProject(root: string, cfg: BmadConfig, onChange: () => void): Unwatch {
  const candidates = [
    cfg.outputFolder,
    cfg.planningArtifacts,
    cfg.implementationArtifacts,
    path.join(root, '_bmad', 'custom'),
  ];
  const targets = [...new Set(candidates)].filter((p) => fs.existsSync(p));
  const watcher = chokidar.watch(targets, {
    ignoreInitial: true,
    ignored: (p) => IGNORED.test(p),
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!closed) onChange();
    }, 300);
  };
  watcher.on('all', fire);
  watcher.on('error', (e) => console.error('watch error:', e));
  const ready = new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  const stop = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    void watcher.close();
  };
  return Object.assign(stop, { ready });
}
