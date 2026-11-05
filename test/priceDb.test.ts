import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// priceDb resolves its default path from the source tree, not the working
// directory, so the database has to be redirected explicitly.
process.chdir(mkdtempSync(join(tmpdir(), 'print-notify-prices-')));
process.env.PRICE_DB_PATH = join(process.cwd(), 'data', 'prices.db');

const { cachedPrice, closeDb } = await import('../src/prices/priceDb.js');
const { makeWalmartSearch } = await import('../src/prices/walmart.js');
const { makeSerpApiSearch } = await import('../src/prices/serpapi.js');
type Search = Parameters<typeof cachedPrice>[1]['searches'][number];

const realFetch = globalThis.fetch;
const realWarn = console.warn;
beforeEach(() => {
  closeDb();
  rmSync('data', { recursive: true, force: true });
  console.warn = () => {};
});
test.after(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  closeDb();
});

const opts = (searches: Search[]) => ({ searches, now: 1_000_000, cacheDays: 7, hourlyLimit: 100, monthlyLimit: 1000 });
const counted = (fn: Search) => {
  const search: Search & { calls?: number } = (q) => { search.calls = (search.calls ?? 0) + 1; return fn(q); };
  return search;
};
const reply = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
};

test('a real "no results" is cached, so it is not searched again', async () => {
  const none = counted(async () => null);
  assert.equal(await cachedPrice('dragonfruit', opts([none])), null);
  assert.equal(await cachedPrice('dragonfruit', opts([none])), null);
  assert.equal(none.calls, 1);
});

test('an outage is not cached as "no price"', async () => {
  const down = counted(async () => { throw new Error('503'); });
  assert.equal(await cachedPrice('dragonfruit', opts([down])), null);

  const up = counted(async () => ({ price: 3.5 }));
  assert.equal((await cachedPrice('dragonfruit', opts([up])))?.price, 3.5);
  assert.equal(up.calls, 1);
});

test('one provider failing still tries the next, and blocks caching if that misses', async () => {
  const down = counted(async () => { throw new Error('503'); });
  const none = counted(async () => null);
  assert.equal(await cachedPrice('dragonfruit', opts([down, none])), null);
  assert.equal(none.calls, 1);

  const up = counted(async () => ({ price: 2 }));
  assert.equal((await cachedPrice('dragonfruit', opts([up])))?.price, 2);
});

for (const [name, make] of [
  ['walmart', () => makeWalmartSearch('key')],
  ['google shopping', () => makeSerpApiSearch('key')],
] as const) {
  test(`${name}: failures throw, an empty answer is null`, async () => {
    reply(503, {});
    await assert.rejects(make()('milk'), /503/);
    reply(200, { error: 'Your account has run out of searches.' });
    await assert.rejects(make()('milk'), /run out/);
    reply(200, { error: "Google hasn't returned any results for this query." });
    assert.equal(await make()('milk'), null);
    reply(200, {});
    assert.equal(await make()('milk'), null);
  });
}
