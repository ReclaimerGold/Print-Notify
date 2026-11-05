import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Block } from '../src/digest.js';

// Isolate from the real queue, and never touch the printer.
const home = mkdtempSync(join(tmpdir(), 'print-notify-queue-'));
process.chdir(home);
process.env.PRINTER_DRY_RUN = 'true';

const { submit, flush, clearQueue, queueStatus, setRenderer } = await import('../src/printQueue.js');

const FILE = 'data/print-queue.json';
const text = (t: string): Block[] => [{ type: 'text', text: t }];
const held = (id: string, blocks: Block[] = text(id)) =>
  ({ id, label: id, blocks, queuedAt: Date.now(), attempts: 1 });
const seed = (...jobs: unknown[]) => {
  mkdirSync('data', { recursive: true });
  writeFileSync(FILE, JSON.stringify(jobs));
};
const queue = () => JSON.parse(readFileSync(FILE, 'utf8')) as { id: string; label: string; blocks: Block[] }[];
const textOf = (blocks: Block[]) => (blocks[0] as { text: string }).text;

let printed: string[];
let failing: boolean;

beforeEach(() => {
  rmSync('data', { recursive: true, force: true });
  printed = [];
  failing = false;
  setRenderer(async (blocks) => {
    if (failing) throw new Error('lp exited 1');
    printed.push(textOf(blocks));
  });
});

test('overlapping flushes print a held job exactly once', async () => {
  seed(held('A'));
  await Promise.all([flush(), flush(), flush()]);
  assert.deepEqual(printed, ['A']);
});

test('a job held while a flush is printing is not overwritten', async () => {
  seed(held('A'));
  let finishA = () => {};
  const aPrinting = new Promise<void>((r) => { finishA = r; });
  let bFailed = () => {};
  const bHolding = new Promise<void>((r) => { bFailed = r; });
  setRenderer(async (blocks) => {
    if (textOf(blocks) === 'B') {
      bFailed();
      throw new Error('lp exited 1'); // B gets held
    }
    await aPrinting;
    printed.push(textOf(blocks));
  });

  const flushing = flush();
  const submitting = submit('B', text('B'));
  await bHolding; // the printer health check has run and B is on its way to disk
  await new Promise((r) => setTimeout(r, 50)); // give B's write every chance to land
  finishA();
  await Promise.all([flushing, submitting]);

  assert.deepEqual(printed, ['A']);
  assert.deepEqual(queue().map((j) => j.label), ['B']);
});

test('progress is saved per job, so a crash mid-backlog never reprints', async () => {
  seed(held('A'), held('B'));
  let onDiskDuringB: string[] = [];
  setRenderer(async (blocks) => {
    if (textOf(blocks) === 'B') onDiskDuringB = queue().map((j) => j.id);
  });
  await flush();
  assert.deepEqual(onDiskDuringB, ['B'], 'A was already recorded as printed');
});

test('a held job keeps its own image copies, so losing the cache is harmless', async () => {
  const cached = join(home, 'cache.png');
  writeFileSync(cached, 'png');
  failing = true;
  await submit('Digest', [{ type: 'image', path: cached }]);
  rmSync(cached); // what a reboot does to the temp-dir bitmap cache

  failing = false;
  const paths: string[] = [];
  setRenderer(async (blocks) => {
    for (const b of blocks) if (b.type === 'image') { assert.ok(existsSync(b.path)); paths.push(b.path); }
  });
  await flush();
  assert.equal(paths.length, 1);
  assert.equal(queue().length, 0);
  assert.equal(existsSync('data/held') ? readdirSync('data/held').length : 0, 0, 'copies are cleaned up');
});

test('a job with a lost image is dropped and cannot block the jobs behind it', async () => {
  seed(held('poison', [{ type: 'image', path: join(home, 'gone.png') }]), held('good'));
  await flush();
  assert.deepEqual(printed, ['good']);
  assert.equal(queue().length, 0);
});

test('an unreadable queue file is set aside rather than silently overwritten', async () => {
  mkdirSync('data', { recursive: true });
  writeFileSync(FILE, '[{"id":"trunc');
  assert.deepEqual((await queueStatus()).held, []);
  assert.ok(readdirSync('data').some((f) => f.includes('.corrupt-')));
});

test('clearing the queue also removes the held image copies', async () => {
  const cached = join(home, 'c2.png');
  writeFileSync(cached, 'png');
  failing = true;
  await submit('Digest', [{ type: 'image', path: cached }]);
  assert.equal(await clearQueue(), 1);
  assert.equal(readdirSync('data/held').length, 0);
});
