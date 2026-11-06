// SerpAPI Google Shopping client. Given a grocery item (and an optional location
// for localized results), it returns a representative price — the median of the
// top few shopping results, which is more stable than the single top hit. No
// results returns null and a failed request throws; either way the caller falls
// back to the seed table. Follows the codebase's fetch + res.ok idiom (see weather.ts).
import { timedFetch } from '../http.js';
import { round2, type SearchFn, type SearchResult } from './priceDb.js';

interface ShoppingResult { title?: string; source?: string; extracted_price?: number }
type PricedResult = ShoppingResult & { extracted_price: number };
interface SerpResponse { shopping_results?: ShoppingResult[]; error?: string }

/** SerpAPI reports an empty result set through `error`, alongside real failures. */
const NO_RESULTS = /returned any results|no results/i;

const TOP_N = 5; // sample size for the median

const hasPrice = (r: ShoppingResult): r is PricedResult =>
  typeof r.extracted_price === 'number' && r.extracted_price > 0;

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Build a SearchFn bound to an API key and location. See SearchFn for what null
 * and a throw mean.
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

    const res = await timedFetch(url, { headers: { 'User-Agent': 'print-notify' } });
    if (!res.ok) throw new Error(`SerpAPI ${res.status}`);
    const data = (await res.json()) as SerpResponse;
    if (data.error) {
      if (NO_RESULTS.test(data.error)) return null;
      throw new Error(`SerpAPI: ${data.error}`);
    }

    const priced = (data.shopping_results ?? []).filter(hasPrice).slice(0, TOP_N);
    if (priced.length === 0) return null;

    return {
      price: round2(median(priced.map((r) => r.extracted_price))),
      title: priced[0].title ?? null,
      merchant: priced[0].source ?? null,
    };
  };
}
