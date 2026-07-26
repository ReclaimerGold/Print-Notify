/**
 * Refresh the bundled grocery price seed table from BLS Average Price Data.
 * Run with: npm run refresh-prices
 *
 * The U.S. Bureau of Labor Statistics publishes free, monthly average retail
 * prices for common food staples (api.bls.gov). We pull the U.S. city-average
 * series for the categories below, convert each from BLS's unit (per lb / per
 * dozen / per gallon / …) into the seed table's typical-purchase unit, and
 * rewrite data/grocery-prices.json. Regional differences are handled at print
 * time by data/region-multipliers.json (the Midwest tracks the U.S. average to
 * within ~1%, so this stays accurate for Sioux Falls).
 *
 * Keyless by default (BLS allows 25 series/request, 25 requests/day). Set
 * BLS_API_KEY in the environment to raise limits (50 series/request, 500/day).
 * This is a maintenance script — it is NOT on the print path, so digests stay
 * fully offline. Categories BLS doesn't cover (household goods, condiments,
 * items with no clean unit conversion) keep their existing seed value.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(resolve(HERE, '..', 'data'), 'grocery-prices.json');

const BLS_API = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const AREA = '0000'; // U.S. city average (comprehensive; regional series are sparse)

// category (must match data/grocery-prices.json) -> BLS item code + a factor
// that converts BLS's published unit into the seed's typical-purchase unit.
interface Mapping { category: string; item: string; factor: number; note: string }
const MAP: Mapping[] = [
  { category: 'flour',         item: '701111', factor: 5,     note: 'per lb ×5 (5 lb bag)' },
  { category: 'rice',          item: '701312', factor: 2,     note: 'per lb ×2 (2 lb)' },
  { category: 'pasta',         item: '701322', factor: 1,     note: 'per lb (16 oz)' },
  { category: 'bread',         item: '702111', factor: 1,     note: 'per lb (loaf ≈ 1 lb)' },
  { category: 'cookies',       item: '702421', factor: 0.6,   note: 'per lb ×0.6 (~10 oz pack)' },
  { category: 'ground_beef',   item: 'FC1101', factor: 1,     note: 'per lb (all uncooked ground beef)' },
  { category: 'beef',          item: 'FC3101', factor: 1,     note: 'per lb (all uncooked steaks)' },
  { category: 'bacon',         item: '704111', factor: 1,     note: 'per lb' },
  { category: 'pork',          item: 'FD3101', factor: 1,     note: 'per lb (all pork chops)' },
  { category: 'chicken',       item: 'FF1101', factor: 1,     note: 'per lb (boneless breast)' },
  { category: 'eggs',          item: '708111', factor: 1,     note: 'per dozen (grade A large)' },
  { category: 'milk',          item: '709112', factor: 1,     note: 'per gallon (whole)' },
  { category: 'butter',        item: 'FS1101', factor: 1,     note: 'per lb (stick)' },
  { category: 'cheese',        item: '710212', factor: 0.5,   note: 'per lb ×0.5 (8 oz block, cheddar)' },
  { category: 'ice_cream',     item: '710411', factor: 0.75,  note: 'per half-gal ×0.75 (48 oz)' },
  { category: 'bananas',       item: '711211', factor: 1,     note: 'per lb' },
  { category: 'oranges',       item: '711311', factor: 1,     note: 'per lb (navel)' },
  { category: 'strawberries',  item: '711415', factor: 1.333, note: 'per 12 oz ×1.33 (~1 lb)' },
  { category: 'potatoes',      item: '712112', factor: 5,     note: 'per lb ×5 (5 lb bag)' },
  { category: 'lettuce',       item: '712211', factor: 1,     note: 'per lb (iceberg head ≈ 1 lb)' },
  { category: 'tomatoes',      item: '712311', factor: 1,     note: 'per lb' },
  { category: 'sugar',         item: '715211', factor: 4,     note: 'per lb ×4 (4 lb)' },
  { category: 'coffee',        item: '717311', factor: 0.75,  note: 'per lb ×0.75 (12 oz, ground)' },
  { category: 'soda',          item: 'FN1102', factor: 12,    note: 'per 12 oz ×12 (12-pack cans)' },
  { category: 'chips',         item: '718311', factor: 0.6,   note: 'per 16 oz ×0.6 (~10 oz bag)' },
];

interface BlsPoint { year: string; period: string; value: string }
interface BlsSeries { seriesID: string; data: BlsPoint[] }

/** Most recent numeric datapoint for a series (BLS uses "-" for missing months). */
function latest(data: BlsPoint[]): { value: number; period: string } | null {
  let best: { key: number; value: number; period: string } | null = null;
  for (const d of data) {
    if (!d.period.startsWith('M')) continue; // skip annual averages (M13)
    const value = Number(d.value);
    if (!Number.isFinite(value)) continue; // "-" or blank
    const key = Number(d.year) * 100 + Number(d.period.slice(1));
    if (!best || key > best.key) best = { key, value, period: `${d.year}-${d.period.slice(1)}` };
  }
  return best ? { value: best.value, period: best.period } : null;
}

async function fetchSeries(items: string[]): Promise<Map<string, { value: number; period: string }>> {
  const key = process.env.BLS_API_KEY;
  const chunkSize = key ? 50 : 25; // BLS per-request series cap (registered vs not)
  const out = new Map<string, { value: number; period: string }>();
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const body: Record<string, unknown> = {
      seriesid: chunk.map((it) => `APU${AREA}${it}`),
      startyear: String(new Date().getUTCFullYear() - 1),
      endyear: String(new Date().getUTCFullYear()),
    };
    if (key) body.registrationkey = key;
    const res = await fetch(BLS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`BLS HTTP ${res.status}`);
    const json: any = await res.json();
    if (json.status !== 'REQUEST_SUCCEEDED') {
      throw new Error(`BLS: ${json.status} ${(json.message ?? []).join('; ')}`);
    }
    for (const s of json.Results.series as BlsSeries[]) {
      const item = s.seriesID.slice(3 + AREA.length); // strip "APU" + area
      const lt = latest(s.data);
      if (lt) out.set(item, lt);
    }
  }
  return out;
}

// --- run ---
const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as {
  basis: string; region: string; unitNote: string; lastUpdated: string;
  categories: Record<string, { price: number; unit: string }>;
  source?: string;
};

console.log(`Fetching ${MAP.length} BLS series (U.S. city average)…`);
const prices = await fetchSeries(MAP.map((m) => m.item));

let updated = 0;
const skipped: string[] = [];
let latestPeriod = '';
for (const m of MAP) {
  const hit = prices.get(m.item);
  const target = seed.categories[m.category];
  if (!hit || !target) {
    skipped.push(`${m.category} (${!target ? 'not in seed' : 'no BLS data'})`);
    continue;
  }
  const next = Math.round(hit.value * m.factor * 100) / 100;
  const arrow = next === target.price ? '=' : '→';
  console.log(`  ${m.category.padEnd(14)} $${target.price.toFixed(2).padStart(6)} ${arrow} $${next.toFixed(2).padStart(6)}   [BLS $${hit.value.toFixed(3)} ${m.note}]`);
  target.price = next;
  if (hit.period > latestPeriod) latestPeriod = hit.period;
  updated++;
}

seed.region = 'US';
seed.source = 'BLS Average Price Data, U.S. city average (api.bls.gov); regionalized via region-multipliers.json';
seed.basis =
  'U.S. city-average retail prices from the Bureau of Labor Statistics (BLS) Average Price Data, ' +
  'converted to a typical single purchase unit per category. Refresh with `npm run refresh-prices`. ' +
  'Categories BLS does not cover keep hand-set estimates. Region multipliers scale these per census region.';
if (latestPeriod) seed.lastUpdated = latestPeriod;

writeFileSync(SEED_PATH, JSON.stringify(seed, null, 2) + '\n');

console.log(`\nUpdated ${updated} categories from BLS (data period ${latestPeriod || 'n/a'}).`);
if (skipped.length) console.log(`Kept existing seed value for: ${skipped.join(', ')}.`);
console.log(`Wrote ${SEED_PATH}`);
