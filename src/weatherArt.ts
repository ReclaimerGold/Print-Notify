// Maps an Open-Meteo WMO weather code (+ day/night) to an icon group. The icons
// themselves are pre-generated bitmaps in branding/weather/ (scripts/gen-weather.py),
// resolved via weatherIconPath() in bitmap.ts.

export type WeatherGroup =
  | 'sun' | 'moon' | 'partly-day' | 'partly-night'
  | 'cloud' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';

export function weatherGroup(code: number, isDay: boolean): WeatherGroup {
  if (code === 0 || code === 1) return isDay ? 'sun' : 'moon';
  if (code === 2) return isDay ? 'partly-day' : 'partly-night';
  if (code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return 'snow';
  if (code >= 95) return 'storm';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  return 'cloud';
}
