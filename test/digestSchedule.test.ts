import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.chdir(mkdtempSync(join(tmpdir(), 'print-notify-schedule-')));
process.env.PRINTER_DRY_RUN = 'true';
process.env.NEWS_ENABLED = 'false';
process.env.TZ_NAME = 'America/Chicago';
process.env.MORNING_DIGEST_CRON = '0 7 * * *';
process.env.EVENING_DIGEST_CRON = '0 18 * * *';
process.env.DIGEST_CATCHUP_HOURS = '3';

const { catchUpDigest, runDigest, state, withRetry } = await import('../src/scheduler.js');

const quiet = { error: console.error, log: console.log };
beforeEach(() => {
  rmSync('data', { recursive: true, force: true });
  mkdirSync('data');
  delete state.lastDigest;
  delete state.lastEvening;
  console.error = () => {};
  console.log = () => {};
});
test.after(() => Object.assign(console, quiet));

const at = (s: string) => Date.parse(s);
const saved = (s: object) => writeFileSync('data/run-state.json', JSON.stringify(s));
const WEEK_AGO = '2026-08-05T12:00:00.000Z';
const counter = () => {
  const run = async () => { run.calls++; };
  run.calls = 0;
  return run;
};

test('a morning digest missed within the window prints on startup', async () => {
  saved({ since: 0, lastDigest: WEEK_AGO, lastEvening: WEEK_AGO });
  const morning = counter();
  const evening = counter();
  assert.equal(await catchUpDigest(at('2026-08-12T14:00:00Z'), morning, evening), 'Morning Digest'); // 9am CDT
  assert.deepEqual([morning.calls, evening.calls], [1, 0]);
});

test('one already handled is not printed again', async () => {
  saved({ since: 0, lastDigest: '2026-08-12T12:00:05.000Z' });
  const morning = counter();
  assert.equal(await catchUpDigest(at('2026-08-12T14:00:00Z'), morning, counter()), undefined);
  assert.equal(morning.calls, 0);
});

test('a digest outside the window stays missed', async () => {
  saved({ since: 0, lastDigest: WEEK_AGO, lastEvening: WEEK_AGO });
  const morning = counter();
  assert.equal(await catchUpDigest(at('2026-08-12T19:00:00Z'), morning, counter()), undefined); // 2pm CDT
  assert.equal(morning.calls, 0);
});

test('with no history, the first start prints nothing and later misses count', async () => {
  const morning = counter();
  assert.equal(await catchUpDigest(at('2026-08-12T14:00:00Z'), morning, counter()), undefined);
  assert.equal(morning.calls, 0);
  assert.equal(await catchUpDigest(at('2026-08-12T15:00:00Z'), morning, counter()), undefined); // same 7am
  assert.equal(morning.calls, 0);
  assert.equal(await catchUpDigest(at('2026-08-13T13:00:00Z'), morning, counter()), 'Morning Digest');
  assert.equal(morning.calls, 1);
});

test('a real digest run is remembered across restarts', async () => {
  await runDigest('Morning Digest');
  const file = JSON.parse(readFileSync('data/run-state.json', 'utf8'));
  assert.equal(file.lastDigest, state.lastDigest);
  assert.ok(file.lastDigest);
});

test('a digest that throws retries, then succeeds', async () => {
  let calls = 0;
  const waits: number[] = [];
  await withRetry('t', async () => { if (++calls < 3) throw new Error('render'); }, [10, 20], async (ms) => { waits.push(ms); });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);
});

test('a digest that keeps throwing gives up and records why', async () => {
  let calls = 0;
  await withRetry('t', async () => { calls++; throw new Error('render'); }, [1], async () => {});
  assert.equal(calls, 2);
  assert.match(state.lastError ?? '', /render/);
});
