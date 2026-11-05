// Minimal RFC5545 reading, shared by the calendar and birthdays sources.
//
// This is deliberately not a full iCalendar implementation — it handles the
// subset Google Calendar's secret .ics feeds actually emit: folded lines,
// VEVENT blocks, DATE and DATE-TIME values, and yearly recurrence (which is how
// contact birthdays and anniversaries are published).

export interface IcsTime {
  ms: number;
  allDay: boolean;
}

export interface IcsEvent {
  uid?: string;
  summary?: string;
  start: IcsTime;
  end?: IcsTime;
  /** Raw RRULE value when present, e.g. "FREQ=YEARLY;INTERVAL=1". */
  rrule?: string;
}

/** Unfold RFC5545 line folding (continuation lines start with space/tab). */
export function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, '').split(/\r?\n/);
}

/** Parse an ICS date value into { ms, allDay }. Handles DATE and DATE-TIME. */
export function parseDt(value: string): IcsTime | null {
  const m = value.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const allDay = !hh;
  const ms = z
    ? Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss)
    : new Date(+y, +mo - 1, +d, +(hh ?? 0), +(mm ?? 0), +(ss ?? 0)).getTime();
  return { ms, allDay };
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
      case 'SUMMARY': cur.summary = value(line); break;
      case 'UID': cur.uid = value(line); break;
      case 'DTSTART': cur.start = parseDt(value(line)) ?? undefined; break;
      case 'DTEND': cur.end = parseDt(value(line)) ?? undefined; break;
      case 'RRULE': cur.rrule = value(line).toUpperCase(); break;
    }
  }
  return events;
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
