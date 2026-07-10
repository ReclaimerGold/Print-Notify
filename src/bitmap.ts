// Bridges the receipt layout to bitmap assets:
//  - textImage(): render dynamic header/title text to a PNG (cached; calls
//    scripts/render.py only on a cache miss, so steady-state prints spawn nothing).
//  - weatherIconPath(): resolve a pre-generated weather icon (scripts/gen-weather.py).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import type { WeatherGroup } from './weatherArt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const RENDER_PY = join(REPO, 'scripts', 'render.py');
const FORECAST_PY = join(REPO, 'scripts', 'render_forecast.py');
const RECEIPT_PY = join(REPO, 'scripts', 'render_receipt.py');
const WEATHER_DIR = join(REPO, 'branding', 'weather');

/** Print width in dots for full-width bitmaps (matches the logo). */
const PRINT_WIDTH = 384;

const CACHE = join(tmpdir(), 'print-notify-bitmaps');
mkdirSync(CACHE, { recursive: true });

function run(cmd: string, args: string[], label: string): Promise<void> {
  return new Promise((res, rej) => {
    const py = spawn(cmd, args);
    let err = '';
    py.stderr.on('data', (d) => (err += d));
    py.on('error', rej);
    py.on('close', (code) => (code === 0 ? res() : rej(new Error(`${label} ${code}: ${err.trim()}`))));
  });
}

export type TextStyle = 'title' | 'section';

/** Render `text` in the given style to a PNG, caching by content. Returns the path. */
export async function textImage(text: string, style: TextStyle): Promise<string> {
  const key = createHash('sha1').update(`${style}|${PRINT_WIDTH}|${text}`).digest('hex').slice(0, 16);
  const out = join(CACHE, `${style}-${key}.png`);
  if (existsSync(out)) return out;
  await run('python3', [
    RENDER_PY, '--style', style, '--width', String(PRINT_WIDTH), '--text', text, '--out', out,
  ], 'render.py');
  return out;
}

export interface ForecastDay {
  name: string;
  dayGroup: WeatherGroup;
  hi: number;
  nightGroup: WeatherGroup;
  lo: number;
}

/** Compose a 3-day day/night forecast grid to a PNG, cached by content. */
export async function forecastImage(days: ForecastDay[]): Promise<string> {
  const spec = JSON.stringify({ width: PRINT_WIDTH, days });
  const key = createHash('sha1').update(spec).digest('hex').slice(0, 16);
  const out = join(CACHE, `forecast-${key}.png`);
  if (existsSync(out)) return out;
  const specPath = join(CACHE, `forecast-${key}.json`);
  writeFileSync(specPath, spec);
  await run('python3', [FORECAST_PY, '--spec', specPath, '--out', out], 'render_forecast.py');
  return out;
}

/** Compose an ordered block list into a full receipt-preview PNG. Returns the path. */
export async function receiptImage(blocks: unknown[], chars: number): Promise<string> {
  const spec = JSON.stringify({ width: PRINT_WIDTH, margin: 18, chars, blocks });
  const key = createHash('sha1').update(spec).digest('hex').slice(0, 16);
  const out = join(CACHE, `receipt-${key}.png`);
  if (existsSync(out)) return out;
  const specPath = join(CACHE, `receipt-${key}.json`);
  writeFileSync(specPath, spec);
  await run('python3', [RECEIPT_PY, '--spec', specPath, '--out', out], 'render_receipt.py');
  return out;
}

/** Absolute path to a pre-generated weather icon bitmap. */
export function weatherIconPath(group: WeatherGroup): string {
  return join(WEATHER_DIR, `${group}.png`);
}
