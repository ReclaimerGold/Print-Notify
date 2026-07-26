import 'dotenv/config';

const num = (v: string | undefined, fallback: number) =>
  v && !Number.isNaN(Number(v)) ? Number(v) : fallback;

export const config = {
  server: {
    port: num(process.env.PORT, 3000),
  },
  timezone: process.env.TZ_NAME ?? 'America/Chicago',
  printer: {
    queue: process.env.PRINTER_QUEUE ?? 'PrintNotify',
    width: num(process.env.PRINTER_WIDTH, 42),
    dryRun: (process.env.PRINTER_DRY_RUN ?? 'false').toLowerCase() === 'true',
  },
  schedule: {
    morningDigest: process.env.MORNING_DIGEST_CRON ?? '0 7 * * *',
    pollUrgent: process.env.POLL_CRON ?? '*/15 * * * *',
  },
  sources: {
    weather: {
      enabled: Boolean(process.env.WEATHER_LAT && process.env.WEATHER_LON),
      lat: process.env.WEATHER_LAT ?? '',
      lon: process.env.WEATHER_LON ?? '',
      // Open-Meteo rate-limits (HTTP 503) when hit too often, and every
      // dashboard/preview/poll/digest funnels through fetchWeatherData. Cache
      // the assembled conditions this many minutes so we call the API at most
      // once per window regardless of how many consumers ask. 15 min is plenty
      // fresh for a printed digest and well under any sane rate limit.
      cacheMinutes: num(process.env.WEATHER_CACHE_MINUTES, 15),
    },
    github: {
      enabled: Boolean(process.env.GITHUB_TOKEN),
      token: process.env.GITHUB_TOKEN ?? '',
    },
    calendar: {
      enabled: Boolean(process.env.CALENDAR_ICS_URL),
      icsUrl: process.env.CALENDAR_ICS_URL ?? '',
    },
    news: {
      // Keyless (Google News RSS); on by default. Set NEWS_ENABLED=false to disable.
      enabled: (process.env.NEWS_ENABLED ?? 'true').toLowerCase() !== 'false',
      query: process.env.NEWS_QUERY ?? 'Sioux Falls, SD',
      limit: num(process.env.NEWS_LIMIT, 5),
      // Case-insensitive substrings; a news item is dropped when any appears in
      // its headline, outlet, or URL. Defaults target obituaries/death notices.
      // Set NEWS_EXCLUDE= (empty) to disable filtering.
      exclude: (process.env.NEWS_EXCLUDE ??
        'obituary,obituaries,obit,death notice,in memoriam,funeral home,legacy.com')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    },
    googleTasks: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? '',
      enabled: Boolean(
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN,
      ),
      // Which list titles to print (case-insensitive). Empty = all lists.
      lists: (process.env.GOOGLE_TASKS_LISTS ?? 'Tasks,Groceries')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      showCompleted: (process.env.GOOGLE_TASKS_SHOW_COMPLETED ?? 'false').toLowerCase() === 'true',
      authPort: num(process.env.GOOGLE_AUTH_PORT, 4571),
    },
  },
  // Grocery price estimates: annotate the Groceries checklist with per-item
  // price estimates + a total, using the nearest city (reverse-geocoded from
  // WEATHER_LAT/LON). Live prices come from SerpAPI (Google Shopping), cached
  // 30 days in a local SQLite db; the bundled region-adjusted seed table is the
  // fallback when there's no SerpAPI key, the budget is spent, or nothing
  // matches. Off by default; on any error the list simply prints without prices.
  groceryPrices: {
    enabled: (process.env.GROCERY_PRICES_ENABLED ?? 'false').toLowerCase() === 'true',
    serpApiKey: process.env.SERPAPI_KEY ?? '',
    // SerpAPI free-plan caps — searches are skipped (falling back to the seed)
    // once either is reached, so we never overrun the quota.
    monthlyLimit: num(process.env.SERPAPI_MONTHLY_LIMIT, 250),
    hourlyLimit: num(process.env.SERPAPI_HOURLY_LIMIT, 50),
    // How long a cached price stays fresh before a re-search.
    cacheDays: num(process.env.GROCERY_PRICE_CACHE_DAYS, 30),
  },
  // National Weather Service alerts (api.weather.gov, keyless, US-only). Polls
  // active warnings/advisories/watches for WEATHER_LAT/LON and prints an alert
  // receipt the moment one is issued, updated, or expires. On any error or a
  // non-US point the feed is simply empty. Auto-on whenever weather is enabled.
  weatherAlerts: {
    enabled:
      Boolean(process.env.WEATHER_LAT && process.env.WEATHER_LON) &&
      (process.env.WEATHER_ALERTS_ENABLED ?? 'true').toLowerCase() !== 'false',
    intervalSec: num(process.env.WEATHER_ALERTS_INTERVAL, 120),
    // Alert categories that trigger an immediate printout (by the last word of
    // the NWS `event`, e.g. "Tornado Warning" -> warning). Others still appear
    // in the digest but never wake the printer.
    printTypes: (process.env.WEATHER_ALERTS_PRINT_TYPES ?? 'warning,advisory,watch')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    // NWS asks every client to send an identifying User-Agent with contact info.
    userAgent: process.env.NWS_USER_AGENT ?? 'print-notify (ryan@fallstech.group)',
  },
  // Uptime sentinel: prints an alert receipt the moment a monitor goes DOWN.
  sentinel: {
    enabled: (process.env.SENTINEL_ENABLED ?? 'true').toLowerCase() !== 'false',
    intervalSec: num(process.env.SENTINEL_INTERVAL, 60),
  },
  // Visual Sentinel (https://visualsentinel.com) — hosted uptime monitoring.
  visualSentinel: {
    apiKey: process.env.VS_API_KEY ?? '',
    baseUrl: process.env.VS_BASE_URL ?? 'https://visualsentinel.com',
  },
};

export type Config = typeof config;
