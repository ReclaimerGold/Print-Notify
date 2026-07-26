import { config } from '../config.js';
import { weatherGroup } from '../weatherArt.js';
import { weatherIconPath, forecastImage, weatherPanelImage, type ForecastDay } from '../bitmap.js';
import { fetchActiveAlerts, fetchPointContext, type NwsAlert, type PointContext } from '../nws.js';
import type { Source, NotificationItem } from './types.js';

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

/** 3-day day/night forecast starting TOMORROW (skip today's row). */
function buildForecast(d: any): ForecastDay[] {
  const days: ForecastDay[] = [];
  const hTime: string[] = d.hourly?.time ?? [];
  const hCode: number[] = d.hourly?.weather_code ?? [];
  const hIsDay: number[] = d.hourly?.is_day ?? [];
  const hRh: number[] = d.hourly?.relative_humidity_2m ?? [];

  // Start at index 1 (tomorrow); daily arrays hold today + 3 (forecast_days=4).
  for (let i = 1; i <= 3 && i < d.daily.time.length; i++) {
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

/** Next 24h of temperature at 2-hour steps, starting from the current hour. */
function build2hTemps(d: any): HourTemp[] {
  const times: string[] = d.hourly?.time ?? [];
  const temps: number[] = d.hourly?.temperature_2m ?? [];
  if (!times.length) return [];
  const nowMs = Date.now();
  let start = times.findIndex((t) => new Date(t).getTime() >= nowMs);
  if (start < 0) start = 0;
  const out: HourTemp[] = [];
  for (let i = start; i < times.length && out.length < 13; i += 2) {
    out.push({ label: shortHour(times[i]), temp: Math.round(temps[i]) });
  }
  return out;
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
  /** Tonight's moon phase. */
  moon: MoonInfo;
  /** Today's max UV index, if available. */
  uv?: number;
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
async function getJson(url: string, tries = 2, timeoutMs = 8000): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
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

/** Fetch + parse Open-Meteo into structured weather. Throws on a non-OK response. */
export async function fetchWeatherData(): Promise<WeatherData> {
  const { lat, lon } = config.sources.weather;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m` +
    `&hourly=temperature_2m,relative_humidity_2m,weather_code,is_day` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,sunrise,sunset,uv_index_max` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=4`;

  // Fetch conditions, NWS alerts, and the home-point context together; the NWS
  // calls are best-effort so an api.weather.gov hiccup (or a non-US point) never
  // breaks the forecast.
  const [d, alerts, location] = await Promise.all([
    getJson(url),
    config.weatherAlerts.enabled ? fetchActiveAlerts().catch(() => []) : Promise.resolve([]),
    config.weatherAlerts.enabled ? fetchPointContext().catch(() => undefined) : Promise.resolve(undefined),
  ]);

  // Prefer the CURRENT condition for the icon; fall back to the daily code.
  const curCode: number = d.current?.weather_code ?? d.daily.weather_code[0];
  const code: number = d.daily.weather_code[0];
  const label = WMO[curCode] ?? WMO[code] ?? `Code ${curCode}`;
  const isDay = (d.current?.is_day ?? 1) === 1;
  const hi = Math.round(d.daily.temperature_2m_max[0]);
  const lo = Math.round(d.daily.temperature_2m_min[0]);
  const pop = d.daily.precipitation_probability_max[0];
  const temp = d.current?.temperature_2m !== undefined ? Math.round(d.current.temperature_2m) : undefined;
  const wind = d.current?.wind_speed_10m !== undefined ? Math.round(d.current.wind_speed_10m) : undefined;
  const feels = d.current?.apparent_temperature !== undefined ? Math.round(d.current.apparent_temperature) : undefined;
  const humidity = d.current?.relative_humidity_2m !== undefined ? Math.round(d.current.relative_humidity_2m) : undefined;
  const uv = d.daily?.uv_index_max?.[0] !== undefined && d.daily.uv_index_max[0] !== null
    ? Math.round(d.daily.uv_index_max[0]) : undefined;

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
    forecast: buildForecast(d),
    hourly: build2hTemps(d),
    sun: {
      sunrise: d.daily?.sunrise?.[0] ? clock(d.daily.sunrise[0]) : '',
      sunset: d.daily?.sunset?.[0] ? clock(d.daily.sunset[0]) : '',
    },
    moon: moonPhase(new Date()),
    uv,
    alert: SEVERE.has(code) || pop >= 80,
    alerts,
    location,
  };
}

export const weatherSource: Source = {
  name: 'weather',
  enabled: config.sources.weather.enabled,
  async fetch(): Promise<NotificationItem[]> {
    const w = await fetchWeatherData();
    const { label, code, isDay, pop, stats } = w.current;
    const now = Date.now();

    const items: NotificationItem[] = [
      {
        id: `weather:daily:${new Date().toISOString().slice(0, 10)}`,
        source: 'weather',
        title: label,
        detail: stats,
        severity: 'info',
        image: weatherIconPath(weatherGroup(code, isDay)),
        timestamp: now,
      },
      {
        id: `weather:panel:${new Date().toISOString().slice(0, 10)}`,
        source: 'weather',
        title: '',
        severity: 'info',
        image: await weatherPanelImage({
          hourly: w.hourly,
          hi: w.current.hi,
          lo: w.current.lo,
          sun: w.sun,
          moon: w.moon,
          humidity: w.current.humidity,
          uv: w.uv,
        }),
        timestamp: now,
      },
      {
        id: `weather:forecast:${new Date().toISOString().slice(0, 10)}`,
        source: 'weather',
        title: '',
        severity: 'info',
        image: await forecastImage(w.forecast),
        timestamp: now,
      },
    ];

    if (w.alert) {
      items.push({
        id: `weather:alert:${new Date().toISOString().slice(0, 10)}`,
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
