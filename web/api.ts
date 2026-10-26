import type { Board, ProjectPrefs, ProjectSummary, StoryDetail } from '../src/model.js';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const enc = encodeURIComponent;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') msg = body.error;
    } catch {
      // keep the status text
    }
    throw new ApiError(res.status, msg);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const send = (method: string, body: unknown): RequestInit => ({ method, headers: JSON_HEADERS, body: JSON.stringify(body) });

export const api = {
  projects: () => request<ProjectSummary[]>('/api/projects'),
  addProject: (path: string) => request<ProjectSummary>('/api/projects', send('POST', { path })),
  removeProject: (id: string) => request<void>(`/api/projects/${enc(id)}`, { method: 'DELETE' }),
  setPrefs: (id: string, prefs: Partial<ProjectPrefs>) => request<void>(`/api/projects/${enc(id)}/prefs`, send('PUT', prefs)),
  board: (id: string, sourceId: string) => request<Board>(`/api/projects/${enc(id)}/boards/${enc(sourceId)}`),
  story: (id: string, sourceId: string, key: string) =>
    request<StoryDetail>(`/api/projects/${enc(id)}/boards/${enc(sourceId)}/stories/${enc(key)}`),
  state: () => request<{ lastViewed: string | null }>('/api/state'),
  setLastViewed: (lastViewed: string) => request<void>('/api/state', send('PUT', { lastViewed })),
};
