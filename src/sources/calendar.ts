import { config } from '../config.js';
import type { Source, NotificationItem } from './types.js';

/** Unfold RFC5545 line folding (continuation lines start with space/tab). */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, '').split(/\r?\n/);
}

/** Parse an ICS date value into { ms, allDay }. Handles DATE and DATE-TIME. */
function parseDt(value: string): { ms: number; allDay: boolean } | null {
  const m = value.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const allDay = !hh;
  const ms = z
    ? Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss)
    : new Date(+y, +mo - 1, +d, +(hh ?? 0), +(mm ?? 0), +(ss ?? 0)).getTime();
  return { ms, allDay };
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
  async fetch(): Promise<NotificationItem[]> {
    const res = await fetch(config.sources.calendar.icsUrl);
    if (!res.ok) throw new Error(`Calendar ICS ${res.status}`);
    const lines = unfold(await res.text());

    const today = Date.now();
    const items: NotificationItem[] = [];
    type Ev = { summary?: string; start?: ReturnType<typeof parseDt>; end?: ReturnType<typeof parseDt>; uid?: string };
    let cur: Ev | null = null;

    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') cur = {};
      else if (line === 'END:VEVENT') {
        if (cur?.start && cur.summary && sameLocalDay(cur.start.ms, today)) {
          // Timeline range: "9:00a-10:30a", or just the start if no end, or "all day".
          const range = cur.start.allDay
            ? 'all day'
            : cur.end && !cur.end.allDay
              ? `${clock(cur.start.ms)}-${clock(cur.end.ms)}`
              : clock(cur.start.ms);
          items.push({
            id: `calendar:${cur.uid ?? cur.summary}:${cur.start.ms}`,
            source: 'calendar',
            title: cur.summary,
            detail: range,
            severity: 'info',
            timestamp: cur.start.ms,
          });
        }
        cur = null;
      } else if (cur) {
        if (line.startsWith('SUMMARY:')) cur.summary = line.slice(8).trim();
        else if (line.startsWith('UID:')) cur.uid = line.slice(4).trim();
        else if (line.startsWith('DTSTART')) cur.start = parseDt(line.slice(line.indexOf(':') + 1));
        else if (line.startsWith('DTEND')) cur.end = parseDt(line.slice(line.indexOf(':') + 1));
      }
    }
    // Oldest to newest across the day.
    return items.sort((a, b) => a.timestamp - b.timestamp);
  },
};
