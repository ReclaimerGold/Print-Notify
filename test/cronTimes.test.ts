import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastFire } from '../src/cronTimes.js';

const CHI = 'America/Chicago';
const HOUR = 3_600_000;
const fire = (expr: string, now: string, hours = 24, tz = CHI) => {
  const t = lastFire(expr, tz, Date.parse(now), hours * HOUR);
  return t === null ? null : new Date(t).toISOString();
};

test('finds the last fire in the schedule\'s time zone', () => {
  assert.equal(fire('0 7 * * *', '2026-08-12T15:30:00Z'), '2026-08-12T12:00:00.000Z'); // 7am CDT
  assert.equal(fire('0 7 * * *', '2026-01-12T15:30:00Z'), '2026-01-12T13:00:00.000Z'); // 7am CST
});

test('counts a fire at this very minute and stops at the lookback', () => {
  assert.equal(fire('0 7 * * *', '2026-08-12T12:00:30Z'), '2026-08-12T12:00:00.000Z');
  assert.equal(fire('0 7 * * *', '2026-08-12T15:30:00Z', 3), null);
});

test('lists, ranges, and steps', () => {
  assert.equal(fire('7,22 * * * *', '2026-08-12T15:30:00Z'), '2026-08-12T15:22:00.000Z');
  assert.equal(fire('*/10 * * * *', '2026-08-12T15:34:00Z'), '2026-08-12T15:30:00.000Z');
  assert.equal(fire('0 9-17/2 * * *', '2026-08-12T16:30:00Z'), '2026-08-12T16:00:00.000Z'); // 11am CDT
});

test('weekday rules, including 7 for Sunday', () => {
  // 2026-08-12 is a Wednesday.
  assert.equal(fire('0 7 * * 1-5', '2026-08-12T15:00:00Z'), '2026-08-12T12:00:00.000Z');
  assert.equal(fire('0 7 * * 6', '2026-08-12T15:00:00Z'), null);
  assert.equal(fire('0 7 * * 7', '2026-08-16T15:00:00Z'), '2026-08-16T12:00:00.000Z');
});

test('when day and weekday are both set, either matches', () => {
  assert.equal(fire('0 7 1 * 3', '2026-08-12T15:00:00Z'), '2026-08-12T12:00:00.000Z');
});

test('a six-field expression uses its last five fields', () => {
  assert.equal(fire('30 0 7 * * *', '2026-08-12T15:00:00Z'), '2026-08-12T12:00:00.000Z');
});

test('forms it cannot read give null rather than a wrong answer', () => {
  assert.equal(fire('0 7 * * MON', '2026-08-12T15:00:00Z'), null);
  assert.equal(fire('nonsense', '2026-08-12T15:00:00Z'), null);
});
