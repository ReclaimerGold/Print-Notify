import { readFile } from 'node:fs/promises';
import { writeJson } from './jsonFile.js';

const FILE = 'data/seen.json';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // forget ids after 7 days

type Seen = Record<string, number>;

async function load(): Promise<Seen> {
  try {
    return JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function save(seen: Seen): Promise<void> {
  await writeJson(FILE, seen);
}

/** The subset of items not seen before. Records nothing: see markSeen. */
export async function filterUnseen<T extends { id: string }>(items: T[]): Promise<T[]> {
  const seen = await load();
  return items.filter((it) => !(it.id in seen));
}

/**
 * Record items as handled. Call this only once they've printed (or been safely
 * held), so a failed print is retried on the next poll instead of lost.
 */
export async function markSeen(items: { id: string }[]): Promise<void> {
  const seen = await load();
  const now = Date.now();

  // prune expired entries so the file doesn't grow forever
  for (const [id, ts] of Object.entries(seen)) if (now - ts > TTL_MS) delete seen[id];

  for (const it of items) seen[it.id] = now;
  await save(seen);
}
