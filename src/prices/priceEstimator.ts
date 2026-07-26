// Estimate a per-item price for each grocery item. Live prices come from SerpAPI
// (Google Shopping), localized to the reverse-geocoded city and cached 30 days in
// a local SQLite db (see priceDb.ts). When there's no SerpAPI key, the budget is
// spent, or a search finds nothing, it falls back to a bundled region-adjusted
// seed table (data/grocery-prices.json) whose food staples come from BLS Average
// Price Data (refresh with `npm run refresh-prices`). Printed values are prefixed
// "~" and captioned "Est." to read as approximate.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { resolveLocation } from './geocode.js';
import { cachedPrice, round2, DATA_DIR } from './priceDb.js';
import { makeSerpApiSearch } from './serpapi.js';
import { makeWalmartSearch } from './walmart.js';
import type { SearchFn } from './priceDb.js';
import type { NotificationItem } from '../sources/types.js';

interface SeedTable {
  categories: Record<string, { price: number; unit: string }>;
}
const SEED = JSON.parse(readFileSync(join(DATA_DIR, 'grocery-prices.json'), 'utf8')) as SeedTable;
const CATS = JSON.parse(readFileSync(join(DATA_DIR, 'food-categories.json'), 'utf8')) as Record<string, unknown>;
const MULT = JSON.parse(readFileSync(join(DATA_DIR, 'region-multipliers.json'), 'utf8')) as Record<string, number>;

// Which Google Tasks list counts as groceries (matches config.sources.googleTasks.lists).
const GROCERY_SOURCE = 'groceries';

/** Word-boundary matcher for a keyword. Anchored with \b so it only matches at
 *  the start of a word (still prefix-matching, e.g. "strawberr" → "strawberries")
 *  — this prevents substring false positives like "toilet" matching "oil",
 *  "aluminum foil" matching "oil", or "steak" matching "tea". */
function wordMatcher(kw: string): RegExp {
  return new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

// Precompiled category → keyword matchers, in file order (first match wins).
const CATEGORY_MATCHERS: { cat: string; res: RegExp[] }[] = Object.entries(CATS)
  .filter(([, kws]) => Array.isArray(kws)) // skip _comment and other metadata
  .map(([cat, kws]) => ({ cat, res: (kws as string[]).map(wordMatcher) }));

/** Classify a free-text grocery title to a price category, or null if unknown.
 *  Iterates categories in file order; the first keyword word-match wins. */
function classify(title: string): string | null {
  const t = title.toLowerCase();
  for (const { cat, res } of CATEGORY_MATCHERS) {
    if (res.some((re) => re.test(t))) return cat;
  }
  return null;
}

/** Regionalized seed price for an item, or undefined if it isn't categorized. */
function seedPrice(title: string, mult: number): number | undefined {
  const cat = classify(title);
  const base = cat ? SEED.categories[cat]?.price : undefined;
  return base === undefined ? undefined : round2(base * mult);
}

export interface PricingResult {
  city: string;
  region: string;
  pricedCount: number;
  itemCount: number;
  total: number;
}

/**
 * Estimate a per-item price for each grocery item (source === "groceries"),
 * writing `item.price` in place. Live SerpAPI prices (cached) take precedence;
 * the seed table fills in when there's no key, the budget is spent, or a search
 * finds nothing. Returns a summary, or `null` when pricing is disabled, there are
 * no groceries, or coordinates are missing. Network/geocode errors propagate to
 * the caller, which treats pricing as best-effort.
 */
export async function priceGroceries(items: NotificationItem[]): Promise<PricingResult | null> {
  if (!config.groceryPrices.enabled) return null;
  const groceries = items.filter((i) => i.source.toLowerCase() === GROCERY_SOURCE);
  if (groceries.length === 0) return null;

  const { lat, lon } = config.sources.weather;
  if (!lat || !lon) return null; // need coordinates to find the nearest city

  const loc = await resolveLocation();
  const mult = MULT[loc.region] ?? 1;

  // Live SerpAPI search (cached 30 days) when a key is configured. Providers are
  // tried in order: Walmart.com first (most of this household's shopping), then
  // Google Shopping as a fallback. Both live prices are already localized, so the
  // region multiplier applies only to seed prices.
  const gp = config.groceryPrices;
  const location = loc.city ? `${loc.city}, ${loc.state}, United States` : undefined;
  const searches: SearchFn[] = gp.serpApiKey
    ? [makeWalmartSearch(gp.serpApiKey), makeSerpApiSearch(gp.serpApiKey, location)]
    : [];
  const now = Date.now();

  let pricedCount = 0;
  let total = 0;
  for (const it of groceries) {
    let price: number | undefined;
    if (searches.length) {
      try {
        const hit = await cachedPrice(it.title, {
          searches, now, cacheDays: gp.cacheDays, hourlyLimit: gp.hourlyLimit, monthlyLimit: gp.monthlyLimit,
        });
        price = hit?.price;
      } catch {
        // live lookup failed — fall through to the seed table
      }
    }
    if (price === undefined) price = seedPrice(it.title, mult);
    if (price === undefined) continue; // unknown item — leave unpriced, exclude from total

    it.price = price;
    pricedCount++;
    total += price;
  }

  return {
    city: loc.city,
    region: loc.region,
    pricedCount,
    itemCount: groceries.length,
    total: round2(total),
  };
}
