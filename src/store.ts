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

/** Return the subset of ids not seen before, and record them as seen now. */
export async function filterUnseen<T extends { id: string }>(items: T[]): Promise<T[]> {
  const seen = await load();
  const now = Date.now();

  // prune expired entries so the file doesn't grow forever
  for (const [id, ts] of Object.entries(seen)) if (now - ts > TTL_MS) delete seen[id];

  const fresh = items.filter((it) => !(it.id in seen));
  for (const it of fresh) seen[it.id] = now;
  await save(seen);
  return fresh;
}
