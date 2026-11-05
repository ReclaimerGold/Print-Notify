import cron from 'node-cron';
import { config } from './config.js';
import { fetchAll } from './sources/index.js';
import { printDigest, printAlert } from './digest.js';
import { filterUnseen } from './store.js';
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

/** Poll sources and print only NEW urgent items (deduped via the store). */
export async function runPoll(): Promise<number> {
  const { items, errors } = await fetchAll();
  if (errors.length) console.warn('[poll] source errors:', errors);
  const urgent = items.filter((i) => i.severity === 'urgent');
  const fresh = await filterUnseen(urgent);
  if (fresh.length) await printAlert(fresh);
  state.lastPoll = new Date().toISOString();
  return fresh.length;
}

export function startScheduler(): void {
  const opts = { timezone: config.timezone } as const;

  cron.schedule(config.schedule.morningDigest, () => {
    runDigest('Morning Digest').catch((e) => {
      state.lastError = String(e);
      console.error('[cron:digest]', e);
    });
  }, opts);

  // Empty EVENING_DIGEST_CRON disables the evening receipt entirely.
  if (config.schedule.eveningDigest) {
    cron.schedule(config.schedule.eveningDigest, () => {
      runEveningDigest().catch((e) => {
        state.lastError = String(e);
        console.error('[cron:evening]', e);
      });
    }, opts);
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
}
