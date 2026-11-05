import { config } from '../config.js';
import { parseIcs, isYearly, nextYearlyOccurrence, daysUntil, type IcsEvent } from '../ics.js';
import type { Source, NotificationItem, DigestContext } from './types.js';

/**
 * Upcoming birthdays and anniversaries from an ICS feed, projected forward.
 *
 * Google publishes contact birthdays as an all-day event on the birth date with
 * RRULE:FREQ=YEARLY, so the raw DTSTART is decades in the past — we project the
 * next occurrence and keep anything inside the window (45 days by default).
 * That lead time is the point: it's long enough to actually buy a card.
 */

/** Strip Google's decoration so "Ryan's birthday" prints as "Ryan". */
export function personName(summary: string): string {
  const s = summary.trim();
  const possessive = s.match(/^(.*?)['’]s\s+(birthday|bday|anniversary)\b/i);
  if (possessive) return possessive[1].trim();
  const trailing = s.match(/^(.*?)\s*[-–—:]?\s*(birthday|bday|anniversary)\s*$/i);
  if (trailing && trailing[1]) return trailing[1].trim();
  return s;
}

/** Which kind of yearly event this is, for the printed label. */
function kind(summary: string): 'birthday' | 'anniversary' {
  return /anniversar/i.test(summary) ? 'anniversary' : 'birthday';
}

/** "today", "tomorrow", "in 6 days", "Mon Sep 14 (in 33 days)". */
export function whenLabel(ms: number, days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  const date = new Date(ms).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: config.timezone,
  });
  return `${date}  ·  in ${days} days`;
}

/**
 * Ordinal age/year count, when the source year looks like a real one. Google
 * uses a placeholder year (often 1604 or the current year) when the contact
 * didn't share a birth year, so anything implausible is dropped rather than
 * printing "turns 421".
 */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

export function milestone(originMs: number, occurrenceMs: number, what: string): string | undefined {
  const originYear = new Date(originMs).getFullYear();
  const year = new Date(occurrenceMs).getFullYear();
  const n = year - originYear;
  if (originYear < 1900 || n <= 0 || n > 120) return undefined;
  return what === 'anniversary' ? `${ordinal(n)} anniversary` : `turns ${n}`;
}

/** Does this event look like a birthday/anniversary rather than a normal event? */
function looksLikeBirthday(ev: IcsEvent): boolean {
  const hay = `${ev.summary ?? ''}`.toLowerCase();
  return config.sources.birthdays.keywords.some((kw) => hay.includes(kw));
}

export const birthdaysSource: Source = {
  name: 'birthdays',
  enabled: config.sources.birthdays.enabled,
  async fetch(ctx?: DigestContext): Promise<NotificationItem[]> {
    const { icsUrl, windowDays, keywords } = config.sources.birthdays;
    const res = await fetch(icsUrl);
    if (!res.ok) throw new Error(`Birthdays ICS ${res.status}`);
    const events = parseIcs(await res.text());

    // A dedicated feed (Google's own "Birthdays" calendar) is entirely birthdays,
    // so keyword filtering would only throw away entries whose title is just a
    // name. Filter only when we're sharing the main calendar's feed.
    const dedicated = icsUrl !== config.sources.calendar.icsUrl;
    const candidates = events.filter(
      (ev) => ev.summary && ev.status !== 'CANCELLED' && isYearly(ev) &&
        (dedicated || !keywords.length || looksLikeBirthday(ev)),
    );

    // The evening digest counts from tomorrow, so "today" entries — already
    // printed this morning and now past — don't lead the evening receipt.
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    if (ctx?.day === 'tomorrow') from.setDate(from.getDate() + 1);
    const fromMs = from.getTime();

    const items: NotificationItem[] = [];
    const seen = new Set<string>();
    for (const ev of candidates) {
      const when = nextYearlyOccurrence(ev.start.ms, fromMs);
      const days = daysUntil(when, fromMs);
      if (days < 0 || days > windowDays) continue;

      const what = kind(ev.summary!);
      const name = personName(ev.summary!);
      const id = `birthday:${ev.uid ?? name}:${new Date(when).toISOString().slice(0, 10)}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const age = milestone(ev.start.ms, when, what);
      items.push({
        id,
        source: 'birthdays',
        title: name,
        detail: [whenLabel(when, days), age].filter(Boolean).join('  ·  '),
        // Day-of is worth a nudge; everything else is a heads-up, not an alarm.
        severity: days === 0 ? 'notice' : 'info',
        // Literal marker glyph for the styled list row (see render_list.py);
        // both live in DejaVu Sans, so they never fall back to a .notdef box.
        icon: what === 'anniversary' ? '♥' : '★',
        timestamp: when,
      });
    }
    // Soonest first — the whole value of this section is the ordering.
    return items.sort((a, b) => a.timestamp - b.timestamp);
  },
};
