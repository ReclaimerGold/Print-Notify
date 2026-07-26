// Bridges the receipt layout to bitmap assets:
//  - textImage(): render dynamic header/title text to a PNG (cached; calls
//    scripts/render.py only on a cache miss, so steady-state prints spawn nothing).
//  - weatherIconPath(): resolve a pre-generated weather icon (scripts/gen-weather.py).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import type { WeatherGroup } from './weatherArt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const RENDER_PY = join(REPO, 'scripts', 'render.py');
const FORECAST_PY = join(REPO, 'scripts', 'render_forecast.py');
const WEATHER_PY = join(REPO, 'scripts', 'render_weather.py');
const RECEIPT_PY = join(REPO, 'scripts', 'render_receipt.py');
const CHECKLIST_PY = join(REPO, 'scripts', 'render_checklist.py');
const LIST_PY = join(REPO, 'scripts', 'render_list.py');
const WEATHER_DIR = join(REPO, 'branding', 'weather');

/** Full print width in dots (42 Font-A cols × 12 dots — the usable head width). */
const PRINT_WIDTH = 504;

const CACHE = join(tmpdir(), 'print-notify-bitmaps');
mkdirSync(CACHE, { recursive: true });

/**
 * Short content hash of a file (or a directory's files), folded into every
 * cache key below. This makes the cache self-invalidating: edit a render script
 * or regenerate an asset and its cached PNGs are considered stale automatically,
 * instead of serving an old bitmap for unchanged content.
 */
function fileVersion(path: string): string {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex').slice(0, 8);
  } catch {
    return '0';
  }
}
function dirVersion(dir: string): string {
  try {
    const h = createHash('sha1');
    for (const f of readdirSync(dir).sort()) h.update(f).update(readFileSync(join(dir, f)));
    return h.digest('hex').slice(0, 8);
  } catch {
    return '0';
  }
}

const RENDER_VER = fileVersion(RENDER_PY);
const FORECAST_VER = fileVersion(FORECAST_PY);
const WEATHER_VER_PY = fileVersion(WEATHER_PY);
const RECEIPT_VER = fileVersion(RECEIPT_PY);
const CHECKLIST_VER = fileVersion(CHECKLIST_PY);
const LIST_VER = fileVersion(LIST_PY);
const WEATHER_VER = dirVersion(WEATHER_DIR); // receipts/forecasts embed icons by static path

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
  const key = createHash('sha1').update(`${RENDER_VER}|${style}|${PRINT_WIDTH}|${text}`).digest('hex').slice(0, 16);
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
  /** Mean relative humidity for the day (%), if available. */
  humidity?: number;
}

export interface WeatherPanelSpec {
  hourly: { label: string; temp: number }[];
  hi: number;
  lo: number;
  sun: { sunrise: string; sunset: string };
  moon: { name: string; illum: number; waxing: boolean };
  humidity?: number;
  uv?: number;
}

/** Compose the rich weather panel — a 2-hourly temperature graph plus a sun &
 *  moon row — into one PNG, cached by content. */
export async function weatherPanelImage(spec: WeatherPanelSpec): Promise<string> {
  const json = JSON.stringify({ width: PRINT_WIDTH, ...spec });
  const key = createHash('sha1').update(`${WEATHER_VER_PY}|${json}`).digest('hex').slice(0, 16);
  const out = join(CACHE, `weather-${key}.png`);
  if (existsSync(out)) return out;
  const specPath = join(CACHE, `weather-${key}.json`);
  writeFileSync(specPath, json);
  await run('python3', [WEATHER_PY, '--spec', specPath, '--out', out], 'render_weather.py');
  return out;
}

/** Compose a 3-day day/night forecast grid to a PNG, cached by content. */
export async function forecastImage(days: ForecastDay[]): Promise<string> {
  const spec = JSON.stringify({ width: PRINT_WIDTH, days });
  const key = createHash('sha1').update(`${FORECAST_VER}|${WEATHER_VER}|${spec}`).digest('hex').slice(0, 16);
  const out = join(CACHE, `forecast-${key}.png`);
  if (existsSync(out)) return out;
  const specPath = join(CACHE, `forecast-${key}.json`);
  writeFileSync(specPath, spec);
  await run('python3', [FORECAST_PY, '--spec', specPath, '--out', out], 'render_forecast.py');
  return out;
}

export interface ChecklistSection { name: string; columns: number; total?: string; items: { text: string; checked: boolean; due?: string; overdue?: boolean; price?: string }[] }
export interface ChecklistSpec { title: string; date: string; sections: ChecklistSection[] }

/** Compose a compact pen-checkable checklist into a PNG, cached by content. */
export async function checklistImage(spec: ChecklistSpec): Promise<string> {
  const json = JSON.stringify({ width: PRINT_WIDTH, ...spec });
  const key = createHash('sha1').update(`${CHECKLIST_VER}|${json}`).digest('hex').slice(0, 16);
  const out = join(CACHE, `checklist-${key}.png`);
  if (existsSync(out)) return out;
  const specPath = join(CACHE, `checklist-${key}.json`);
  writeFileSync(specPath, json);
  await run('python3', [CHECKLIST_PY, '--spec', specPath, '--out', out], 'render_checklist.py');
  return out;
}

/** One row of a styled section list: bold `primary` (wraps), optional bold
 *  left-column label (e.g. a time), optional non-bold metadata subline, and an
 *  optional marker glyph drawn in the left bullet column (e.g. a GitHub icon). */
export interface ListRow { left?: string; primary: string; sub?: string; icon?: string }

/**
 * Render a section's items (news, calendar, …) as one bitmap with proportional
 * fonts and a clear hierarchy, cached by content. `divider` draws light dashed
 * separators between rows (used for news stories).
 */
export async function listImage(rows: ListRow[], divider = false): Promise<string> {
  const spec = JSON.stringify({ width: PRINT_WIDTH, divider, items: rows });
  const key = createHash('sha1').update(`${LIST_VER}|${spec}`).digest('hex').slice(0, 16);
  const out = join(CACHE, `list-${key}.png`);
  if (existsSync(out)) return out;
  const specPath = join(CACHE, `list-${key}.json`);
  writeFileSync(specPath, spec);
  await run('python3', [LIST_PY, '--spec', specPath, '--out', out], 'render_list.py');
  return out;
}

/** Compose an ordered block list into a full receipt-preview PNG. Returns the path. */
export async function receiptImage(blocks: unknown[], chars: number): Promise<string> {
  const spec = JSON.stringify({ width: PRINT_WIDTH, margin: 18, chars, blocks });
  const key = createHash('sha1').update(`${RECEIPT_VER}|${WEATHER_VER}|${spec}`).digest('hex').slice(0, 16);
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
