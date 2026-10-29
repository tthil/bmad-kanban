import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newToken, proof, sameSecret } from './token.js';

/** The running server; the file holds its API token, so only the owner may read it. */
export interface Lock { port: number; pid: number; token: string; scripts: boolean }

export function readLock(file: string): Lock | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isInteger(v?.port) && Number.isInteger(v?.pid) && typeof v?.token === 'string' && v.token !== '') {
      return { port: v.port, pid: v.pid, token: v.token, scripts: v.scripts !== false };
    }
  } catch {
    // missing or corrupt
  }
  return null;
}

export function writeLock(file: string, lock: Lock): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true }); // a leftover tmp file would keep its old mode
  fs.writeFileSync(tmp, JSON.stringify(lock), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * The API token, kept across restarts so an open board tab reconnects to a restarted server.
 * Created on first use, readable only by the owner.
 */
export function loadToken(file: string): string {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[\w-]{32,}$/.test(t)) return t;
  } catch {
    // missing: create it below
  }
  const token = newToken();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return token;
}

/** Remove the lock only if it still belongs to `pid`. */
export function removeLock(file: string, pid: number): void {
  if (readLock(file)?.pid !== pid) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when the board on the lock's port proves it holds the lock's token; the token itself is not sent. */
async function answers(lock: Lock): Promise<boolean> {
  const nonce = randomBytes(16).toString('hex');
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/hello?nonce=${nonce}`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as { proof?: unknown };
    return res.status === 200 && typeof body.proof === 'string' && sameSecret(body.proof, proof(lock.token, nonce));
  } catch {
    return false;
  }
}

export async function findRunning(file: string): Promise<Lock | null> {
  const lock = readLock(file);
  if (!lock) return null;
  if (pidAlive(lock.pid) && (await answers(lock))) return lock;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort
  }
  return null;
}
