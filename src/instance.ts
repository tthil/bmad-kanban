import fs from 'node:fs';
import path from 'node:path';

export interface Lock { port: number; pid: number }

export function readLock(file: string): Lock | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isInteger(v?.port) && Number.isInteger(v?.pid)) return { port: v.port, pid: v.pid };
  } catch {
    // missing or corrupt
  }
  return null;
}

export function writeLock(file: string, lock: Lock): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock));
  fs.renameSync(tmp, file);
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

async function answers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1000) });
    await res.arrayBuffer();
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function findRunning(file: string): Promise<number | null> {
  const lock = readLock(file);
  if (!lock) return null;
  if (pidAlive(lock.pid) && (await answers(lock.port))) return lock.port;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort
  }
  return null;
}
