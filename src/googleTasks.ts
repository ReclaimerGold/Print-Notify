// Minimal Google Tasks API client. Uses an OAuth refresh token (obtained once via
// `npm run google-auth`) to mint short-lived access tokens, then reads task lists
// and (for the dashboard's two-way sync) patches task completion status.
// Read-write scope: https://www.googleapis.com/auth/tasks
// (Reads keep working under the old .../tasks.readonly token; writes need re-auth.)
import { config } from './config.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://tasks.googleapis.com/tasks/v1';

let cached: { token: string; exp: number } | undefined;

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.exp > now + 60_000) return cached.token;

  const { clientId, clientSecret, refreshToken } = config.sources.googleTasks;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Google token ${res.status}: ${await res.text()}`);
  const j: any = await res.json();
  cached = { token: j.access_token, exp: now + (j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    // Surface Google's actual reason (e.g. "Tasks API not enabled", scope issues).
    let detail = '';
    try {
      const body: any = await res.json();
      detail = body?.error?.message ? ` — ${body.error.message}` : '';
    } catch {
      /* non-JSON body */
    }
    throw new Error(`Google Tasks ${res.status} on ${path}${detail}`);
  }
  return res.json();
}

export interface TaskList { id: string; title: string; }
export interface Task { id: string; title: string; status: string; due?: string; position?: string; }

export async function listTaskLists(): Promise<TaskList[]> {
  const j = await api('/users/@me/lists?maxResults=100');
  return j.items ?? [];
}

/**
 * Mark a task done (or reopen it) — the dashboard's two-way sync. Setting
 * `completed:null` when reopening clears Google's completion timestamp reliably.
 * Requires the read-write scope (see file header); a read-only token 403s here.
 */
export async function setTaskCompleted(listId: string, taskId: string, completed: boolean): Promise<void> {
  await api(`/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: completed ? 'completed' : 'needsAction',
      completed: completed ? new Date().toISOString() : null,
    }),
  });
}

/**
 * Add a new task to a list (the dashboard's "add item" box). Requires the
 * read-write scope (see file header); a read-only token 403s here. Returns the
 * created task so the caller can build its NotificationItem id.
 */
export async function insertTask(listId: string, title: string): Promise<Task> {
  return api(`/lists/${encodeURIComponent(listId)}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
}

export async function listTasks(listId: string, showCompleted: boolean): Promise<Task[]> {
  const params = new URLSearchParams({
    maxResults: '100',
    showCompleted: String(showCompleted),
    showHidden: String(showCompleted),
  });
  const j = await api(`/lists/${listId}/tasks?${params}`);
  const items: Task[] = j.items ?? [];
  // Open tasks first (by list position), then completed.
  return items
    .filter((t) => t.title && t.title.trim())
    .sort((a, b) => {
      const rank = (t: Task) => (t.status === 'completed' ? 1 : 0);
      return rank(a) - rank(b) || (a.position ?? '').localeCompare(b.position ?? '');
    });
}
