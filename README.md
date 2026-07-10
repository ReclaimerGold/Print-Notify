# Print-Notify

Pull notifications from APIs, build digests, and print them to an **Epson TM-T88VI**
thermal receipt printer. Web UI + scheduler, running on an always-on Linux box.

## How it prints

The printer is reached through a **CUPS raw queue** named `PrintNotify` (already
created on this machine). The app builds ESC/POS bytes with `node-thermal-printer`
and pipes them to `lp -d PrintNotify -o raw` — no `sudo`, no `lp`-group change.

```
Sources (adapters) -> Digest builder -> ESC/POS bytes -> lp -o raw -> TM-T88VI
        ^                                                   ^
     Scheduler (node-cron)                              Web UI (Express)
```

## Setup

```bash
# 1) Install Node 20+ (no sudo, via nvm):
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install 22

# 2) Install deps
npm install

# 3) Configure
cp .env.example .env      # then fill in coords / tokens / ICS url

# 4) Prove the printer path
npm run test-print        # should print a formatted receipt

# 5) Run
npm run dev               # http://localhost:3000
```

If the CUPS queue is ever missing, recreate it:

```bash
lpadmin -p PrintNotify -E -v 'usb://EPSON/TM-T88VI?serial=583254350587850000' -m raw
```

## Sources (all keyless or low-friction)

| Source     | Auth                    | Enable by setting            |
|------------|-------------------------|------------------------------|
| `weather`  | none (Open-Meteo)       | `WEATHER_LAT` + `WEATHER_LON`|
| `github`   | PAT (`notifications`)   | `GITHUB_TOKEN`               |
| `calendar` | secret `.ics` URL       | `CALENDAR_ICS_URL`           |

A source is only active when its env vars are present, so start with weather and
add the rest as you go.

## Add a new source

1. Create `src/sources/<name>.ts` exporting a `Source` (`{ name, enabled, fetch() }`)
   that returns `NotificationItem[]`.
2. Register it in `src/sources/index.ts`.

That's it — the digest, dedupe, scheduler, and UI pick it up automatically.

## Schedules

- **Morning digest** (`MORNING_DIGEST_CRON`, default 7am): full grouped digest.
- **Urgent poll** (`POLL_CRON`, default every 15 min): prints only *new* urgent
  items, deduped via `data/seen.json`.

## API

| Method | Path           | Does                                   |
|--------|----------------|----------------------------------------|
| GET    | `/api/status`  | sources, schedule, last-run state      |
| GET    | `/api/preview` | items + text preview (no print)        |
| POST   | `/api/print`   | print a full digest now                |
| POST   | `/api/poll`    | print new urgent items now             |
| POST   | `/api/test`    | print a hardware test receipt          |

## Run it as a service (survive reboots)

Once happy, keep it running with a user systemd unit or `pm2`:

```bash
npm i -g pm2 && pm2 start "npm run start" --name print-notify && pm2 save
```
