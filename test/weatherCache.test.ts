import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWeatherData, clearWeatherCache } from '../src/sources/weather.js';

// A minimal Open-Meteo-shaped payload; only the fields the parser reads.
const forecastBody = () => ({
  current: { temperature_2m: 70, apparent_temperature: 68, relative_humidity_2m: 50, weather_code: 0, is_day: 1, wind_speed_10m: 5 },
  hourly: {
    time: Array.from({ length: 144 }, (_, i) => `2026-08-1${Math.floor(i / 24)}T${String(i % 24).padStart(2, '0')}:00`),
    temperature_2m: Array.from({ length: 144 }, () => 70),
    relative_humidity_2m: Array.from({ length: 144 }, () => 50),
    weather_code: Array.from({ length: 144 }, () => 0),
    is_day: Array.from({ length: 144 }, (_, i) => (i % 24 >= 6 && i % 24 < 20 ? 1 : 0)),
  },
  daily: {
    time: ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'],
    temperature_2m_max: [80, 82, 79, 82, 81, 80],
    temperature_2m_min: [60, 66, 67, 66, 65, 64],
    precipitation_probability_max: [10, 20, 30, 20, 10, 10],
    weather_code: [0, 0, 0, 0, 0, 0],
    sunrise: Array(6).fill('2026-08-12T06:28'),
    sunset: Array(6).fill('2026-08-12T20:35'),
    uv_index_max: [6, 6, 6, 6, 6, 6],
    daylight_duration: [50932, 50780, 50625, 50470, 50315, 50160],
  },
});

const realFetch = globalThis.fetch;
let hits: number;
let mode: 'ok' | 'fail';

function install() {
  hits = 0;
  mode = 'ok';
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (!u.includes('open-meteo')) return realFetch(url);
    hits++;
    if (mode === 'fail') return new Response('', { status: 503 });
    const body = u.includes('air-quality')
      ? { current: { us_aqi: 39, pm2_5: 5.3, grass_pollen: null, birch_pollen: null, ragweed_pollen: null } }
      : forecastBody();
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

beforeEach(() => {
  install();
  clearWeatherCache();
});

test('a second call inside the cache window makes no new request', async () => {
  await fetchWeatherData();
  const afterFirst = hits;
  await fetchWeatherData();
  assert.equal(hits, afterFirst, 'expected the second call to be served from cache');
});

test('concurrent callers share one upstream request', async () => {
  // This is the 07:00:00 case: the digest cron and the poll cron fire on the
  // same tick, so neither has populated the cache yet.
  await Promise.all([fetchWeatherData(), fetchWeatherData(), fetchWeatherData(), fetchWeatherData()]);
  // 1 forecast + 1 air-quality, not 4 of each.
  assert.equal(hits, 2, `4 concurrent callers made ${hits} requests`);
});

test('today and tomorrow are cached separately', async () => {
  await fetchWeatherData();
  const afterToday = hits;
  await fetchWeatherData({ day: 'tomorrow' });
  assert.ok(hits > afterToday, 'tomorrow should not be served from the today cache');
});

/**
 * Run `fn` with the clock advanced past the cache window, so the next call has
 * to go upstream but still has a cached entry to fall back on. Advancing the
 * clock beats reaching into module state — it exercises the real expiry path.
 */
async function afterCacheExpires<T>(fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + 16 * 60_000; // just past the 15-minute default
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

test('a 503 falls back to the last good reading rather than dropping weather', async () => {
  const good = await fetchWeatherData();
  assert.equal(good.stale, undefined);

  mode = 'fail';
  const fallback = await afterCacheExpires(() => fetchWeatherData());
  // The whole point: the morning digest prints yesterday-evening's conditions
  // rather than an "Unavailable" placeholder where the weather should be.
  assert.equal(fallback.stale, true);
  assert.equal(fallback.current.hi, good.current.hi);
  assert.equal(fallback.fetchedAt, good.fetchedAt);
});

test('a stale reading past WEATHER_STALE_MINUTES is not served', async () => {
  await fetchWeatherData();
  mode = 'fail';
  const realNow = Date.now;
  Date.now = () => realNow() + 200 * 60_000; // past the 180-minute default
  try {
    await assert.rejects(() => fetchWeatherData(), /503/);
  } finally {
    Date.now = realNow;
  }
});

test('with no cached reading at all, a 503 fails honestly', async () => {
  mode = 'fail';
  await assert.rejects(() => fetchWeatherData(), /503/);
});

test('a failed fetch does not wedge the in-flight slot', async () => {
  mode = 'fail';
  await assert.rejects(() => fetchWeatherData(), /503/);
  // A later attempt must be able to try again rather than await a dead promise.
  mode = 'ok';
  const recovered = await fetchWeatherData();
  assert.equal(recovered.stale, undefined);
});
