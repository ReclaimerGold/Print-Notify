// SerpAPI Walmart client. Same shape as the Google Shopping client (serpapi.ts)
// but hits SerpAPI's Walmart engine, so prices come from Walmart.com — where most
// of this household's shopping happens, giving more representative estimates. No
// results returns null and a failed request throws; either way the caller moves on
// to the next provider (Google Shopping) and ultimately the seed table.
import { timedFetch } from '../http.js';
import { round2, type SearchFn, type SearchResult } from './priceDb.js';

interface Offer { offer_price?: number }
interface WalmartResult { title?: string; seller_name?: string; primary_offer?: Offer }
type PricedResult = WalmartResult & { primary_offer: { offer_price: number } };
interface WalmartResponse { organic_results?: WalmartResult[]; error?: string }

/** SerpAPI reports an empty result set through `error`, alongside real failures. */
const NO_RESULTS = /returned any results|no results/i;

const TOP_N = 5; // sample size for the median

const hasPrice = (r: WalmartResult): r is PricedResult =>
  typeof r.primary_offer?.offer_price === 'number' && r.primary_offer.offer_price > 0;

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Build a SearchFn bound to a SerpAPI key that queries Walmart.com. Returns the
 * median of the top few Walmart offers. See SearchFn for what null and a throw mean.
 */
export function makeWalmartSearch(apiKey: string): SearchFn {
  return async (query: string): Promise<SearchResult | null> => {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'walmart');
    url.searchParams.set('query', query);
    url.searchParams.set('api_key', apiKey);

    const res = await timedFetch(url, { headers: { 'User-Agent': 'print-notify' } });
    if (!res.ok) throw new Error(`SerpAPI ${res.status}`);
    const data = (await res.json()) as WalmartResponse;
    if (data.error) {
      if (NO_RESULTS.test(data.error)) return null;
      throw new Error(`SerpAPI: ${data.error}`);
    }

    const priced = (data.organic_results ?? []).filter(hasPrice).slice(0, TOP_N);
    if (priced.length === 0) return null;

    return {
      price: round2(median(priced.map((r) => r.primary_offer.offer_price))),
      title: priced[0].title ?? null,
      merchant: priced[0].seller_name ?? 'Walmart',
    };
  };
}
