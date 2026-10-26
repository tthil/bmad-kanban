import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findProjectRoot, loadBmadConfig } from '../src/bmad/config.js';

const fx = (n: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', n);

describe('loadBmadConfig', () => {
  it('reads v6 toml + manifest version', () => {
    const r = fx('v6-sprint');
    const c = loadBmadConfig(r);
    expect(c.root).toBe(r);
    expect(c.outputFolder).toBe(path.join(r, '_bmad-output'));
    expect(c.implementationArtifacts).toBe(path.join(r, '_bmad-output', 'implementation-artifacts'));
    expect(c.version).toBe('6.12.4');
    expect(c.activeInitiative).toBeNull();
  });
  it('falls back to yaml configs with defaults', () => {
    const r = fx('v6-yaml');
    const c = loadBmadConfig(r);
    expect(c.outputFolder).toBe(path.join(r, 'out'));
    expect(c.implementationArtifacts).toBe(path.join(r, 'out', 'impl'));
    expect(c.planningArtifacts).toBe(path.join(r, 'out', 'planning-artifacts'));
    expect(c.version).toBeNull();
  });
  it('merges custom toml over base', () => {
    const r = fx('v7');
    const c = loadBmadConfig(r);
    expect(c.outputFolder).toBe(path.join(r, 'store'));
    expect(c.activeInitiative).toBe('initiative-checkout');
  });
});

describe('findProjectRoot', () => {
  it('finds nearest ancestor with _bmad', () => {
    const r = fx('v6-sprint');
    expect(findProjectRoot(path.join(r, '_bmad-output', 'x'))).toBe(r);
    expect(findProjectRoot(r)).toBe(r);
  });
  it('returns null when none', () => {
    expect(findProjectRoot(path.parse(process.cwd()).root)).toBeNull();
  });
});
