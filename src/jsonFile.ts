// Crash-safe JSON persistence. Writing straight to the target means a crash or
// power cut mid-write leaves truncated JSON behind — and every loader here treats
// unparseable state as "nothing saved". Writing a sibling temp file and renaming
// it over the target is atomic on the same filesystem, so a reader sees the old
// file or the new one, never half of either.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

let seq = 0;
const tempPath = (path: string) => `${path}.${process.pid}.${seq++}.tmp`;

export async function writeJson(path: string, value: unknown, indent?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = tempPath(path);
  await writeFile(tmp, JSON.stringify(value, null, indent));
  await rename(tmp, path);
}

export function writeJsonSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPath(path);
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}
