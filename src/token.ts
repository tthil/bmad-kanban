import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const newToken = (): string => randomBytes(32).toString('base64url');

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Constant-time string comparison. */
export const sameSecret = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

/**
 * What a board holding `token` answers to the challenge `nonce`. The CLI checks it
 * before trusting a port from the lock file, so the token is never sent to whatever
 * else might be listening there.
 */
export const proof = (token: string, nonce: string): string =>
  createHmac('sha256', token).update(`bmad-kanban:${nonce}`).digest('hex');
