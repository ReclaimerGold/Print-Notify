// Local SQLite cache for live grocery prices. Each grocery item is reduced to a
// conservative canonical key (so "2% Milk", "Milk", and "Milk (1 gal)" all share
// one entry); a fresh entry serves the price without hitting the search provider.
// On a miss or an expired entry the caller runs one search and caches the result
// for `cacheDays`. A `search_log` table enforces the provider budget (per-hour
// and rolling-30-day) so we never overrun a free-plan quota.
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = resolve(HERE, '..', '..', 'data');
// Override with PRICE_DB_PATH (used by tests to isolate from the real cache).
const dbPath = () => process.env.PRICE_DB_PATH || join(DATA_DIR, 'prices.db');

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MONTH_MS = 30 * DAY_MS; // rolling window backing the "monthly" budget
// A search that finds no usable price is cached briefly so an unmatchable item
// (e.g. a typo) doesn't burn a quota slot on every digest.
const NEGATIVE_TTL_MS = 7 * DAY_MS;

/** Round to whole cents. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface CachedPrice {
  price: number;
  title: string | null;
  merchant: string | null;
  source: 'cache' | 'live';
}

/** The result of a live price lookup, cached by the DB. */
export interface SearchResult {
  price: number;
  title?: string | null;
  merchant?: string | null;
}
/**
 * Resolves null when the provider answered and has no price. Throws when it could
 * not answer (network, quota, outage): that says nothing about the item, so it must
 * not be cached as "no price".
 */
export type SearchFn = (query: string) => Promise<SearchResult | null>;

interface CacheRow {
  price: number | null;
  title: string | null;
  merchant: string | null;
  expires_at: number;
}

interface Stmts {
  get: Database.Statement;
  upsert: Database.Statement;
  logSearch: Database.Statement;
  countSince: Database.Statement;
}

let db: Database.Database | null = null;
let stmts: Stmts | null = null;

function getDb(): Stmts {
  if (stmts) return stmts;
  const path = dbPath();
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_cache (
      key        TEXT PRIMARY KEY,
      query      TEXT NOT NULL,
      price      REAL,              -- NULL = searched but no usable price (negative cache)
      title      TEXT,
      merchant   TEXT,
      fetched_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_log (ts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_search_log_ts ON search_log(ts);
  `);
  // Drop log rows outside the budget window once, at open (not per lookup).
  db.prepare('DELETE FROM search_log WHERE ts < ?').run(Date.now() - MONTH_MS);
  stmts = {
    get: db.prepare('SELECT price, title, merchant, expires_at FROM price_cache WHERE key = ?'),
    upsert: db.prepare(
      `INSERT INTO price_cache (key, query, price, title, merchant, fetched_at, expires_at)
       VALUES (@key, @query, @price, @title, @merchant, @now, @expires)
       ON CONFLICT(key) DO UPDATE SET
         query=@query, price=@price, title=@title, merchant=@merchant, fetched_at=@now, expires_at=@expires`,
    ),
    logSearch: db.prepare('INSERT INTO search_log (ts) VALUES (?)'),
    countSince: db.prepare('SELECT COUNT(*) AS n FROM search_log WHERE ts >= ?'),
  };
  return stmts;
}

const STOP = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'for', 'to']);
const SIZE_UNIT =
  /\b\d+(\.\d+)?\s*(oz|ounce|ounces|lb|lbs|pound|pounds|g|kg|ml|l|liter|litre|litres|liters|gal|gallon|gallons|qt|quart|quarts|pt|pint|pints|ct|count|pk|pack|packs|dozen|dz)\b/g;

/** Reduce a free-text item title to a stable cache key by stripping sizes,
 *  quantities, percentages, punctuation and filler words. Deliberately
 *  conservative: it merges obvious duplicates but keeps distinct foods apart
 *  (e.g. "apple" vs "apple juice"), so a missed merge only costs one search —
 *  never a wrong price. Returns '' when nothing meaningful remains. */
export function canonicalize(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')            // drop "(1 gal)" etc.
    .replace(/\b\d+(\.\d+)?\s*%/g, ' ')     // "2%", "2 %"
    .replace(SIZE_UNIT, ' ')               // "1 gal", "16 oz", "12 pack"
    .replace(/[^a-z\s]/g, ' ')             // strip leftover digits/punctuation
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .join(' ')
    .trim();
}

/** Count of searches logged since `since` (ms epoch). */
function countSince(s: Stmts, since: number): number {
  return (s.countSince.get(since) as { n: number }).n;
}

/** True if another search is allowed under both the hourly and rolling-30-day caps. */
function withinBudget(s: Stmts, now: number, hourlyLimit: number, monthlyLimit: number): boolean {
  return countSince(s, now - HOUR_MS) < hourlyLimit && countSince(s, now - MONTH_MS) < monthlyLimit;
}

/**
 * Look up a fresh cached price for `query`, or run the `searches` providers in
 * order on a miss/expiry and cache the first hit. Providers are tried until one
 * returns a price (e.g. Walmart first, then Google Shopping) — each real search
 * consumes one budget slot, so the fallback is quota-accurate. Returns the price,
 * or `null` when none is available — because the item has no meaningful name, the
 * budget is spent (no search run), every provider found nothing, or it was
 * recently negative-cached. `null` means the caller should fall back to the seed
 * table.
 *
 * The negative cache is written only when at least one provider ran, every one that
 * ran gave a real answer, AND the budget did not cut the list short — so an item
 * that merely hit an outage or the quota retries next time instead of being poisoned
 * for the negative-cache window.
 */
export async function cachedPrice(
  query: string,
  opts: { searches: SearchFn[]; now: number; cacheDays: number; hourlyLimit: number; monthlyLimit: number },
): Promise<CachedPrice | null> {
  const key = canonicalize(query);
  if (!key) return null;
  const s = getDb();

  const row = s.get.get(key) as CacheRow | undefined;
  if (row && row.expires_at > opts.now) {
    return row.price == null ? null : { price: row.price, title: row.title, merchant: row.merchant, source: 'cache' };
  }

  // Miss or expired — try each provider in order until one returns a price.
  let found: SearchResult | null = null;
  let ranAny = false;
  let stoppedByBudget = false;
  let failed = false;
  for (const search of opts.searches) {
    if (!withinBudget(s, opts.now, opts.hourlyLimit, opts.monthlyLimit)) {
      stoppedByBudget = true;
      break;
    }
    ranAny = true;
    s.logSearch.run(opts.now);
    try {
      found = await search(query);
    } catch (e) {
      failed = true; // try the next provider, but this miss proves nothing
      console.warn(`[prices] search failed for "${query}":`, (e as Error)?.message ?? e);
    }
    if (found) break; // first provider with a price wins
  }

  if (found) {
    s.upsert.run({
      key, query,
      price: found.price, title: found.title ?? null, merchant: found.merchant ?? null,
      now: opts.now, expires: opts.now + opts.cacheDays * DAY_MS,
    });
    return { price: found.price, title: found.title ?? null, merchant: found.merchant ?? null, source: 'live' };
  }

  // No price. Negative-cache only if every provider truly answered within budget;
  // otherwise leave it uncached to retry.
  if (ranAny && !stoppedByBudget && !failed) {
    s.upsert.run({
      key, query, price: null, title: null, merchant: null,
      now: opts.now, expires: opts.now + NEGATIVE_TTL_MS,
    });
  }
  return null;
}

/** Search counts for the current hour / 30-day window (for status + tests). */
export function budgetUsage(now: number): { lastHour: number; last30Days: number } {
  const s = getDb();
  return { lastHour: countSince(s, now - HOUR_MS), last30Days: countSince(s, now - MONTH_MS) };
}

/** Close the DB (used by tests to reset between runs). */
export function closeDb(): void {
  db?.close();
  db = null;
  stmts = null;
}
