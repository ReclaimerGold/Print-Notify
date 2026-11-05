import { config } from '../config.js';
import { parseIcs } from '../ics.js';
import type { Source, NotificationItem, DigestContext } from './types.js';

/** Local midnight of the day `offset` days from now. */
function dayStart(offset = 0): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}

const sameLocalDay = (a: number, b: number) =>
  new Date(a).toDateString() === new Date(b).toDateString();

/** Compact clock time in the configured tz, e.g. "9:00a", "10:30p". */
function clock(ms: number): string {
  return new Date(ms)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: config.timezone })
    .replace(' AM', 'a')
    .replace(' PM', 'p');
}

export const calendarSource: Source = {
  name: 'calendar',
  enabled: config.sources.calendar.enabled,
  async fetch(ctx?: DigestContext): Promise<NotificationItem[]> {
    const res = await fetch(config.sources.calendar.icsUrl);
    if (!res.ok) throw new Error(`Calendar ICS ${res.status}`);

    // The evening digest asks for tomorrow so you see it while you can still prep.
    const target = dayStart(ctx?.day === 'tomorrow' ? 1 : 0).getTime();

    const items: NotificationItem[] = [];
    for (const ev of parseIcs(await res.text())) {
      if (!ev.summary || !sameLocalDay(ev.start.ms, target)) continue;
      // Timeline range: "9:00a-10:30a", or just the start if no end, or "all day".
      const range = ev.start.allDay
        ? 'all day'
        : ev.end && !ev.end.allDay
          ? `${clock(ev.start.ms)}-${clock(ev.end.ms)}`
          : clock(ev.start.ms);
      items.push({
        id: `calendar:${ev.uid ?? ev.summary}:${ev.start.ms}`,
        source: 'calendar',
        title: ev.summary,
        detail: range,
        severity: 'info',
        timestamp: ev.start.ms,
      });
    }
    // Oldest to newest across the day.
    return items.sort((a, b) => a.timestamp - b.timestamp);
  },
};
