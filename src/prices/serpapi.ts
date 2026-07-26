// SerpAPI Google Shopping client. Given a grocery item (and an optional location
// for localized results), it returns a representative price — the median of the
// top few shopping results, which is more stable than the single top hit. Any
// failure (network, quota, no results) returns null so the caller falls back to
// the seed table. Follows the codebase's fetch + res.ok idiom (see weather.ts).
import { round2, type SearchFn, type SearchResult } from './priceDb.js';

interface ShoppingResult { title?: string; source?: string; extracted_price?: number }
type PricedResult = ShoppingResult & { extracted_price: number };
interface SerpResponse { shopping_results?: ShoppingResult[]; error?: string }

const TOP_N = 5; // sample size for the median

const hasPrice = (r: ShoppingResult): r is PricedResult =>
  typeof r.extracted_price === 'number' && r.extracted_price > 0;

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Build a SearchFn bound to an API key and location. Returns null on any failure
 * so pricing degrades gracefully to the seed table.
 */
export function makeSerpApiSearch(apiKey: string, location?: string): SearchFn {
  return async (query: string): Promise<SearchResult | null> => {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google_shopping');
    url.searchParams.set('q', query);
    url.searchParams.set('hl', 'en');
    url.searchParams.set('gl', 'us');
    if (location) url.searchParams.set('location', location);
    url.searchParams.set('api_key', apiKey);

    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'print-notify' } });
      if (!res.ok) return null;
      const data = (await res.json()) as SerpResponse;
      if (data.error) return null;

      const priced = (data.shopping_results ?? []).filter(hasPrice).slice(0, TOP_N);
      if (priced.length === 0) return null;

      return {
        price: round2(median(priced.map((r) => r.extracted_price))),
        title: priced[0].title ?? null,
        merchant: priced[0].source ?? null,
      };
    } catch {
      return null; // network / parse failure — fall back
    }
  };
}
