# Print-Notify

Pull information from APIs, compose a **daily digest**, and print it to an
**Epson TM-T88VI** thermal receipt printer — with a web dashboard, a live
"how it will print" preview, scheduled prints, and an ad-hoc uptime sentinel.

Weather (with a 3-day forecast), a calendar timeline, local news, GitHub PRs,
and pen-checkable Google Tasks / grocery lists — all rendered as crisp bitmaps
(logo, section headers, weather icons) plus the printer's native text.

```
                        ┌───────── Web dashboard (Express) ─────────┐
                        │  status · sources · actions · receipt img │
                        └───────────────────┬───────────────────────┘
 Sources ──▶ Digest builder ──▶ Blocks ──▶ ┴ ──▶ ESC/POS ──▶ lp -o raw ──▶ TM-T88VI
 (weather, calendar,          (shared by print          (CUPS raw queue
  news, github, tasks)         AND the PNG preview)       "PrintNotify")
        ▲                                                        ▲
   Scheduler (node-cron: morning digest + urgent poll)     Sentinel (60s, Visual Sentinel)
```

## Features

- **Digest sources** (each independent; enabled when its config is present):
  - **Weather** — current conditions + a **3-day day/night forecast** (Open-Meteo, no key).
  - **Calendar** — today's events as a **start-to-finish timeline** (Google Calendar secret `.ics`, no OAuth).
  - **Local news** — recent headlines (Google News RSS, no key).
  - **GitHub** — new pull requests from the last 24h (top 3, "+N more").
  - **Google Tasks** — one or more lists (e.g. Tasks + Groceries) as **pen-checkable `[ ]` boxes**.
- **Bitmap rendering** — the Ferrix logo, bold title, white-on-black section bars, weather
  icons, and the forecast grid are drawn as ESC/POS raster images; item text uses the
  printer's font. A single **block model** feeds both the printer and the web preview, so
  the on-screen receipt is exactly what prints.
- **Scheduler** — a full **morning digest** and a periodic **urgent poll** (prints only new
  urgent items, deduped).
- **Sentinel** — polls **Visual Sentinel** every 60s and prints a receipt the moment a monitor
  goes **DOWN**. Never repeats an ongoing outage; re-alerts only on recover-then-fail; no
  all-clear prints (saves paper).
- **Web dashboard** — printer health, source status, one-click actions, and a paper-styled
  live preview.

## Requirements

- Node.js **20+** (22 LTS recommended)
- Python **3** with **Pillow** (`pip install pillow`) — used to render the logo, weather
  icons, and text/receipt bitmaps
- **CUPS** with an Epson TM-T88VI on a **raw** print queue (see below)

## Setup

```bash
# 1) Node (no sudo, via nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install 22

# 2) Dependencies
npm install

# 3) Configure
cp .env.example .env      # fill in coords, tokens, etc. (all optional — enable what you want)

# 4) Prove the printer works
npm run test-print        # should print a Ferrix test receipt

# 5) Run
npm run dev               # http://localhost:3000
```

### Printer queue (CUPS raw)

Print-Notify sends raw ESC/POS bytes to a CUPS **raw** queue — no `sudo`, no `lp`-group
change (works for any user in the `lpadmin` group). Create it once:

```bash
lpadmin -p PrintNotify -E -v 'usb://EPSON/TM-T88VI?serial=<YOUR_SERIAL>' -m raw
```

Find your device URI with `lpinfo -v`. The queue name is configurable via `PRINTER_QUEUE`.

## Configuration

All configuration is via `.env` (see `.env.example` for the annotated list). Highlights:

| Area | Key(s) | Notes |
|------|--------|-------|
| Server | `PORT`, `TZ_NAME` | dashboard port; timezone for schedules & "today" |
| Printer | `PRINTER_QUEUE`, `PRINTER_WIDTH`, `PRINTER_DRY_RUN` | `DRY_RUN=true` writes bytes to `data/last-receipt.bin` instead of printing |
| Schedules | `MORNING_DIGEST_CRON`, `POLL_CRON` | cron strings |
| Weather | `WEATHER_LAT`, `WEATHER_LON` | from open-meteo.com |
| Calendar | `CALENDAR_ICS_URL` | Google Calendar → *Secret address in iCal format* |
| News | `NEWS_ENABLED`, `NEWS_QUERY`, `NEWS_LIMIT` | on by default |
| GitHub | `GITHUB_TOKEN` | PAT with `notifications` scope |
| Google Tasks | `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`, `GOOGLE_TASKS_LISTS` | see below |
| Sentinel | `VS_API_KEY`, `SENTINEL_INTERVAL` | Visual Sentinel key |

### Google Tasks (one-time OAuth)

Keep has no personal API, so task/grocery lists come from **Google Tasks**:

1. [console.cloud.google.com](https://console.cloud.google.com) → new project → **enable the Google Tasks API**.
2. **Credentials → Create OAuth client → type "Desktop app"**; put the id/secret in `.env`.
3. Set the **OAuth consent screen** to *Internal* (Workspace) or *External → Production*.
4. Run `npm run google-auth`, approve in the browser, and paste the printed
   `GOOGLE_REFRESH_TOKEN` into `.env`.
5. Ensure your lists (`GOOGLE_TASKS_LISTS`, default `Tasks,Groceries`) exist in Google Tasks.

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Run with reload (dashboard at `http://localhost:3000`) |
| `npm run start` | Run without reload (for services) |
| `npm run test-print` | Print a Ferrix test receipt |
| `npm run google-auth` | One-time Google Tasks OAuth helper |
| `npm run typecheck` | `tsc --noEmit` |
| `python3 scripts/gen-logo.py` | Regenerate the logo bitmap from `branding/ferrix-logo.png` |
| `python3 scripts/gen-weather.py` | Regenerate the weather icon bitmaps |

## HTTP API

| Method | Path | Does |
|--------|------|------|
| GET | `/api/status` | sources, schedule, last-run state |
| GET | `/api/printer` | live queue/printer info |
| GET | `/api/preview` | item counts + source errors (no print) |
| GET | `/api/receipt.png` | the digest rendered as a PNG (the live preview) |
| POST | `/api/print` | print a full digest now |
| POST | `/api/poll` | print new urgent items now |
| POST | `/api/test` | print a hardware test receipt |

## Run as a service (survive reboots)

```bash
npm i -g pm2
pm2 start "npm run start" --name print-notify
pm2 save && pm2 startup      # follow the printed instruction
```

## How it's organized

```
src/
  index.ts            entrypoint (server + scheduler)
  config.ts           all env-driven configuration
  server.ts           Express API + static dashboard
  scheduler.ts        node-cron jobs; starts the sentinel
  sentinel.ts         Visual Sentinel polling + DOWN alerts
  visualSentinel.ts   Visual Sentinel REST client
  digest.ts           block model, digest/alert builders, printer + preview
  printer.ts          ESC/POS buffer -> CUPS raw queue
  printerInfo.ts      lpstat-based printer status
  bitmap.ts           bridges layout to Python bitmap renderers (cached)
  logo.ts             logo bitmap header
  weatherArt.ts       WMO code -> icon group
  googleTasks.ts      Google Tasks OAuth + API client
  store.ts            dedupe state for the urgent poll
  sources/            weather, calendar, news, github, tasks (+ registry, types)
scripts/              *.py bitmap renderers, test-print, google-auth
branding/             logo + generated weather icons
public/               dashboard (index.html) + served logo
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a source and the bitmap-rendering
details.

## License

See [LICENSE](LICENSE) if present; otherwise all rights reserved by the author.
