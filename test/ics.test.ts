import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, isYearly, nextYearlyOccurrence, daysUntil, parseDt } from '../src/ics.js';

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
  assert.equal(new Date(standup.start.ms).getHours(), 9);
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
