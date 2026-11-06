import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.chdir(mkdtempSync(join(tmpdir(), 'print-notify-store-')));
const { filterUnseen, markSeen } = await import('../src/store.js');

const FILE = 'data/seen.json';
beforeEach(() => {
  rmSync('data', { recursive: true, force: true });
  mkdirSync('data');
});

test('checking records nothing; only markSeen does', async () => {
  const a = { id: 'a' };
  assert.deepEqual(await filterUnseen([a]), [a]);
  assert.deepEqual(await filterUnseen([a]), [a]);
  await markSeen([a]);
  assert.deepEqual(await filterUnseen([a, { id: 'b' }]), [{ id: 'b' }]);
});

test('entries past the 7 day TTL are pruned', async () => {
  writeFileSync(FILE, JSON.stringify({ old: Date.now() - 8 * 86_400_000, recent: Date.now() - 86_400_000 }));
  await markSeen([{ id: 'new' }]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(FILE, 'utf8'))).sort(), ['new', 'recent']);
});

test('an unreadable file reads as empty rather than throwing', async () => {
  writeFileSync(FILE, '{nope');
  assert.deepEqual(await filterUnseen([{ id: 'a' }]), [{ id: 'a' }]);
});
