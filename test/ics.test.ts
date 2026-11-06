import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, isYearly, nextYearlyOccurrence, daysUntil, parseDt, occurrencesBetween } from '../src/ics.js';

const SAMPLE = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:evt-1',
  'SUMMARY:Standup',
  'DTSTART;TZID=America/Chicago:20260812T090000',
  'DTEND;TZID=America/Chicago:20260812T093000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:bday-1',
  "SUMMARY:Dana's birthday",
  'DTSTART;VALUE=DATE:19900214',
  'RRULE:FREQ=YEARLY',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:folded-1',
  'SUMMARY:A very long title that the feed has',
  '  folded across two lines',
  'DTSTART;VALUE=DATE:20260901',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('parses events, times, and all-day flags', () => {
  const events = parseIcs(SAMPLE);
  assert.equal(events.length, 3);

  const standup = events[0];
  assert.equal(standup.summary, 'Standup');
  assert.equal(standup.start.allDay, false);
  assert.equal(new Date(standup.start.ms).toISOString(), '2026-08-12T14:00:00.000Z'); // 9am CDT
  assert.equal(standup.end?.allDay, false);

  const bday = events[1];
  assert.equal(bday.start.allDay, true);
  assert.ok(isYearly(bday));
  assert.equal(isYearly(standup), false);
});

test('unfolds continuation lines into a single value', () => {
  const folded = parseIcs(SAMPLE).find((e) => e.uid === 'folded-1');
  assert.equal(folded?.summary, 'A very long title that the feed has folded across two lines');
});

test('skips events with no usable DTSTART', () => {
  const noStart = ['BEGIN:VEVENT', 'SUMMARY:Orphan', 'END:VEVENT'].join('\r\n');
  assert.deepEqual(parseIcs(noStart), []);
});

test('parseDt handles DATE, local DATE-TIME, and UTC DATE-TIME', () => {
  assert.equal(parseDt('20260214')?.allDay, true);
  assert.equal(parseDt('20260214T133000')?.allDay, false);
  const utc = parseDt('20260214T133000Z');
  assert.equal(utc?.ms, Date.UTC(2026, 1, 14, 13, 30, 0));
  assert.equal(parseDt('not-a-date'), null);
});

test('projects a yearly event to its next occurrence', () => {
  const birth = new Date(1990, 1, 14).getTime(); // Feb 14 1990
  // Well before the date this year -> same year.
  const fromJan = new Date(2026, 0, 5).getTime();
  assert.equal(nextYearlyOccurrence(birth, fromJan), new Date(2026, 1, 14).getTime());

  // After it -> next year.
  const fromMar = new Date(2026, 2, 5).getTime();
  assert.equal(nextYearlyOccurrence(birth, fromMar), new Date(2027, 1, 14).getTime());
});

test('an occurrence earlier today still counts as today', () => {
  const birth = new Date(1990, 1, 14).getTime();
  const laterOnTheDay = new Date(2026, 1, 14, 18, 30).getTime();
  assert.equal(nextYearlyOccurrence(birth, laterOnTheDay), new Date(2026, 1, 14).getTime());
});

test('Feb 29 rolls to Mar 1 in a non-leap year', () => {
  const leapling = new Date(2000, 1, 29).getTime();
  const from = new Date(2026, 0, 1).getTime(); // 2026 is not a leap year
  const next = new Date(nextYearlyOccurrence(leapling, from));
  assert.equal(next.getMonth(), 2); // March
  assert.equal(next.getDate(), 1);
});

test('daysUntil counts whole local days, not 24h blocks', () => {
  const from = new Date(2026, 7, 12, 23, 30).getTime(); // late evening
  const to = new Date(2026, 7, 13, 0, 30).getTime();    // one hour later, next day
  assert.equal(daysUntil(to, from), 1);
  assert.equal(daysUntil(from, from), 0);
  assert.equal(daysUntil(new Date(2026, 7, 10).getTime(), from), -2);
});

// ---- Recurrence, zones, exceptions -----------------------------------------
// Assertions use real instants, so they hold whatever TZ the machine runs in.

const feed = (...events: string[][]) =>
  ['BEGIN:VCALENDAR', ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
const utc = (s: string) => Date.parse(s);
const DAY = 86_400_000;
const on = (ics: string, day: string) =>
  occurrencesBetween(parseIcs(ics), utc(`${day}T00:00:00Z`), utc(`${day}T00:00:00Z`) + DAY);
const starts = (evs: { start: { ms: number } }[]) => evs.map((e) => new Date(e.start.ms).toISOString());

test('TEXT escapes in a summary are decoded', () => {
  const [ev] = parseIcs(feed(['UID:1', 'SUMMARY:Dinner\\, then drinks\; bring wine\\nand a C:\\\\ drive', 'DTSTART:20261104T150000Z']));
  assert.equal(ev.summary, 'Dinner, then drinks; bring wine and a C:\\ drive');
});

test('a TZID start is the real instant, in and out of DST', () => {
  const at = (v: string, tz: string) => new Date(parseDt(v, tz)!.ms).toISOString();
  assert.equal(at('20261104T090000', 'America/New_York'), '2026-11-04T14:00:00.000Z'); // EST
  assert.equal(at('20260704T090000', 'America/New_York'), '2026-07-04T13:00:00.000Z'); // EDT
  assert.equal(at('20260704T090000', 'Europe/Berlin'), '2026-07-04T07:00:00.000Z');
});

test('an unknown TZID falls back to local rather than throwing', () => {
  assert.equal(parseDt('20260704T090000', 'Central Standard Time')?.tz, undefined);
});

test('all-day dates ignore TZID', () => {
  assert.equal(parseDt('20260704', 'Asia/Tokyo')?.allDay, true);
  assert.equal(parseDt('20260704', 'Asia/Tokyo')?.tz, undefined);
});

test('a weekly series appears on matching days long after it started', () => {
  const ics = feed(['UID:1', 'SUMMARY:Standup', 'DTSTART;TZID=America/Chicago:20250106T090000',
    'DTEND;TZID=America/Chicago:20250106T093000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE']);
  const [wed] = on(ics, '2026-11-04');
  assert.equal(new Date(wed.start.ms).toISOString(), '2026-11-04T15:00:00.000Z');
  assert.equal(new Date(wed.end!.ms).toISOString(), '2026-11-04T15:30:00.000Z');
  assert.equal(on(ics, '2026-11-05').length, 0); // Thursday
});

test('a recurring event keeps its wall-clock time across DST', () => {
  const ics = feed(['UID:1', 'SUMMARY:x', 'DTSTART;TZID=America/Chicago:20260105T090000', 'RRULE:FREQ=DAILY']);
  assert.deepEqual(starts(on(ics, '2026-01-20')), ['2026-01-20T15:00:00.000Z']); // CST
  assert.deepEqual(starts(on(ics, '2026-07-20')), ['2026-07-20T14:00:00.000Z']); // CDT
});

test('COUNT, UNTIL, and INTERVAL end and space a series', () => {
  const base = ['UID:1', 'SUMMARY:x', 'DTSTART:20260105T150000Z'];
  assert.equal(on(feed([...base, 'RRULE:FREQ=DAILY;COUNT=3']), '2026-01-07').length, 1);
  assert.equal(on(feed([...base, 'RRULE:FREQ=DAILY;COUNT=3']), '2026-01-08').length, 0);
  assert.equal(on(feed([...base, 'RRULE:FREQ=DAILY;INTERVAL=2']), '2026-01-06').length, 0);
  assert.equal(on(feed([...base, 'RRULE:FREQ=DAILY;INTERVAL=2']), '2026-01-07').length, 1);
});

test('UNTIL is an instant: the final occurrence counts in zones east of UTC', () => {
  // 09:00 in Berlin is 08:00Z, so wall time alone would compare past UNTIL.
  const ics = feed(['UID:1', 'SUMMARY:x', 'DTSTART;TZID=Europe/Berlin:20260105T090000',
    'RRULE:FREQ=DAILY;UNTIL=20260107T080000Z']);
  assert.equal(on(ics, '2026-01-07').length, 1);
  assert.equal(on(ics, '2026-01-08').length, 0);
});

test('EXDATE removes one occurrence', () => {
  const ics = feed(['UID:1', 'SUMMARY:x', 'DTSTART;TZID=America/Chicago:20260105T090000',
    'RRULE:FREQ=DAILY', 'EXDATE;TZID=America/Chicago:20260107T090000,20260108T090000']);
  assert.equal(on(ics, '2026-01-06').length, 1);
  assert.equal(on(ics, '2026-01-07').length, 0);
  assert.equal(on(ics, '2026-01-08').length, 0);
});

test('a moved occurrence appears at its new time only', () => {
  const ics = feed(
    ['UID:1', 'SUMMARY:x', 'DTSTART:20260105T150000Z', 'RRULE:FREQ=DAILY'],
    ['UID:1', 'SUMMARY:x moved', 'RECURRENCE-ID:20260107T150000Z', 'DTSTART:20260107T180000Z'],
  );
  const day = on(ics, '2026-01-07');
  assert.deepEqual(day.map((e) => e.summary), ['x moved']);
  assert.deepEqual(starts(day), ['2026-01-07T18:00:00.000Z']);
});

test('cancelled events and cancelled occurrences are left out', () => {
  assert.equal(on(feed(['UID:1', 'SUMMARY:x', 'STATUS:CANCELLED', 'DTSTART:20260105T150000Z']), '2026-01-05').length, 0);
  const series = feed(
    ['UID:2', 'SUMMARY:x', 'DTSTART:20260105T150000Z', 'RRULE:FREQ=DAILY'],
    ['UID:2', 'SUMMARY:x', 'STATUS:CANCELLED', 'RECURRENCE-ID:20260107T150000Z', 'DTSTART:20260107T150000Z'],
  );
  assert.equal(on(series, '2026-01-07').length, 0);
  assert.equal(on(series, '2026-01-08').length, 1);
});

test('an all-day series lands on its calendar date', () => {
  const ics = feed(['UID:1', 'SUMMARY:x', 'DTSTART;VALUE=DATE:20200214', 'RRULE:FREQ=YEARLY']);
  const [ev] = occurrencesBetween(parseIcs(ics), new Date(2026, 1, 14).getTime(), new Date(2026, 1, 15).getTime());
  assert.equal(ev.start.allDay, true);
  assert.equal(new Date(ev.start.ms).getDate(), 14);
});

test('an unreadable RRULE skips that series instead of sinking the feed', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const ics = feed(
      ['UID:1', 'SUMMARY:bad', 'DTSTART:20260105T150000Z', 'RRULE:FREQ=NOPE'],
      ['UID:2', 'SUMMARY:fine', 'DTSTART:20260105T160000Z'],
    );
    assert.deepEqual(on(ics, '2026-01-05').map((e) => e.summary), ['fine']);
  } finally {
    console.warn = warn;
  }
});

test('a multi-day all-day event shows on every day it covers, not the day after', () => {
  const ics = feed(['UID:1', 'SUMMARY:trip', 'DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260108']);
  const day = (d: number) => occurrencesBetween(parseIcs(ics), new Date(2026, 0, d).getTime(), new Date(2026, 0, d + 1).getTime());
  assert.deepEqual([4, 5, 6, 7, 8].map((d) => day(d).length), [0, 1, 1, 1, 0]);
});

test('a one-day all-day event stays on one day', () => {
  const ics = feed(['UID:1', 'SUMMARY:x', 'DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260106']);
  const day = (d: number) => occurrencesBetween(parseIcs(ics), new Date(2026, 0, d).getTime(), new Date(2026, 0, d + 1).getTime());
  assert.deepEqual([4, 5, 6].map((d) => day(d).length), [0, 1, 0]);
});

test('a repeating multi-day event reaches into the days after each start', () => {
  const ics = feed(['UID:1', 'SUMMARY:x', 'DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260107', 'RRULE:FREQ=WEEKLY']);
  const day = (d: number) => occurrencesBetween(parseIcs(ics), new Date(2026, 0, d).getTime(), new Date(2026, 0, d + 1).getTime());
  assert.deepEqual([12, 13, 14].map((d) => day(d).length), [1, 1, 0]);
});

test('an event ending exactly at the window start is over', () => {
  const ics = feed(['UID:1', 'SUMMARY:x', 'DTSTART:20260105T230000Z', 'DTEND:20260106T000000Z']);
  assert.equal(on(ics, '2026-01-06').length, 0);
  assert.equal(on(ics, '2026-01-05').length, 1);
});

test('a long repeating event is still found on its last day', () => {
  const ics = feed(['UID:1', 'SUMMARY:x', 'DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260110', 'RRULE:FREQ=WEEKLY']);
  const day = (d: number) => occurrencesBetween(parseIcs(ics), new Date(2026, 0, d).getTime(), new Date(2026, 0, d + 1).getTime());
  assert.deepEqual([16, 17].map((d) => day(d).length), [1, 0]); // Jan 12-16 inclusive
});
