import { weatherSource } from './weather.js';
import { githubSource } from './github.js';
import { calendarSource } from './calendar.js';
import { birthdaysSource } from './birthdays.js';
import { newsSource } from './news.js';
import { tasksSource } from './tasks.js';
import { sportsSource } from './sports.js';
import { certsSource } from './certs.js';
import type { Source, FetchResult, DigestContext } from './types.js';

/** Register new adapters here — that's the only wiring a new source needs. */
export const sources: Source[] = [
  tasksSource, weatherSource, calendarSource, birthdaysSource,
  githubSource, newsSource, sportsSource, certsSource,
];

/** Fetch every enabled source concurrently; one failing source never sinks the rest. */
export async function fetchAll(ctx?: DigestContext): Promise<FetchResult> {
  const enabled = sources.filter((s) => s.enabled);
  const settled = await Promise.allSettled(enabled.map((s) => s.fetch(ctx)));

  const items = [];
  const errors = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === 'fulfilled') items.push(...r.value);
    else errors.push({ source: enabled[i].name, message: String(r.reason?.message ?? r.reason) });
  }
  items.sort((a, b) => b.timestamp - a.timestamp);
  return { items, errors };
}

export * from './types.js';
