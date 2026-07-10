import { config } from '../config.js';
import { weatherGroup } from '../weatherArt.js';
import { weatherIconPath, forecastImage, type ForecastDay } from '../bitmap.js';
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

/** Build a 3-day day/night forecast from Open-Meteo daily + hourly arrays. */
function buildForecast(d: any): ForecastDay[] {
  const days: ForecastDay[] = [];
  const hTime: string[] = d.hourly?.time ?? [];
  const hCode: number[] = d.hourly?.weather_code ?? [];
  const hIsDay: number[] = d.hourly?.is_day ?? [];

  for (let i = 0; i < Math.min(3, d.daily.time.length); i++) {
    const date: string = d.daily.time[i]; // YYYY-MM-DD (local tz)
    const dayCodes: number[] = [];
    const nightCodes: number[] = [];
    for (let h = 0; h < hTime.length; h++) {
      if (!hTime[h].startsWith(date)) continue;
      (hIsDay[h] === 1 ? dayCodes : nightCodes).push(hCode[h]);
    }
    const dayCode = mode(dayCodes) ?? d.daily.weather_code[i];
    const nightCode = mode(nightCodes) ?? d.daily.weather_code[i];
    days.push({
      name: new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
        weekday: 'short', timeZone: config.timezone,
      }),
      dayGroup: weatherGroup(dayCode, true),
      hi: Math.round(d.daily.temperature_2m_max[i]),
      nightGroup: weatherGroup(nightCode, false),
      lo: Math.round(d.daily.temperature_2m_min[i]),
    });
  }
  return days;
}

export const weatherSource: Source = {
  name: 'weather',
  enabled: config.sources.weather.enabled,
  async fetch(): Promise<NotificationItem[]> {
    const { lat, lon } = config.sources.weather;
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code,is_day,wind_speed_10m` +
      `&hourly=weather_code,is_day` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=3`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const d: any = await res.json();

    const now = Date.now();
    // Prefer the CURRENT condition for the icon; fall back to the daily code.
    const curCode: number = d.current?.weather_code ?? d.daily.weather_code[0];
    const code: number = d.daily.weather_code[0];
    const label = WMO[curCode] ?? WMO[code] ?? `Code ${curCode}`;
    const isDay = (d.current?.is_day ?? 1) === 1;
    const hi = Math.round(d.daily.temperature_2m_max[0]);
    const lo = Math.round(d.daily.temperature_2m_min[0]);
    const pop = d.daily.precipitation_probability_max[0];
    const cur = d.current?.temperature_2m !== undefined ? Math.round(d.current.temperature_2m) : undefined;
    const wind = d.current?.wind_speed_10m !== undefined ? Math.round(d.current.wind_speed_10m) : undefined;

    const stats = [
      cur !== undefined ? `Now ${cur}°F` : null,
      `Hi ${hi}  Lo ${lo}`,
      `Precip ${pop}%`,
      wind !== undefined ? `Wind ${wind} mph` : null,
    ].filter(Boolean).join('   ·   ');

    const items: NotificationItem[] = [
      {
        id: `weather:daily:${new Date().toISOString().slice(0, 10)}`,
        source: 'weather',
        title: label,
        detail: stats,
        severity: 'info',
        image: weatherIconPath(weatherGroup(curCode, isDay)),
        timestamp: now,
      },
      {
        id: `weather:forecast:${d.daily.time[0]}`,
        source: 'weather',
        title: '',
        severity: 'info',
        image: await forecastImage(buildForecast(d)),
        timestamp: now,
      },
    ];

    if (SEVERE.has(code) || pop >= 80) {
      items.push({
        id: `weather:alert:${new Date().toISOString().slice(0, 10)}`,
        source: 'weather',
        title: `Weather alert: ${label}`,
        detail: `Precip chance ${pop}% — plan accordingly`,
        severity: 'urgent',
        timestamp: now,
      });
    }
    return items;
  },
};
