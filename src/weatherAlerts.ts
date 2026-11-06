// NWS weather-alert sentinel — every `intervalSec` it polls the active
// warnings/advisories/watches for WEATHER_LAT/LON and prints an alert receipt the
// moment one is issued, updated/superseded, or expires.
//
// Rules (mirrors the uptime sentinel in sentinel.ts):
//   - Only the configured categories (config.weatherAlerts.printTypes) print.
//   - NEW when an alert first appears; never repeats for an ongoing one.
//   - UPDATED when a new alert supersedes a known one (via `references` /
//     messageType), or an alert changes in place.
//   - EXPIRED when a known alert drops out of the feed and wasn't superseded.
//   - On first run, baseline existing alerts silently (no paper dump).
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonSync } from './jsonFile.js';
import { config } from './config.js';
import { printReceipt, type Block } from './digest.js';
import { LOGO_PRINT_PATH } from './logo.js';
import { textImage } from './bitmap.js';
import {
  fetchActiveAlerts, fetchPointContext, cachedPointContext,
  alertCategory, isImmediate, type NwsAlert,
} from './nws.js';

const STATE_FILE = 'data/weather-alerts.json';

type Transition = 'new' | 'updated' | 'expired';

/** Just enough of an alert to print an expiry notice after it's left the feed,
 *  plus the contextual detail (counties, narrative, call-to-action) that makes an
 *  alert receipt actionable. */
interface StoredAlert {
  id: string;
  event: string;
  headline?: string;
  nwsHeadline?: string;
  areaDesc?: string;
  areas: string[];
  severity: string;
  urgency: string;
  certainty: string;
  senderName?: string;
  description?: string;
  instruction?: string;
  effective?: string;
  expires?: string;
  category: string;
  sig: string;
}

interface AlertEvent {
  kind: Transition;
  alert: StoredAlert;
}

// id -> stored snapshot of the immediate-category alerts we've already seen.
let active = new Map<string, StoredAlert>();
let baselined = false;
let lastAlerts: NwsAlert[] = [];
let lastError: string | undefined;
let lastCheck: string | undefined;

/** Signature to detect a same-id in-place edit (rare; updates usually get a new id). */
function signature(a: NwsAlert): string {
  return [a.messageType, a.sent ?? '', a.expires ?? a.ends ?? ''].join('|');
}

function toStored(a: NwsAlert): StoredAlert {
  return {
    id: a.id,
    event: a.event,
    headline: a.headline,
    nwsHeadline: a.nwsHeadline,
    areaDesc: a.areaDesc,
    areas: a.areas,
    severity: a.severity,
    urgency: a.urgency,
    certainty: a.certainty,
    senderName: a.senderName,
    description: a.description,
    instruction: a.instruction,
    effective: a.effective ?? a.onset,
    expires: a.expires ?? a.ends,
    category: alertCategory(a),
    sig: signature(a),
  };
}

function loadState(): void {
  if (!existsSync(STATE_FILE)) return;
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    active = new Map(Object.entries(saved.active ?? {}));
    baselined = Boolean(saved.baselined);
  } catch {
    /* start fresh */
  }
}

function saveState(): void {
  try {
    writeJsonSync(STATE_FILE, { baselined, active: Object.fromEntries(active) });
  } catch {
    /* non-fatal */
  }
}

function stamp(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleString('en-US', {
    timeZone: config.timezone,
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

const BADGE: Record<Transition, string> = {
  new: 'NEW ALERT',
  updated: 'UPDATED',
  expired: 'EXPIRED',
};

/** A short local time: "9:15 PM" when it's today, "Sat 9:15 PM" otherwise. */
function shortWhen(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => x.toLocaleDateString('en-US', { timeZone: config.timezone });
  const sameDay = day(d) === day(new Date());
  return d.toLocaleString('en-US', {
    timeZone: config.timezone,
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: 'numeric', minute: '2-digit',
  });
}

/** Collapse whitespace and cap a string to `n` chars (ASCII "..." — the thermal
 *  charset has no ellipsis glyph). */
function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 3).trimEnd()}...` : flat;
}

/** The first sentence of a blob (or the whole thing if short), capped. */
function firstSentence(s?: string, cap = 150): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  const dot = flat.indexOf('. ');
  return clip(dot > 0 ? flat.slice(0, dot + 1) : flat, cap);
}

/** Pull the structured "* WHAT.../HAZARD.../IMPACT..." segments out of an NWS
 *  description so we can show just the essentials instead of the whole bulletin.
 *  Fields are "NAME...value" runs (name may be multi-word, e.g. "HAIL THREAT"). */
function segments(desc?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!desc) return out;
  const text = desc.replace(/\s+/g, ' ').trim();
  const field = /([A-Z]{3,}(?:\s[A-Z]{3,})*)\.\.\./g;
  const marks: { key: string; from: number; valAt: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = field.exec(text))) {
    marks.push({ key: m[1].trim(), from: m.index, valAt: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].from : text.length;
    const val = text.slice(marks[i].valAt, end).replace(/\s*\*\s*$/, '').trim();
    if (val) out[marks[i].key] = val;
  }
  return out;
}

/** One-line "who this covers", leading with the home county when it's included —
 *  the single fact the reader most wants: "is MY area in this?" */
function countyLine(areas: string[], homeCounty?: string): string {
  const n = areas.length;
  if (!n) return '';
  // areaDesc entries are sometimes "County, ST"; drop the state for a clean list.
  const names = areas.map((a) => a.replace(/,\s*[A-Z]{2}$/, '').trim());
  const home = homeCounty ? homeCounty.split(/ County|,/)[0].trim() : '';
  const hasHome = home && names.some((a) => a.toLowerCase() === home.toLowerCase());
  if (hasHome) {
    return n === 1
      ? `${home} County (your area)`
      : `${home} (your area) +${n - 1} more ${n - 1 === 1 ? 'county' : 'counties'}`;
  }
  const head = names.slice(0, 3).join(', ');
  return n <= 3 ? head : `${head} +${n - 3} more`;
}

/** A labeled line whose bold label leads the non-bold value on one flowed line
 *  (e.g. **HAZARD**  destructive winds) so the block of fields reads as scannable
 *  rows rather than an undifferentiated wall of text. */
function kv(label: string, value: string): Block {
  return { type: 'text', runs: [{ text: `${label}  `, bold: true }, { text: value }] };
}

/** Build the ordered block list for a batch of alert transitions (shared by the
 *  printer and the web preview). Deliberately compact — a reader should grasp
 *  WHAT / WHEN / whether their county is in it / the top hazard & action in a
 *  glance, without the full multi-page NWS bulletin. */
export async function buildAlertBlocks(events: AlertEvent[]): Promise<Block[]> {
  // Best-effort; a non-US point or an API hiccup just omits the location line.
  const ctx = await fetchPointContext().catch(() => undefined);
  const home = ctx?.county;

  const blocks: Block[] = [
    { type: 'image', path: LOGO_PRINT_PATH, align: 'center' },
    { type: 'image', path: await textImage('!! WEATHER ALERT !!', 'title'), align: 'center' },
  ];
  if (home) blocks.push({ type: 'text', text: home, align: 'center' });
  blocks.push({ type: 'text', text: stamp(), align: 'center' });
  blocks.push({ type: 'rule' });

  for (let i = 0; i < events.length; i++) {
    const { kind, alert } = events[i];
    if (i > 0) blocks.push({ type: 'rule' });

    // Transition tag (small) + the event itself (large — the headline answer).
    blocks.push({ type: 'text', text: BADGE[kind], align: 'center' });
    blocks.push({ type: 'image', path: await textImage(alert.event, 'section'), align: 'center' });

    // WHEN — the one operational fact that matters most, bold and centered.
    if (kind === 'expired') {
      blocks.push({ type: 'text', text: `Expired ${shortWhen(alert.expires)}`, bold: true, align: 'center' });
    } else {
      const eff = alert.effective ? Date.parse(alert.effective) : NaN;
      const when = !Number.isNaN(eff) && eff > Date.now()
        ? `Starts ${shortWhen(alert.effective)}`
        : alert.expires ? `Until ${shortWhen(alert.expires)}` : '';
      const line = [alert.severity, when].filter(Boolean).join('  ·  ');
      if (line) blocks.push({ type: 'text', text: line, bold: true, align: 'center' });
    }

    // WHO — counties, leading with the reader's own.
    const counties = countyLine(alert.areas, home);
    if (counties) blocks.push({ type: 'text', text: counties, align: 'center' });

    if (kind !== 'expired') {
      const seg = segments(alert.description);
      const threat = seg.HAZARD || seg.WHAT || seg.SUMMARY;
      const impact = seg.IMPACT || seg.IMPACTS;
      const action = firstSentence(alert.instruction);

      if (threat || impact || action) blocks.push({ type: 'space' });
      if (threat) blocks.push(kv('HAZARD', clip(threat, 180)));
      if (impact) blocks.push(kv('IMPACT', clip(impact, 180)));
      // If NWS gave no structured fields, fall back to a one-sentence summary —
      // but skip the all-caps SPC watch boilerplate (no lowercase = not prose).
      if (!threat && !impact) {
        const snip = firstSentence(alert.description, 200);
        if (snip && /[a-z]/.test(snip)) blocks.push({ type: 'text', text: snip });
      }
      if (action) blocks.push(kv('ACTION', action));
    }
  }
  blocks.push({ type: 'rule' });
  return blocks;
}

/** Turn raw NWS alerts into printable events (used by the smoke-test preview). */
export function alertsToEvents(alerts: NwsAlert[], kind: Transition = 'new'): AlertEvent[] {
  return alerts.map((a) => ({ kind, alert: toStored(a) }));
}

/** Print one receipt covering a batch of alert transitions. */
async function printWeatherAlerts(events: AlertEvent[]): Promise<void> {
  await printReceipt(await buildAlertBlocks(events), 'Weather Alert');
}

let running: Promise<AlertEvent[]> | undefined;

/** Run one poll cycle; prints on issued/updated/expired transitions only. A tick
 *  that lands while the last is still running joins it, so a slow API can't print
 *  an alert twice. `fetcher` and `print` are injectable for tests. */
export function runWeatherAlerts(
  fetcher: () => Promise<NwsAlert[]> = fetchActiveAlerts,
  print: (events: AlertEvent[]) => Promise<void> = printWeatherAlerts,
): Promise<AlertEvent[]> {
  running ??= pollWeatherAlerts(fetcher, print).finally(() => {
    running = undefined;
  });
  return running;
}

async function pollWeatherAlerts(
  fetcher: () => Promise<NwsAlert[]>,
  print: (events: AlertEvent[]) => Promise<void>,
): Promise<AlertEvent[]> {
  lastCheck = new Date().toISOString();
  // Warm the home-point context so the dashboard status has it even before the
  // first alert prints (cached after the first success; best-effort).
  void fetchPointContext().catch(() => undefined);
  try {
    const all = await fetcher();
    lastAlerts = all;
    // Only the categories configured to print participate in transition tracking.
    const imm = all.filter(isImmediate);
    const curById = new Map(imm.map((a) => [a.id, a]));

    // First ever run: baseline current alerts silently (no dump).
    if (!baselined) {
      active = new Map(imm.map((a) => [a.id, toStored(a)]));
      baselined = true;
      saveState();
      lastError = undefined;
      return [];
    }

    const events: AlertEvent[] = [];
    const referenced = new Set(imm.flatMap((a) => a.references));

    // NEW / UPDATED — anything currently active that we didn't already know, plus
    // in-place edits of a known id.
    for (const a of imm) {
      const prior = active.get(a.id);
      if (!prior) {
        const supersedes = a.messageType === 'Update' || a.references.some((r) => active.has(r));
        events.push({ kind: supersedes ? 'updated' : 'new', alert: toStored(a) });
      } else if (prior.sig !== signature(a)) {
        events.push({ kind: 'updated', alert: toStored(a) });
      }
    }

    // EXPIRED — a known alert that dropped out of the feed and wasn't superseded
    // by an update we just reported (referenced ids are covered by their UPDATED).
    for (const [id, prior] of active) {
      if (!curById.has(id) && !referenced.has(id)) {
        events.push({ kind: 'expired', alert: prior });
      }
    }

    // Print first: if this throws, `active` is untouched and the next tick
    // retries, rather than a warning being recorded as seen but never printed.
    if (events.length) await print(events);

    active = new Map(imm.map((a) => [a.id, toStored(a)]));
    saveState();

    lastError = undefined;
    return events;
  } catch (e) {
    lastError = String(e);
    console.error('[weather-alerts]', e);
    return [];
  }
}

let timer: NodeJS.Timeout | undefined;

export function startWeatherAlerts(): void {
  if (!config.weatherAlerts.enabled) {
    console.log('[weather-alerts] disabled (needs WEATHER_LAT/LON)');
    return;
  }
  loadState();
  console.log(
    `[weather-alerts] NWS ${config.weatherAlerts.printTypes.join('/')}, polling every ${config.weatherAlerts.intervalSec}s`,
  );
  const tick = () => runWeatherAlerts().catch((e) => console.error('[weather-alerts]', e));
  tick();
  timer = setInterval(tick, config.weatherAlerts.intervalSec * 1000);
}

export function stopWeatherAlerts(): void {
  if (timer) clearInterval(timer);
}

export function weatherAlertsStatus() {
  return {
    enabled: config.weatherAlerts.enabled,
    intervalSec: config.weatherAlerts.intervalSec,
    printTypes: config.weatherAlerts.printTypes,
    lastCheck,
    error: lastError,
    // Which county WEATHER_LAT/LON sits in (best-effort; undefined until resolved).
    location: cachedPointContext(),
    active: lastAlerts.map((a) => ({
      id: a.id,
      event: a.event,
      category: alertCategory(a),
      severity: a.severity,
      urgency: a.urgency,
      certainty: a.certainty,
      area: a.areaDesc,
      areas: a.areas,
      headline: a.nwsHeadline ?? a.headline,
      description: a.description,
      instruction: a.instruction,
      senderName: a.senderName,
      effective: a.effective ?? a.onset,
      expires: a.expires ?? a.ends,
    })),
  };
}
