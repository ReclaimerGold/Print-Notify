import { config } from '../config.js';
import { weatherGroup } from '../weatherArt.js';
import { weatherIconPath, forecastImage, weatherPanelImage, type ForecastDay } from '../bitmap.js';
import { fetchActiveAlerts, fetchPointContext, type NwsAlert, type PointContext } from '../nws.js';
import type { Source, NotificationItem, DigestContext } from './types.js';

/**
 * Index of "today" in Open-Meteo's daily arrays. We request `past_days=1` so
 * yesterday's `daylight_duration` is available for the day-length delta, which
 * shifts every daily array forward by one — hence this constant rather than a
 * bare 0 scattered through the parser.
 */
const TODAY = 1;

// Minimal WMO weather-code -> label map (Open-Meteo `weather_code`).
const WMO: Record<number, string> = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow',
  75: 'Heavy snow', 80: 'Rain showers', 81: 'Rain showers', 82: 'Violent showers',
  95: 'Thunderstorm', 96: 'Thunderstorm + hail', 99: 'Severe thunderstorm',
};

const SEVERE = new Set([65, 75, 82, 95, 96, 99]);

/** Most-common value in a list (used to pick a day's/night's representative code). */
function mode(nums: number[]): number | undefined {
  if (!nums.length) return undefined;
  const counts = new Map<number, number>();
  let best = nums[0];
  for (const n of nums) {
    const c = (counts.get(n) ?? 0) + 1;
    counts.set(n, c);
    if (c > (counts.get(best) ?? 0)) best = n;
  }
  return best;
}

/** 3-day day/night forecast starting the day after `from` (skip that day's row). */
function buildForecast(d: any, from: number = TODAY): ForecastDay[] {
  const days: ForecastDay[] = [];
  const hTime: string[] = d.hourly?.time ?? [];
  const hCode: number[] = d.hourly?.weather_code ?? [];
  const hIsDay: number[] = d.hourly?.is_day ?? [];
  const hRh: number[] = d.hourly?.relative_humidity_2m ?? [];

  // Daily arrays hold yesterday + today + 4 (past_days=1, forecast_days=5).
  for (let i = from + 1; i <= from + 3 && i < d.daily.time.length; i++) {
    const date: string = d.daily.time[i]; // YYYY-MM-DD (local tz)
    const dayCodes: number[] = [];
    const nightCodes: number[] = [];
    const rh: number[] = [];
    for (let h = 0; h < hTime.length; h++) {
      if (!hTime[h].startsWith(date)) continue;
      (hIsDay[h] === 1 ? dayCodes : nightCodes).push(hCode[h]);
      if (hRh[h] !== undefined) rh.push(hRh[h]);
    }
    const dayCode = mode(dayCodes) ?? d.daily.weather_code[i];
    const nightCode = mode(nightCodes) ?? d.daily.weather_code[i];
    const humidity = rh.length ? Math.round(rh.reduce((s, v) => s + v, 0) / rh.length) : undefined;
    days.push({
      name: new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
        weekday: 'short', timeZone: config.timezone,
      }),
      dayGroup: weatherGroup(dayCode, true),
      hi: Math.round(d.daily.temperature_2m_max[i]),
      nightGroup: weatherGroup(nightCode, false),
      lo: Math.round(d.daily.temperature_2m_min[i]),
      humidity,
    });
  }
  return days;
}

/** Moon phase for a date, computed astronomically (no API provides it). Uses a
 *  known new moon epoch + the mean synodic month. `illum` is 0..1 illuminated. */
function moonPhase(when: Date): MoonInfo {
  const SYNODIC = 29.530588853;
  const KNOWN_NEW = Date.UTC(2000, 0, 6, 18, 14) / 86_400_000; // 2000-01-06 18:14 UTC, in days
  const days = when.getTime() / 86_400_000 - KNOWN_NEW;
  const p = ((days / SYNODIC) % 1 + 1) % 1; // 0=new, .5=full
  const illum = (1 - Math.cos(2 * Math.PI * p)) / 2;
  const waxing = p < 0.5;
  const name =
    p < 0.02 || p > 0.98 ? 'New Moon'
    : p < 0.23 ? 'Waxing Crescent'
    : p < 0.27 ? 'First Quarter'
    : p < 0.48 ? 'Waxing Gibbous'
    : p < 0.52 ? 'Full Moon'
    : p < 0.73 ? 'Waning Gibbous'
    : p < 0.77 ? 'Last Quarter'
    : 'Waning Crescent';
  return { name, illum, waxing };
}

/** A time-of-day label like "9a", "12p", "4p" from an ISO local timestamp. */
function shortHour(iso: string): string {
  const h = Number(iso.slice(11, 13));
  const ampm = h < 12 ? 'a' : 'p';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${ampm}`;
}

/** A clock time like "5:57 AM" in the configured timezone. */
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: config.timezone, hour: 'numeric', minute: '2-digit',
  });
}

/**
 * Temperature at 2-hour steps for the graph. With no `date`, it's the next 24h
 * from the current hour (the morning digest's "rest of today"); with a date it's
 * that whole calendar day from 6am, which is what the evening digest wants —
 * a shape of tomorrow, not a countdown from tonight.
 */
function build2hTemps(d: any, date?: string): HourTemp[] {
  const times: string[] = d.hourly?.time ?? [];
  const temps: number[] = d.hourly?.temperature_2m ?? [];
  if (!times.length) return [];

  let start: number;
  if (date) {
    start = times.findIndex((t) => t.startsWith(date) && Number(t.slice(11, 13)) >= 6);
    if (start < 0) start = times.findIndex((t) => t.startsWith(date));
  } else {
    const nowMs = Date.now();
    start = times.findIndex((t) => new Date(t).getTime() >= nowMs);
  }
  if (start < 0) start = 0;

  const out: HourTemp[] = [];
  for (let i = start; i < times.length && out.length < 13; i += 2) {
    out.push({ label: shortHour(times[i]), temp: Math.round(temps[i]) });
  }
  return out;
}

/** Air quality + pollen, from Open-Meteo's air-quality API. */
export interface AirQuality {
  /** US AQI (0-500). */
  aqi?: number;
  pm25?: number;
  /** EPA category name for `aqi`, e.g. "Moderate". */
  category?: string;
  /** Pollen grains/m³, where the model covers the point (Europe only today). */
  pollen?: { grass?: number; tree?: number; ragweed?: number };
}

/** EPA's US AQI bands — the words are the actionable part, not the number. */
export function aqiCategory(aqi: number): string {
  if (aqi <= 50) return 'Good';
  if (aqi <= 100) return 'Moderate';
  if (aqi <= 150) return 'Unhealthy for sensitive';
  if (aqi <= 200) return 'Unhealthy';
  if (aqi <= 300) return 'Very unhealthy';
  return 'Hazardous';
}

/** Fetch air quality + pollen. Best-effort: returns undefined on any failure. */
async function fetchAirQuality(lat: string, lon: string): Promise<AirQuality | undefined> {
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
    `&current=us_aqi,pm2_5,grass_pollen,birch_pollen,ragweed_pollen&timezone=auto`;
  try {
    const d = await getJson(url, 1);
    const c = d?.current ?? {};
    const round = (v: unknown, dp = 0) =>
      typeof v === 'number' ? Math.round(v * 10 ** dp) / 10 ** dp : undefined;

    // Pollen is a European-model product: outside its domain every field is
    // null, so the panel simply omits the line rather than printing zeros.
    const pollen = {
      grass: round(c.grass_pollen),
      tree: round(c.birch_pollen),
      ragweed: round(c.ragweed_pollen),
    };
    const hasPollen = Object.values(pollen).some((v) => v !== undefined);
    const aqi = round(c.us_aqi);

    return {
      aqi,
      pm25: round(c.pm2_5, 1),
      category: aqi !== undefined ? aqiCategory(aqi) : undefined,
      pollen: hasPollen ? pollen : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Day length and how it changed from the previous day, in seconds. */
export interface Daylight {
  seconds: number;
  deltaSeconds: number;
}

/** "14h 08m  ·  2m 32s shorter" — the delta is the part people actually feel. */
export function daylightLabel(dl: Daylight): string {
  const h = Math.floor(dl.seconds / 3600);
  const m = Math.round((dl.seconds % 3600) / 60);
  const len = `${h}h ${String(m).padStart(2, '0')}m`;
  const d = Math.round(dl.deltaSeconds);
  if (Math.abs(d) < 30) return `${len}  ·  same as yesterday`;
  const mag = Math.abs(d);
  const parts = mag >= 60 ? `${Math.floor(mag / 60)}m ${mag % 60}s` : `${mag}s`;
  return `${len}  ·  ${parts} ${d < 0 ? 'shorter' : 'longer'}`;
}

export interface MoonInfo { name: string; illum: number; waxing: boolean }
export interface HourTemp { label: string; temp: number }

/** Structured current conditions + 3-day forecast, shared by the printed digest
 *  (bitmaps) and the on-screen dashboard tile (JSON). One Open-Meteo call. */
export interface WeatherData {
  current: {
    temp?: number;
    label: string;
    code: number;
    isDay: boolean;
    hi: number;
    lo: number;
    pop: number;
    wind?: number;
    feels?: number;
    humidity?: number;
    /** Preformatted "Now 72°F (feels 70°) · Hi 82 Lo 58 · Precip 10% · Wind 5 mph" line. */
    stats: string;
  };
  forecast: ForecastDay[];
  /** Next-24h temperature at 2-hour steps, for the graph. */
  hourly: HourTemp[];
  /** Today's sunrise/sunset as clock strings (e.g. "5:57 AM"). */
  sun: { sunrise: string; sunset: string };
  /** Day length + change vs. the previous day. */
  daylight?: Daylight;
  /** Tonight's moon phase. */
  moon: MoonInfo;
  /** Today's max UV index, if available. */
  uv?: number;
  /** Air quality + pollen (best-effort; undefined when the API is unreachable). */
  air?: AirQuality;
  /** Which day this snapshot describes — 'tomorrow' for the evening digest. */
  day: 'today' | 'tomorrow';
  /** When these conditions were actually retrieved (ms epoch). */
  fetchedAt: number;
  /** True when the API failed and this is the last good reading. */
  stale?: boolean;
  /** True when a severe code or ≥80% precip warrants an urgent alert. */
  alert: boolean;
  /** Active NWS warnings/advisories/watches for the point (best-effort; [] on error). */
  alerts: NwsAlert[];
  /** Which county/city the point sits in (best-effort; undefined for non-US/API error). */
  location?: PointContext;
}

/**
 * GET + parse JSON with a hard timeout and one retry. `fetch()` has no default
 * timeout, so a stalled connection (e.g. flaky network right when the 7am cron
 * fires) would otherwise hang or throw and silently drop weather from the digest.
 */
async function getJson(url: string, tries = 3, timeoutMs = 8000): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    // Back off before every attempt after the first. Without this the "retry"
    // fires microseconds after the failure and lands in the same bad window —
    // which is how a transient 503 used to take out the whole weather section.
    if (attempt > 1) await sleep(400 * 2 ** (attempt - 2) + Math.random() * 250);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CacheEntry { at: number; data: WeatherData }

// Keyed by horizon + calendar date, so a cached "today" can never be served
// after midnight as if it were the new today.
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<WeatherData>>();

const cacheKey = (day: string) => `${day}:${new Date().toDateString()}`;

/** Drop every cached reading. Exposed for tests. */
export function clearWeatherCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Structured weather, cached and de-duplicated.
 *
 * Three things happen here, and each exists for a reason the hard way:
 *
 *  - **Cache** (WEATHER_CACHE_MINUTES). The dashboard, the preview, the poll and
 *    the digest all funnel through here; without this they each hit Open-Meteo
 *    independently.
 *  - **In-flight coalescing.** At 07:00:00 the digest cron and the urgent-poll
 *    cron fire on the same tick, and a cache alone doesn't help because neither
 *    has populated it yet. Concurrent callers now share one HTTP request.
 *  - **Stale fallback.** Open-Meteo 503s transiently. Serving conditions from
 *    twenty minutes ago is strictly better than printing the morning digest with
 *    the weather section replaced by "Unavailable".
 */
export async function fetchWeatherData(ctx?: DigestContext): Promise<WeatherData> {
  const key = cacheKey(ctx?.day ?? 'today');
  const { cacheMinutes, staleMinutes } = config.sources.weather;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cacheMinutes * 60_000) return hit.data;

  // Someone else is already asking for exactly this — wait on their request
  // rather than opening a second one.
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = fetchWeatherUncached(ctx)
    .then((data) => {
      cache.set(key, { at: Date.now(), data });
      return data;
    })
    .catch((err) => {
      // Fall back to the last good reading, if it's still recent enough to be
      // worth printing. `stale` lets the receipt and dashboard say so.
      const stale = cache.get(key);
      const age = stale ? Date.now() - stale.at : Infinity;
      if (stale && age < staleMinutes * 60_000) {
        console.warn(
          `[weather] ${String((err as Error)?.message ?? err)} — serving reading from ` +
          `${Math.round(age / 60_000)}m ago`,
        );
        return { ...stale.data, stale: true, fetchedAt: stale.at };
      }
      throw err;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, request);
  return request;
}

/** Fetch + parse Open-Meteo into structured weather. Throws on a non-OK response. */
async function fetchWeatherUncached(ctx?: DigestContext): Promise<WeatherData> {
  const { lat, lon } = config.sources.weather;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m` +
    `&hourly=temperature_2m,relative_humidity_2m,weather_code,is_day` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,sunrise,sunset,uv_index_max,daylight_duration` +
    // forecast_days=5 (not 4): the evening digest's horizon starts a day later,
    // and its 3-day forecast grid still has to reach three days past *tomorrow*.
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&past_days=1&forecast_days=5`;

  // Fetch conditions, air quality, NWS alerts, and the home-point context
  // together; everything but the forecast is best-effort, so an api.weather.gov
  // or air-quality hiccup never breaks the digest's weather section.
  const [d, air, alerts, location] = await Promise.all([
    getJson(url),
    config.sources.weather.airQuality ? fetchAirQuality(lat, lon) : Promise.resolve(undefined),
    config.weatherAlerts.enabled ? fetchActiveAlerts().catch(() => []) : Promise.resolve([]),
    config.weatherAlerts.enabled ? fetchPointContext().catch(() => undefined) : Promise.resolve(undefined),
  ]);

  // The evening digest describes tomorrow: one index further into the daily
  // arrays, and no "current conditions" (they'd be stale by morning).
  const tomorrow = ctx?.day === 'tomorrow';
  const i = tomorrow ? TODAY + 1 : TODAY;

  const code: number = d.daily.weather_code[i];
  // Prefer the CURRENT condition for the icon; fall back to the daily code.
  // For tomorrow there is no "current", so the daily code is the whole story.
  const curCode: number = tomorrow ? code : (d.current?.weather_code ?? code);
  const label = WMO[curCode] ?? WMO[code] ?? `Code ${curCode}`;
  const isDay = tomorrow ? true : (d.current?.is_day ?? 1) === 1;
  const hi = Math.round(d.daily.temperature_2m_max[i]);
  const lo = Math.round(d.daily.temperature_2m_min[i]);
  const pop = d.daily.precipitation_probability_max[i];
  const temp = !tomorrow && d.current?.temperature_2m !== undefined ? Math.round(d.current.temperature_2m) : undefined;
  const wind = !tomorrow && d.current?.wind_speed_10m !== undefined ? Math.round(d.current.wind_speed_10m) : undefined;
  const feels = !tomorrow && d.current?.apparent_temperature !== undefined ? Math.round(d.current.apparent_temperature) : undefined;
  const humidity = !tomorrow && d.current?.relative_humidity_2m !== undefined ? Math.round(d.current.relative_humidity_2m) : undefined;
  const uv = d.daily?.uv_index_max?.[i] !== undefined && d.daily.uv_index_max[i] !== null
    ? Math.round(d.daily.uv_index_max[i]) : undefined;

  // Day length vs. the previous day — the reason past_days=1 is on the request.
  const dur: number[] = d.daily?.daylight_duration ?? [];
  const daylight = dur[i] !== undefined && dur[i] !== null && dur[i - 1] !== undefined && dur[i - 1] !== null
    ? { seconds: dur[i], deltaSeconds: dur[i] - dur[i - 1] }
    : undefined;

  const stats = [
    temp !== undefined
      ? `Now ${temp}°F${feels !== undefined && feels !== temp ? ` (feels ${feels}°)` : ''}`
      : null,
    `Hi ${hi}  Lo ${lo}`,
    `Precip ${pop}%`,
    wind !== undefined ? `Wind ${wind} mph` : null,
  ].filter(Boolean).join('   ·   ');

  return {
    current: { temp, label, code: curCode, isDay, hi, lo, pop, wind, feels, humidity, stats },
    forecast: buildForecast(d, i),
    hourly: build2hTemps(d, tomorrow ? d.daily.time[i] : undefined),
    sun: {
      sunrise: d.daily?.sunrise?.[i] ? clock(d.daily.sunrise[i]) : '',
      sunset: d.daily?.sunset?.[i] ? clock(d.daily.sunset[i]) : '',
    },
    daylight,
    moon: moonPhase(new Date()),
    uv,
    air,
    day: tomorrow ? 'tomorrow' : 'today',
    fetchedAt: Date.now(),
    alert: SEVERE.has(code) || pop >= 80,
    alerts,
    location,
  };
}

export const weatherSource: Source = {
  name: 'weather',
  enabled: config.sources.weather.enabled,
  async fetch(ctx?: DigestContext): Promise<NotificationItem[]> {
    const w = await fetchWeatherData(ctx);
    const { label, code, isDay, pop, stats } = w.current;
    const now = Date.now();
    // Key ids by the day being described, so an evening (tomorrow) item never
    // collides with the morning (today) item in the seen-store.
    const key = `${w.day}:${new Date().toISOString().slice(0, 10)}`;

    const items: NotificationItem[] = [
      {
        id: `weather:daily:${key}`,
        source: 'weather',
        title: w.day === 'tomorrow' ? `Tomorrow — ${label}` : label,
        // Never pass a fallback reading off as current — say how old it is.
        detail: w.stale
          ? `${stats}   ·   as of ${Math.round((Date.now() - w.fetchedAt) / 60_000)}m ago`
          : stats,
        severity: 'info',
        image: weatherIconPath(weatherGroup(code, isDay)),
        timestamp: now,
      },
      {
        id: `weather:panel:${key}`,
        source: 'weather',
        title: '',
        severity: 'info',
        image: await weatherPanelImage({
          hourly: w.hourly,
          hi: w.current.hi,
          lo: w.current.lo,
          sun: w.sun,
          daylight: w.daylight ? daylightLabel(w.daylight) : undefined,
          moon: w.moon,
          humidity: w.current.humidity,
          uv: w.uv,
          aqi: w.air?.aqi,
          aqiCategory: w.air?.category,
          pm25: w.air?.pm25,
          pollen: w.air?.pollen,
          heading: w.day === 'tomorrow' ? 'TOMORROW' : 'NEXT 24 HOURS',
        }),
        timestamp: now,
      },
      {
        id: `weather:forecast:${key}`,
        source: 'weather',
        title: '',
        severity: 'info',
        image: await forecastImage(w.forecast),
        timestamp: now,
      },
    ];

    // Poor air quality is actionable in the same way a storm is — it changes
    // whether you open the windows or run outside.
    if (w.air?.aqi !== undefined && w.air.aqi >= config.sources.weather.aqiAlert) {
      items.push({
        id: `weather:aqi:${key}`,
        source: 'weather',
        title: `Air quality ${w.air.category ?? 'poor'} — AQI ${w.air.aqi}`,
        detail: w.air.pm25 !== undefined ? `PM2.5 ${w.air.pm25} µg/m³` : undefined,
        severity: 'urgent',
        timestamp: now,
      });
    }

    if (w.alert) {
      items.push({
        id: `weather:alert:${key}`,
        source: 'weather',
        title: `Weather alert: ${label}`,
        detail: `Precip chance ${pop}% — plan accordingly`,
        severity: 'urgent',
        timestamp: now,
      });
    }

    // Active NWS alerts surface in the digest / dashboard. They're 'notice' (not
    // 'urgent') on purpose: the dedicated weatherAlerts poller owns the immediate
    // issued/updated/expired prints, so these must not re-fire runPoll/printAlert.
    for (const a of w.alerts) {
      items.push({
        id: `weather:nws:${a.id}`,
        source: 'weather',
        title: a.event,
        detail: a.headline ?? a.areaDesc,
        severity: 'notice',
        timestamp: Date.parse(a.effective ?? a.onset ?? a.sent ?? '') || now,
      });
    }
    return items;
  },
};
