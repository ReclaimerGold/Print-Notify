// Thin client for the National Weather Service alerts API (api.weather.gov).
// Keyless, but NWS requires a descriptive User-Agent with contact info (see
// config.weatherAlerts.userAgent). We poll the point-based active-alerts feed to
// learn which warnings/advisories/watches are in effect for WEATHER_LAT/LON.
import { config } from './config.js';

export type AlertCategory = 'warning' | 'advisory' | 'watch' | 'statement' | 'other';

/** One normalized active NWS alert (a GeoJSON feature's `properties`). */
export interface NwsAlert {
  id: string;
  event: string;        // "Tornado Warning", "Winter Weather Advisory", ...
  headline?: string;
  /** Plain-English one-liner from parameters.NWSheadline (often clearer than `headline`). */
  nwsHeadline?: string;
  description?: string; // full "what's happening" narrative
  instruction?: string; // call-to-action ("what you should do"); often absent
  severity: string;     // Extreme | Severe | Moderate | Minor | Unknown
  urgency: string;      // Immediate | Expected | Future | Past | Unknown
  certainty: string;    // Observed | Likely | Possible | Unlikely | Unknown
  status: string;       // Actual | Exercise | System | Test | Draft
  messageType: string;  // Alert | Update | Cancel | Ack | Error
  areaDesc?: string;
  /** areaDesc split into individual county/zone names (the affected counties). */
  areas: string[];
  /** SAME (6-digit FIPS) codes for the affected counties, from geocode.SAME. */
  same: string[];
  /** Issuing NWS office, e.g. "NWS Sioux Falls SD" (properties.senderName). */
  senderName?: string;
  effective?: string;
  onset?: string;
  expires?: string;
  ends?: string;
  sent?: string;
  /** Ids of prior alerts this one supersedes (properties.references[].identifier). */
  references: string[];
}

/** Split a semicolon-separated NWS `areaDesc` into trimmed county/zone names. */
export function parseAreas(areaDesc?: string): string[] {
  if (!areaDesc) return [];
  return areaDesc.split(';').map((s) => s.trim()).filter(Boolean);
}

/** Currently-active alerts for the configured point. Throws on a non-OK response. */
export async function fetchActiveAlerts(): Promise<NwsAlert[]> {
  const { lat, lon } = config.sources.weather;
  const url = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': config.weatherAlerts.userAgent,
      Accept: 'application/geo+json',
    },
  });
  if (!res.ok) throw new Error(`NWS ${res.status}`);
  const json: any = await res.json();
  const features: any[] = Array.isArray(json?.features) ? json.features : [];

  const alerts: NwsAlert[] = [];
  for (const f of features) {
    const p = f?.properties;
    const id: string = p?.id ?? f?.id ?? '';
    if (!id || !p?.event) continue;
    // Only real, in-effect alerts — never test/exercise/draft traffic.
    if ((p.status ?? 'Actual') !== 'Actual') continue;
    const nwsHeadline = Array.isArray(p.parameters?.NWSheadline)
      ? String(p.parameters.NWSheadline[0] ?? '').trim() || undefined
      : undefined;
    alerts.push({
      id,
      event: p.event,
      headline: p.headline ?? undefined,
      nwsHeadline,
      description: p.description ?? undefined,
      instruction: p.instruction ?? undefined,
      severity: p.severity ?? 'Unknown',
      urgency: p.urgency ?? 'Unknown',
      certainty: p.certainty ?? 'Unknown',
      status: p.status ?? 'Actual',
      messageType: p.messageType ?? 'Alert',
      areaDesc: p.areaDesc ?? undefined,
      areas: parseAreas(p.areaDesc),
      same: Array.isArray(p.geocode?.SAME) ? p.geocode.SAME.map(String) : [],
      senderName: p.senderName ?? undefined,
      effective: p.effective ?? undefined,
      onset: p.onset ?? undefined,
      expires: p.expires ?? undefined,
      ends: p.ends ?? undefined,
      sent: p.sent ?? undefined,
      references: Array.isArray(p.references)
        ? p.references.map((r: any) => r?.identifier).filter(Boolean)
        : [],
    });
  }
  return alerts;
}

/** Bucket an alert by the last word of its `event` name. */
export function alertCategory(a: NwsAlert): AlertCategory {
  const last = a.event.trim().split(/\s+/).pop()?.toLowerCase() ?? '';
  if (last === 'warning') return 'warning';
  if (last === 'advisory') return 'advisory';
  if (last === 'watch') return 'watch';
  if (last === 'statement') return 'statement';
  return 'other';
}

/** True when this alert's category is configured to trigger an immediate print. */
export function isImmediate(a: NwsAlert): boolean {
  return config.weatherAlerts.printTypes.includes(alertCategory(a));
}

/** Where WEATHER_LAT/LON actually is — the home county + nearest city + issuing
 *  office. Gives every alert a "this is your area" anchor. */
export interface PointContext {
  county?: string;   // "Minnehaha County, SD"
  city?: string;     // "Sioux Falls"
  state?: string;    // "SD"
  office?: string;   // WFO code, e.g. "FSD"
  zone?: string;     // forecast-zone code, e.g. "SDZ062"
}

// The point never moves, so resolve it once and reuse. `pending` dedupes the
// concurrent first-callers (poller + dashboard) into a single API round-trip.
let cachedContext: PointContext | undefined;
let pending: Promise<PointContext | undefined> | undefined;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': config.weatherAlerts.userAgent, Accept: 'application/geo+json' },
  });
  if (!res.ok) throw new Error(`NWS ${res.status}`);
  return res.json();
}

/** Resolve (and cache) the home-point context. Best-effort: returns `undefined`
 *  on any failure or for a non-US point, so callers can treat it as optional. */
export async function fetchPointContext(): Promise<PointContext | undefined> {
  if (cachedContext) return cachedContext;
  if (pending) return pending;
  pending = (async () => {
    try {
      const { lat, lon } = config.sources.weather;
      const pt = await getJson(`https://api.weather.gov/points/${lat},${lon}`);
      const p = pt?.properties ?? {};
      const rel = p.relativeLocation?.properties ?? {};
      const state: string | undefined = rel.state ?? undefined;
      const zone: string | undefined =
        typeof p.forecastZone === 'string' ? p.forecastZone.split('/').pop() : undefined;

      // The county field is a zone URL; one more hop turns it into a name.
      let county: string | undefined;
      if (typeof p.county === 'string') {
        try {
          const cz = await getJson(p.county);
          const name: string | undefined = cz?.properties?.name;
          if (name) county = state ? `${name} County, ${state}` : `${name} County`;
        } catch {
          /* county name is optional */
        }
      }

      cachedContext = { county, city: rel.city ?? undefined, state, office: p.cwa ?? undefined, zone };
      return cachedContext;
    } catch {
      return undefined; // non-US point or API hiccup — context is optional
    } finally {
      pending = undefined;
    }
  })();
  return pending;
}

/** Last successfully resolved context, without triggering a fetch (for sync callers). */
export function cachedPointContext(): PointContext | undefined {
  return cachedContext;
}
