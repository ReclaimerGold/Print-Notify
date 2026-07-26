import cron from 'node-cron';
import { config } from './config.js';
import { fetchAll } from './sources/index.js';
import { printDigest, printAlert } from './digest.js';
import { filterUnseen } from './store.js';
import { startSentinel } from './sentinel.js';
import { startWeatherAlerts } from './weatherAlerts.js';

export interface RunState {
  lastDigest?: string;
  lastPoll?: string;
  lastError?: string;
}

export const state: RunState = {};

/** Fetch everything and print a full digest. Used by the morning cron + manual trigger. */
export async function runDigest(title = 'Daily Digest'): Promise<number> {
  const { items, errors } = await fetchAll();
  if (errors.length) console.warn('[digest] source errors:', errors);
  await printDigest(title, items, errors);
  state.lastDigest = new Date().toISOString();
  return items.length;
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

  cron.schedule(config.schedule.pollUrgent, () => {
    runPoll().catch((e) => {
      state.lastError = String(e);
      console.error('[cron:poll]', e);
    });
  }, opts);

  console.log(
    `[scheduler] digest "${config.schedule.morningDigest}", poll "${config.schedule.pollUrgent}" (${config.timezone})`,
  );

  startSentinel();
  startWeatherAlerts();
}
