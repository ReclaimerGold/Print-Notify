// A tiny snapshot helper.
//
// Node's built-in snapshot support is still experimental on the Node 20 floor
// this project targets, so this does the small part we need: serialize, compare
// against a committed file, and rewrite it when SNAPSHOT_UPDATE=1.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '__snapshots__');

/**
 * Compare `value` against the stored snapshot for `name`, or write it when
 * SNAPSHOT_UPDATE=1 (or when no snapshot exists yet).
 */
export function matchSnapshot(name: string, value: unknown): void {
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, `${name}.json`);
  const actual = `${JSON.stringify(value, null, 2)}\n`;

  if (process.env.SNAPSHOT_UPDATE === '1' || !existsSync(file)) {
    writeFileSync(file, actual);
    return;
  }
  const expected = readFileSync(file, 'utf8');
  assert.equal(
    actual,
    expected,
    `Snapshot "${name}" differs. If the change is intended, re-run with SNAPSHOT_UPDATE=1.`,
  );
}
