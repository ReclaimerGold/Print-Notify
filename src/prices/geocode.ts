// Reverse-geocode the configured weather coordinates into the nearest city and
// its U.S. census region. Used to label grocery price estimates ("· Sioux Falls")
// and to pick the regional cost multiplier. Keyless (OpenStreetMap Nominatim).
//
// The location is effectively static, so the result is cached to a small JSON in
// the temp dir keyed by the lat/lon — steady-state runs make no network call.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';

export type Region = 'Northeast' | 'Midwest' | 'South' | 'West';

export interface ResolvedLocation {
  city: string;
  state: string;
  region: Region;
}

// Full (lowercase) state name -> U.S. census region. Nominatim returns the full
// state name in `address.state`.
const REGION_BY_STATE: Record<string, Region> = {
  connecticut: 'Northeast', maine: 'Northeast', massachusetts: 'Northeast',
  'new hampshire': 'Northeast', 'rhode island': 'Northeast', vermont: 'Northeast',
  'new jersey': 'Northeast', 'new york': 'Northeast', pennsylvania: 'Northeast',
  illinois: 'Midwest', indiana: 'Midwest', michigan: 'Midwest', ohio: 'Midwest',
  wisconsin: 'Midwest', iowa: 'Midwest', kansas: 'Midwest', minnesota: 'Midwest',
  missouri: 'Midwest', nebraska: 'Midwest', 'north dakota': 'Midwest', 'south dakota': 'Midwest',
  delaware: 'South', florida: 'South', georgia: 'South', maryland: 'South',
  'north carolina': 'South', 'south carolina': 'South', virginia: 'South',
  'west virginia': 'South', 'district of columbia': 'South', alabama: 'South',
  kentucky: 'South', mississippi: 'South', tennessee: 'South', arkansas: 'South',
  louisiana: 'South', oklahoma: 'South', texas: 'South',
  arizona: 'West', colorado: 'West', idaho: 'West', montana: 'West', nevada: 'West',
  'new mexico': 'West', utah: 'West', wyoming: 'West', alaska: 'West', california: 'West',
  hawaii: 'West', oregon: 'West', washington: 'West',
};

const GEO_CACHE = join(tmpdir(), 'print-notify-geo.json');

/**
 * Resolve the configured lat/lon to `{ city, state, region }`. Cached to disk by
 * coordinate; only re-fetches when the coordinates change. Throws on a non-OK
 * Nominatim response (callers treat pricing as best-effort and fall back).
 */
export async function resolveLocation(): Promise<ResolvedLocation> {
  const { lat, lon } = config.sources.weather;
  const key = `${lat},${lon}`;

  if (existsSync(GEO_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(GEO_CACHE, 'utf8'));
      if (cached.key === key && cached.location) return cached.location as ResolvedLocation;
    } catch {
      // corrupt cache — fall through and re-fetch
    }
  }

  const url =
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}` +
    `&format=json&zoom=10&addressdetails=1`;
  // Nominatim requires an identifying User-Agent.
  const res = await fetch(url, { headers: { 'User-Agent': 'print-notify (grocery price estimator)' } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const d: any = await res.json();
  const a = d.address ?? {};

  const city =
    a.city || a.town || a.village || a.hamlet || a.municipality || a.county || d.name || '';
  const state: string = a.state ?? '';
  const region = REGION_BY_STATE[state.toLowerCase()] ?? 'Midwest';
  const location: ResolvedLocation = { city, state, region };

  try {
    writeFileSync(GEO_CACHE, JSON.stringify({ key, location }));
  } catch {
    // best-effort cache; ignore write failures
  }
  return location;
}
