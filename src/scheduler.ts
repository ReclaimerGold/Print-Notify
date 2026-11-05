import { readFile } from 'node:fs/promises';
import cron from 'node-cron';
import { config } from './config.js';
import { lastFire } from './cronTimes.js';
import { writeJson } from './jsonFile.js';
import { fetchAll } from './sources/index.js';
import { printDigest, printAlert } from './digest.js';
import { filterUnseen, markSeen } from './store.js';
import { startSentinel } from './sentinel.js';
import { startWeatherAlerts } from './weatherAlerts.js';
import { startPrintQueue } from './printQueue.js';
import type { DigestContext } from './sources/types.js';

export interface RunState {
  lastDigest?: string;
  lastEvening?: string;
  lastPoll?: string;
  lastError?: string;
  /** Set when the most recent receipt was held instead of printed. */
  lastHeld?: string;
}

export const state: RunState = {};

const STATE_FILE = 'data/run-state.json';
const RETRY_DELAYS_MS = [60_000, 5 * 60_000];

// When catch-up history starts. Set on the first run with no saved state, so an
// upgrade or fresh install doesn't count as a missed digest.
let since = 0;

async function saveRunState(): Promise<void> {
  const { lastDigest, lastEvening } = state;
  await writeJson(STATE_FILE, { since, lastDigest, lastEvening }).catch((e) => {
    console.error('[scheduler] could not save run state:', e);
  });
}

/** Restore digest history. False when there is none to restore. */
async function loadRunState(): Promise<boolean> {
  try {
    const saved = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    since = saved.since ?? 0;
    state.lastDigest = saved.lastDigest;
    state.lastEvening = saved.lastEvening;
    return true;
  } catch {
    return false;
  }
}

/** Fetch everything and print a full digest. Used by the crons + manual trigger. */
export async function runDigest(title = 'Daily Digest', ctx?: DigestContext): Promise<number> {
  const { items, errors } = await fetchAll(ctx);
  if (errors.length) console.warn('[digest] source errors:', errors);
  const result = await printDigest(title, items, errors);

  const stamp = new Date().toISOString();
  if (ctx?.day === 'tomorrow') state.lastEvening = stamp;
  else state.lastDigest = stamp;
  // Held receipts are not printed receipts; say so rather than reporting success.
  state.lastHeld = result.printed ? undefined : `${title}: ${result.heldReason}`;
  await saveRunState();
  return items.length;
}

/**
 * The evening digest: the same sources, shifted to tomorrow. Calendar shows
 * tomorrow's events, weather leads with tomorrow's forecast, and birthdays count
 * from tomorrow — so what prints is what you can still prepare for tonight.
 */
export async function runEveningDigest(title = 'Evening Digest'): Promise<number> {
  return runDigest(title, { day: 'tomorrow' });
}

async function pollOnce(fetchItems: typeof fetchAll, print: typeof printAlert): Promise<number> {
  const { items, errors } = await fetchItems();
  if (errors.length) console.warn('[poll] source errors:', errors);
  const urgent = items.filter((i) => i.severity === 'urgent');
  const fresh = await filterUnseen(urgent);
  if (fresh.length) {
    await print(fresh);
    await markSeen(fresh); // after printing, so a failure retries next poll
  }
  state.lastPoll = new Date().toISOString();
  return fresh.length;
}

let polling: Promise<number> | undefined;

/**
 * Poll sources and print only NEW urgent items (deduped via the store). A manual
 * poll that lands during the cron's joins it rather than printing the same
 * alert twice. `fetchItems` and `print` are injectable for tests.
 */
export function runPoll(fetchItems = fetchAll, print = printAlert): Promise<number> {
  polling ??= pollOnce(fetchItems, print).finally(() => {
    polling = undefined;
  });
  return polling;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a scheduled digest, retrying if it throws. A held receipt doesn't throw (the
 * print queue owns that retry), so this covers failures before the print: composing
 * and rendering the receipt.
 */
export async function withRetry(
  label: string,
  run: () => Promise<unknown>,
  delaysMs = RETRY_DELAYS_MS,
  wait = sleep,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await run();
      return;
    } catch (e) {
      state.lastError = String(e);
      const delay = delaysMs[attempt];
      console.error(`[${label}] attempt ${attempt + 1} failed${delay === undefined ? ', giving up' : ''}:`, e);
      if (delay === undefined) return;
      await wait(delay);
    }
  }
}

const morningDigest = () => runDigest('Morning Digest');

/**
 * Print the digest missed while the app was down, if its time passed recently. Only
 * the latest one runs: yesterday's digests are stale, and two at once help nobody.
 * Returns the digest it ran, if any.
 */
export async function catchUpDigest(
  now = Date.now(),
  runMorning: () => Promise<unknown> = morningDigest,
  runEvening: () => Promise<unknown> = runEveningDigest,
): Promise<string | undefined> {
  if (!(await loadRunState())) {
    since = now;
    await saveRunState();
    return undefined;
  }
  const lookback = config.schedule.catchUpHours * 3_600_000;
  const { morningDigest: morningCron, eveningDigest: eveningCron } = config.schedule;
  const missed = [
    { label: 'Morning Digest', expr: morningCron, last: state.lastDigest, run: runMorning },
    { label: 'Evening Digest', expr: eveningCron, last: state.lastEvening, run: runEvening },
  ].flatMap((d) => {
    const fire = d.expr && lookback > 0 ? lastFire(d.expr, config.timezone, now, lookback) : null;
    const handled = Math.max(since, d.last ? Date.parse(d.last) : 0);
    return fire !== null && fire > handled ? [{ ...d, fire }] : [];
  }).sort((a, b) => b.fire - a.fire)[0];
  if (!missed) return undefined;

  console.log(`[scheduler] catching up on ${missed.label}`);
  await withRetry('catch-up', missed.run);
  return missed.label;
}

export function startScheduler(): void {
  const opts = { timezone: config.timezone } as const;

  cron.schedule(config.schedule.morningDigest, () => withRetry('cron:digest', morningDigest), opts);

  // Empty EVENING_DIGEST_CRON disables the evening receipt entirely.
  if (config.schedule.eveningDigest) {
    cron.schedule(config.schedule.eveningDigest, () => withRetry('cron:evening', runEveningDigest), opts);
  }

  cron.schedule(config.schedule.pollUrgent, () => {
    runPoll().catch((e) => {
      state.lastError = String(e);
      console.error('[cron:poll]', e);
    });
  }, opts);

  console.log(
    `[scheduler] digest "${config.schedule.morningDigest}"` +
    (config.schedule.eveningDigest ? `, evening "${config.schedule.eveningDigest}"` : '') +
    `, poll "${config.schedule.pollUrgent}" (${config.timezone})`,
  );

  startPrintQueue();
  startSentinel();
  startWeatherAlerts();
  catchUpDigest().catch((e) => console.error('[scheduler] catch-up failed:', e));
}
