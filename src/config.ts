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
