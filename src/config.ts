import 'dotenv/config';

const num = (v: string | undefined, fallback: number) =>
  v && !Number.isNaN(Number(v)) ? Number(v) : fallback;

export const config = {
  server: {
    port: num(process.env.PORT, 3000),
    // Loopback by default: the API can print, wipe the queue, and read your
    // calendar and tasks. Exposing it (HOST=0.0.0.0) requires a password.
    host: process.env.HOST || '127.0.0.1',
    // HTTP Basic password (any username) guarding the dashboard and API. The
    // webhook keeps its own WEBHOOK_TOKEN so automations don't need this.
    password: process.env.DASHBOARD_PASSWORD ?? '',
  },
  timezone: process.env.TZ_NAME ?? 'America/Chicago',
  printer: {
    queue: process.env.PRINTER_QUEUE ?? 'PrintNotify',
    width: num(process.env.PRINTER_WIDTH, 42),
    dryRun: (process.env.PRINTER_DRY_RUN ?? 'false').toLowerCase() === 'true',
  },
  schedule: {
    morningDigest: process.env.MORNING_DIGEST_CRON ?? '0 7 * * *',
    // Evening digest: the same sources shifted to the 'tomorrow' horizon, so it
    // prints tomorrow's calendar/forecast and what's still open — while there's
    // still time to act on it. Set EVENING_DIGEST_CRON= (empty) to disable.
    eveningDigest: process.env.EVENING_DIGEST_CRON ?? '0 18 * * *',
    // Offset off the quarter-hour on purpose. At `*/15` the poll fires at :00,
    // which is exactly when the morning digest fires — both then run a full
    // fetchAll() on the same tick, doubling every source's upstream load at the
    // one moment of the day nobody is watching. Starting at :07 keeps them apart.
    pollUrgent: process.env.POLL_CRON ?? '7,22,37,52 * * * *',
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
      // How long a cached reading may still be served after the API starts
      // failing. Open-Meteo 503s transiently, and the 7am digest is the worst
      // possible moment to drop the weather section entirely — three-hour-old
      // conditions beat "Unavailable". Past this the source fails honestly.
      staleMinutes: num(process.env.WEATHER_STALE_MINUTES, 180),
      // Air quality (US AQI + PM2.5) and pollen from Open-Meteo's air-quality
      // API — same vendor, same keyless deal, separate host. Pollen is a
      // European-model product, so it's simply absent outside its domain and the
      // panel drops the line. Best-effort: a failure never breaks the forecast.
      airQuality: (process.env.WEATHER_AIR_QUALITY ?? 'true').toLowerCase() !== 'false',
      // US AQI at or above this prints an urgent air-quality item.
      aqiAlert: num(process.env.WEATHER_AQI_ALERT, 101),
    },
    github: {
      enabled: Boolean(process.env.GITHUB_TOKEN),
      token: process.env.GITHUB_TOKEN ?? '',
    },
    calendar: {
      enabled: Boolean(process.env.CALENDAR_ICS_URL),
      icsUrl: process.env.CALENDAR_ICS_URL ?? '',
    },
    // Upcoming birthdays/anniversaries pulled from an ICS feed. Google publishes
    // contact birthdays as a yearly-recurring all-day event, so we project
    // RRULE:FREQ=YEARLY forward and keep anything inside the window. Defaults to
    // the main calendar feed; point BIRTHDAYS_ICS_URL at a dedicated calendar
    // (Google's "Birthdays" calendar has its own secret .ics) to separate them.
    birthdays: {
      enabled: Boolean(process.env.BIRTHDAYS_ICS_URL || process.env.CALENDAR_ICS_URL) &&
        (process.env.BIRTHDAYS_ENABLED ?? 'true').toLowerCase() !== 'false',
      icsUrl: process.env.BIRTHDAYS_ICS_URL || process.env.CALENDAR_ICS_URL || '',
      // How far ahead to look, in days.
      windowDays: num(process.env.BIRTHDAYS_WINDOW_DAYS, 45),
      // Case-insensitive substrings marking an event as a birthday/anniversary.
      // Only consulted when the feed is shared with regular events (i.e. when
      // BIRTHDAYS_ICS_URL is unset); a dedicated feed takes every event.
      keywords: (process.env.BIRTHDAYS_KEYWORDS ?? "birthday,bday,anniversary,'s day")
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    },
    // TLS certificate + domain registration expiry. Certificates come from a
    // direct TLS handshake (no API); domain expiry comes from RDAP (rdap.org,
    // keyless). Both are best-effort per host — one unreachable host never sinks
    // the rest of the section.
    certs: {
      enabled: Boolean(process.env.CERT_WATCH),
      // Comma-separated hosts, e.g. "fallstech.group,visualsentinel.com:443".
      hosts: (process.env.CERT_WATCH ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean),
      // Also look up domain-registration expiry via RDAP for each host's
      // registrable domain. Off is cheaper (one fewer network call per host).
      checkDomains: (process.env.CERT_CHECK_DOMAINS ?? 'true').toLowerCase() !== 'false',
      // Only surface an entry once it's inside this many days of expiring —
      // otherwise a healthy fleet prints a wall of "valid for 300 days" rows.
      noticeDays: num(process.env.CERT_NOTICE_DAYS, 30),
      // Inside this many days it becomes 'urgent' (so the poll wakes the printer).
      urgentDays: num(process.env.CERT_URGENT_DAYS, 7),
      timeoutMs: num(process.env.CERT_TIMEOUT_MS, 8000),
    },
    // Scores via ESPN's public scoreboard endpoints (keyless, undocumented but
    // long-stable). Each entry is "<league>:<team abbreviation>", e.g.
    // "nfl:MIN,mlb:MIN,ncaaf:SDSU". See LEAGUE_PATHS in sources/sports.ts.
    sports: {
      enabled: Boolean(process.env.SPORTS_TEAMS),
      teams: (process.env.SPORTS_TEAMS ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean),
      // How far back a final score still counts as "last night's result".
      lookbackHours: num(process.env.SPORTS_LOOKBACK_HOURS, 36),
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
  // Print reliability. Every receipt goes through a queue that checks the CUPS
  // queue + USB presence first; when the printer is out of paper, has its cover
  // open, or is disabled, the job is persisted and retried instead of being
  // swallowed by CUPS. This is what makes an unattended 7am digest trustworthy.
  printQueue: {
    enabled: (process.env.PRINT_QUEUE_ENABLED ?? 'true').toLowerCase() !== 'false',
    // How often to retry held jobs.
    retrySec: num(process.env.PRINT_QUEUE_RETRY_SEC, 60),
    // Give up on a job after this long (default 12h) so a week-long outage
    // doesn't dump a stack of stale digests when paper is finally loaded.
    maxAgeHours: num(process.env.PRINT_QUEUE_MAX_AGE_HOURS, 12),
    // Cap the backlog; oldest held jobs are dropped past this.
    maxJobs: num(process.env.PRINT_QUEUE_MAX_JOBS, 20),
  },
  // Keep a rolling archive of rendered receipts (PNG + metadata) so the
  // dashboard can answer "what did it print on Tuesday?".
  archive: {
    enabled: (process.env.RECEIPT_ARCHIVE_ENABLED ?? 'true').toLowerCase() !== 'false',
    keep: num(process.env.RECEIPT_ARCHIVE_KEEP, 30),
    dir: process.env.RECEIPT_ARCHIVE_DIR ?? 'data/receipts',
  },
  // Token-guarded inbound trigger (POST /api/hooks/print) for Home Assistant,
  // iOS Shortcuts, a physical button, etc. Disabled until a token is set.
  webhook: {
    enabled: Boolean(process.env.WEBHOOK_TOKEN),
    token: process.env.WEBHOOK_TOKEN ?? '',
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
