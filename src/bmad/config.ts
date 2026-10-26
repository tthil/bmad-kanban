import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

export interface BmadConfig {
  root: string;
  outputFolder: string;
  planningArtifacts: string;
  implementationArtifacts: string;
  activeInitiative: string | null;
  version: string | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function findProjectRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    try {
      if (fs.statSync(path.join(dir, '_bmad')).isDirectory()) return dir;
    } catch {
      // not here, keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readIf(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function deepMerge(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Obj, v) : v;
  }
  return out;
}

function get(o: Obj, ...keys: string[]): unknown {
  let cur: unknown = o;
  for (const k of keys) {
    if (!isObj(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function readVersion(bmad: string): string | null {
  const text = readIf(path.join(bmad, '_config', 'manifest.yaml'));
  if (text === null) return null;
  try {
    const v = get(parseYaml(text) as Obj, 'installation', 'version');
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
  } catch {
    return null;
  }
}

export function loadBmadConfig(root: string): BmadConfig {
  const absRoot = path.resolve(root);
  const bmad = path.join(absRoot, '_bmad');

  const tomlFiles = ['config.toml', 'config.user.toml', 'custom/config.toml', 'custom/config.user.toml'];
  let merged: Obj = {};
  let anyToml = false;
  for (const f of tomlFiles) {
    const text = readIf(path.join(bmad, f));
    if (text === null) continue;
    anyToml = true;
    merged = deepMerge(merged, parseToml(text) as Obj);
  }

  let outRaw: unknown, planRaw: unknown, implRaw: unknown, initRaw: unknown;
  if (anyToml) {
    outRaw = get(merged, 'core', 'output_folder');
    initRaw = get(merged, 'core', 'active_initiative');
    planRaw = get(merged, 'modules', 'bmm', 'planning_artifacts');
    implRaw = get(merged, 'modules', 'bmm', 'implementation_artifacts');
  } else {
    let y: Obj = {};
    for (const f of ['core/config.yaml', 'bmm/config.yaml']) {
      const text = readIf(path.join(bmad, f));
      if (text === null) continue;
      const parsed = parseYaml(text);
      if (isObj(parsed)) y = deepMerge(y, parsed);
    }
    outRaw = y.output_folder;
    initRaw = y.active_initiative;
    planRaw = y.planning_artifacts;
    implRaw = y.implementation_artifacts;
  }

  const resolve = (v: unknown, fallback: string): string => {
    const s = str(v);
    return s === null ? fallback : path.resolve(absRoot, s.split('{project-root}').join(absRoot));
  };

  const outputFolder = resolve(outRaw, path.join(absRoot, '_bmad-output'));
  return {
    root: absRoot,
    outputFolder,
    planningArtifacts: resolve(planRaw, path.join(outputFolder, 'planning-artifacts')),
    implementationArtifacts: resolve(implRaw, path.join(outputFolder, 'implementation-artifacts')),
    activeInitiative: str(initRaw),
    version: readVersion(bmad),
  };
}
