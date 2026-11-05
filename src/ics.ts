// Minimal RFC5545 reading, shared by the calendar and birthdays sources.
//
// This is deliberately not a full iCalendar implementation — it handles the
// subset Google Calendar's secret .ics feeds actually emit: folded lines, VEVENT
// blocks, DATE and DATE-TIME values with TZID, RRULE recurrence with EXDATE and
// RECURRENCE-ID exceptions, and cancelled events.
import { createRequire } from 'node:module';

// rrule ships CommonJS that plain ESM can't import by name (tsx hides this, but
// `node --import tsx` does not), so load it the way CommonJS expects.
const { RRule } = createRequire(import.meta.url)('rrule') as typeof import('rrule');

export interface IcsTime {
  ms: number;
  allDay: boolean;
  /** Wall-clock time as if it were UTC: what recurrence rules are computed on. */
  wall: number;
  /** IANA zone the wall clock is in; undefined means the server's local zone. */
  tz?: string;
}

export interface IcsEvent {
  uid?: string;
  summary?: string;
  start: IcsTime;
  end?: IcsTime;
  /** Raw RRULE value when present, e.g. "FREQ=YEARLY;INTERVAL=1". */
  rrule?: string;
  /** Occurrences removed from the series (ms). */
  exdates?: number[];
  /** Set on a one-off edit: which occurrence of the series (by UID) it replaces. */
  recurrenceId?: number;
  /** e.g. "CANCELLED". */
  status?: string;
}

/** Unfold RFC5545 line folding (continuation lines start with space/tab). */
export function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, '').split(/\r?\n/);
}

/** Offset of `tz` from UTC at instant `ms`, in ms (east positive). */
function zoneOffset(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(ms);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** A wall-clock time (see IcsTime.wall) in `tz` as a real instant. */
function wallToMs(wall: number, tz?: string): number {
  if (!tz) {
    const d = new Date(wall);
    return new Date(
      d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
      d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(),
    ).getTime();
  }
  // The offset depends on the instant being solved for, so refine once. That
  // lands on the right side of a DST change.
  const first = wall - zoneOffset(wall, tz);
  return wall - zoneOffset(first, tz);
}

/** A real instant as a wall-clock time in `tz`. */
function msToWall(ms: number, tz?: string): number {
  return tz ? ms + zoneOffset(ms, tz) : ms - new Date(ms).getTimezoneOffset() * 60_000;
}

function knownZone(tz?: string): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined; // e.g. a Windows zone name: treat as local
  }
}

/** Parse an ICS date value into an IcsTime. Handles DATE and DATE-TIME. */
export function parseDt(value: string, tzid?: string): IcsTime | null {
  const m = value.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const allDay = !hh;
  const wall = Date.UTC(+y, +mo - 1, +d, +(hh ?? 0), +(mm ?? 0), +(ss ?? 0));
  // All-day dates are calendar dates, so a TZID never shifts them.
  const tz = z ? 'UTC' : allDay ? undefined : knownZone(tzid);
  return { ms: z ? wall : wallToMs(wall, tz), allDay, wall, tz };
}

/** Property name of an ICS line ("DTSTART;VALUE=DATE:2024..." -> "DTSTART"). */
function propName(line: string): string {
  const cut = Math.min(
    ...[line.indexOf(':'), line.indexOf(';')].filter((i) => i >= 0),
    line.length,
  );
  return line.slice(0, cut);
}

const value = (line: string) => line.slice(line.indexOf(':') + 1).trim();

/** A property parameter, e.g. param("DTSTART;TZID=Foo:2026...", "TZID") -> "Foo". */
function param(line: string, name: string): string | undefined {
  const head = line.slice(0, line.indexOf(':'));
  return head.match(new RegExp(`;${name}="?([^";]+)"?`, 'i'))?.[1];
}

/** Undo RFC5545 TEXT escaping. Titles are one line, so newlines become spaces. */
export function unescapeText(text: string): string {
  return text.replace(/\\([\\;,nN])/g, (_, c: string) => (c.toLowerCase() === 'n' ? ' ' : c));
}

/** Parse an .ics document into its VEVENTs. Events without a usable DTSTART are skipped. */
export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let cur: Partial<IcsEvent> | null = null;

  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') {
      cur = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur?.start) events.push(cur as IcsEvent);
      cur = null;
      continue;
    }
    if (!cur) continue;

    switch (propName(line)) {
      case 'SUMMARY': cur.summary = unescapeText(value(line)); break;
      case 'UID': cur.uid = value(line); break;
      case 'DTSTART': cur.start = parseDt(value(line), param(line, 'TZID')) ?? undefined; break;
      case 'DTEND': cur.end = parseDt(value(line), param(line, 'TZID')) ?? undefined; break;
      case 'RRULE': cur.rrule = value(line).toUpperCase(); break;
      case 'STATUS': cur.status = value(line).toUpperCase(); break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDt(value(line), param(line, 'TZID'))?.ms; break;
      case 'EXDATE':
        for (const v of value(line).split(',')) {
          const t = parseDt(v, param(line, 'TZID'));
          if (t) (cur.exdates ??= []).push(t.ms);
        }
        break;
    }
  }
  return events;
}

const DAY_MS = 86_400_000;

/**
 * Starts of a recurring event inside [fromMs, toMs), as wall-clock times.
 *
 * The rule runs on wall-clock time so a 9am meeting stays at 9am across DST. Each
 * "date" handed to rrule is a wall time dressed as UTC, which is why the search
 * window is padded: it compares against those, not real instants.
 */
function recurrences(ev: IcsEvent, fromMs: number, toMs: number): number[] {
  const { wall, tz } = ev.start;
  try {
    const options = RRule.parseString(ev.rrule!);
    if (options.until && !ev.start.allDay) options.until = new Date(msToWall(options.until.getTime(), tz));
    const rule = new RRule({ ...options, dtstart: new Date(wall) });
    return rule
      .between(new Date(fromMs - 2 * DAY_MS), new Date(toMs + 2 * DAY_MS), true)
      .map((d) => d.getTime());
  } catch (e) {
    console.warn(`[ics] skipping unreadable RRULE "${ev.rrule}":`, (e as Error)?.message ?? e);
    return [];
  }
}

/** Move an event to the occurrence starting at wall time `wall`, keeping its length. */
function occurrence(ev: IcsEvent, wall: number): IcsEvent {
  const at = (t: IcsTime, w: number): IcsTime => ({ ...t, wall: w, ms: wallToMs(w, t.tz) });
  return {
    ...ev,
    start: at(ev.start, wall),
    end: ev.end ? at(ev.end, wall + (ev.end.wall - ev.start.wall)) : undefined,
  };
}

/**
 * Every event occurrence starting in [fromMs, toMs): one-offs, expanded recurring
 * series, and one-off edits of a series. Cancelled events, EXDATEs, and the
 * originals of edited occurrences are left out.
 */
export function occurrencesBetween(events: IcsEvent[], fromMs: number, toMs: number): IcsEvent[] {
  // An edited or cancelled occurrence replaces its slot in the series.
  const replaced = new Map<string, Set<number>>();
  for (const ev of events) {
    if (ev.recurrenceId === undefined || !ev.uid) continue;
    const slots = replaced.get(ev.uid) ?? new Set<number>();
    slots.add(ev.recurrenceId);
    replaced.set(ev.uid, slots);
  }

  const inWindow = (ms: number) => ms >= fromMs && ms < toMs;
  const out: IcsEvent[] = [];
  for (const ev of events) {
    if (ev.status === 'CANCELLED') continue;
    if (!ev.rrule) {
      if (inWindow(ev.start.ms)) out.push(ev);
      continue;
    }
    const skip = new Set([...(ev.exdates ?? []), ...(replaced.get(ev.uid ?? '') ?? [])]);
    for (const wall of recurrences(ev, fromMs, toMs)) {
      const occ = occurrence(ev, wall);
      if (inWindow(occ.start.ms) && !skip.has(occ.start.ms)) out.push(occ);
    }
  }
  return out;
}

/** True when an event repeats every year (how birthdays/anniversaries are published). */
export function isYearly(ev: IcsEvent): boolean {
  return /FREQ=YEARLY/.test(ev.rrule ?? '');
}

/**
 * The next time a yearly event's month/day falls on or after `fromMs`, as a
 * local-midnight timestamp. Feb 29 in a non-leap year rolls to Mar 1, matching
 * how calendar apps display it.
 */
export function nextYearlyOccurrence(startMs: number, fromMs: number): number {
  const origin = new Date(startMs);
  const from = new Date(fromMs);
  const month = origin.getMonth();
  const day = origin.getDate();

  // Compare on date boundaries so an occurrence earlier *today* still counts.
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  for (let year = from.getFullYear(); year <= from.getFullYear() + 1; year++) {
    // `new Date(y, 1, 29)` rolls to Mar 1 in non-leap years on its own.
    const when = new Date(year, month, day).getTime();
    if (when >= today) return when;
  }
  return new Date(from.getFullYear() + 1, month, day).getTime();
}

/** Whole days from `fromMs` to `toMs`, counted on local date boundaries. */
export function daysUntil(toMs: number, fromMs: number = Date.now()): number {
  const a = new Date(fromMs);
  const b = new Date(toMs);
  const start = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const end = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((end - start) / 86_400_000);
}
