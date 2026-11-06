import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJson, writeJsonSync } from '../src/jsonFile.js';

const dir = mkdtempSync(join(tmpdir(), 'print-notify-json-'));

test('writeJson creates a missing directory (a fresh checkout has no data/)', async () => {
  const file = join(dir, 'a', 'b', 'state.json');
  await writeJson(file, { ok: true });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ok: true });
});

test('writeJsonSync creates a missing directory and leaves no temp files', () => {
  const sub = join(dir, 'sync');
  writeJsonSync(join(sub, 'state.json'), [1, 2]);
  assert.deepEqual(readdirSync(sub), ['state.json']);
});

test('the seed tables the app reads at import are tracked by git', async () => {
  const { execFileSync } = await import('node:child_process');
  const tracked = execFileSync('git', ['ls-files', 'data'], { encoding: 'utf8' }).trim().split('\n');
  for (const f of ['grocery-prices', 'food-categories', 'region-multipliers']) {
    assert.ok(tracked.includes(`data/${f}.json`), `${f}.json must be committed`);
  }
});
