import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personName, milestone, whenLabel } from '../src/sources/birthdays.js';
import { registrableDomain, expirySeverity } from '../src/sources/certs.js';
import { parseTeam, toGame, resultLine, upcomingLine } from '../src/sources/sports.js';
import { aqiCategory, daylightLabel } from '../src/sources/weather.js';

// --- birthdays ---------------------------------------------------------------

test('strips birthday decoration down to the person', () => {
  assert.equal(personName("Dana's birthday"), 'Dana');
  assert.equal(personName('Dana’s Birthday'), 'Dana'); // curly apostrophe
  assert.equal(personName('Dana - Birthday'), 'Dana');
  assert.equal(personName('Dana Birthday'), 'Dana');
  assert.equal(personName('Wedding anniversary'), 'Wedding');
  // A bare name (a dedicated birthday feed) is left alone.
  assert.equal(personName('Dana Whitfield'), 'Dana Whitfield');
});

test('computes an age only when the source year is plausible', () => {
  const born = new Date(1990, 1, 14).getTime();
  const turns = new Date(2026, 1, 14).getTime();
  assert.equal(milestone(born, turns, 'birthday'), 'turns 36');
  assert.equal(milestone(born, turns, 'anniversary'), '36th anniversary');

  // Google's placeholder year for "no birth year shared" must not print an age.
  const placeholder = new Date(1604, 1, 14).getTime();
  assert.equal(milestone(placeholder, turns, 'birthday'), undefined);
  // Same-year origin (no elapsed years) is meaningless too.
  assert.equal(milestone(turns, turns, 'birthday'), undefined);
});

test('ordinal suffixes handle the teens correctly', () => {
  const at = (n: number) =>
    milestone(new Date(2000, 0, 1).getTime(), new Date(2000 + n, 0, 1).getTime(), 'anniversary');
  assert.equal(at(1), '1st anniversary');
  assert.equal(at(2), '2nd anniversary');
  assert.equal(at(3), '3rd anniversary');
  assert.equal(at(11), '11th anniversary');
  assert.equal(at(12), '12th anniversary');
  assert.equal(at(13), '13th anniversary');
  assert.equal(at(21), '21st anniversary');
});

test('near dates read as words, far ones as a date', () => {
  const someday = new Date(2026, 8, 14).getTime();
  assert.equal(whenLabel(someday, 0), 'today');
  assert.equal(whenLabel(someday, 1), 'tomorrow');
  assert.match(whenLabel(someday, 33), /in 33 days$/);
});

// --- certs -------------------------------------------------------------------

test('reduces a host to its registrable domain', () => {
  assert.equal(registrableDomain('fallstech.group'), 'fallstech.group');
  assert.equal(registrableDomain('www.fallstech.group'), 'fallstech.group');
  assert.equal(registrableDomain('a.b.c.example.com'), 'example.com');
  // Two-part public suffixes keep a third label.
  assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('localhost'), 'localhost');
});

test('expiry severity escalates inside the urgent window', () => {
  assert.equal(expirySeverity(30), 'notice');
  assert.equal(expirySeverity(8), 'notice');
  assert.equal(expirySeverity(7), 'urgent');   // CERT_URGENT_DAYS default
  assert.equal(expirySeverity(0), 'urgent');
  assert.equal(expirySeverity(-3), 'urgent');  // already expired
});

// --- sports ------------------------------------------------------------------

test('parses league:team entries and rejects unknown leagues', () => {
  assert.deepEqual(parseTeam('mlb:min'), { league: 'mlb', abbr: 'MIN', path: 'baseball/mlb' });
  assert.deepEqual(parseTeam(' nfl : MIN '), { league: 'nfl', abbr: 'MIN', path: 'football/nfl' });
  assert.equal(parseTeam('quidditch:GRY'), null);
  assert.equal(parseTeam('mlb'), null);
});

/** The shape ESPN's schedule endpoint actually returns (verified against live). */
const espnEvent = {
  date: '2026-03-26T19:05Z',
  competitions: [{
    date: '2026-03-26T19:05Z',
    status: { type: { state: 'post', completed: true, shortDetail: 'Final' } },
    competitors: [
      { homeAway: 'home', winner: true, score: { value: 2, displayValue: '2' }, team: { abbreviation: 'BAL', shortDisplayName: 'Orioles' } },
      { homeAway: 'away', winner: false, score: { value: 1, displayValue: '1' }, team: { abbreviation: 'MIN', shortDisplayName: 'Twins' } },
    ],
  }],
};

test('reads an ESPN event from our team\'s point of view', () => {
  const g = toGame(espnEvent, 'MIN');
  assert.ok(g);
  assert.equal(g.completed, true);
  assert.equal(g.us.abbr, 'MIN');
  assert.equal(g.them.abbr, 'BAL');
  assert.equal(g.us.home, false);
  assert.equal(resultLine(g), 'L 1-2 at Orioles');
});

test('scores parse from both the object and bare-string feed shapes', () => {
  const scoreboardShape = {
    date: '2026-03-26T19:05Z',
    competitions: [{
      date: '2026-03-26T19:05Z',
      status: { type: { state: 'post', completed: true } },
      competitors: [
        { homeAway: 'home', winner: false, score: '3', team: { abbreviation: 'MIN', shortDisplayName: 'Twins' } },
        { homeAway: 'away', winner: true, score: '7', team: { abbreviation: 'CLE', shortDisplayName: 'Guardians' } },
      ],
    }],
  };
  const g = toGame(scoreboardShape, 'MIN');
  assert.equal(resultLine(g!), 'L 3-7 vs Guardians');
});

test('an unplayed game has no scores and reads as a preview', () => {
  const upcoming = {
    date: '2026-09-14T17:00Z',
    competitions: [{
      date: '2026-09-14T17:00Z',
      status: { type: { state: 'pre', completed: false, shortDetail: 'Sun 12:00 PM' } },
      competitors: [
        { homeAway: 'home', team: { abbreviation: 'MIN', shortDisplayName: 'Vikings' } },
        { homeAway: 'away', team: { abbreviation: 'CHI', shortDisplayName: 'Bears' } },
      ],
    }],
  };
  const g = toGame(upcoming, 'MIN');
  assert.ok(g);
  assert.equal(g.completed, false);
  assert.match(upcomingLine(g), /^vs Bears {2}· {2}\w{3} \d+:\d\d [AP]M$/);
});

test('malformed events are dropped rather than throwing', () => {
  assert.equal(toGame({}, 'MIN'), null);
  assert.equal(toGame({ competitions: [{ competitors: [] }] }, 'MIN'), null);
  // Our team isn't in this game at all.
  assert.equal(toGame(espnEvent, 'LAD'), null);
});

// --- weather -----------------------------------------------------------------

test('AQI maps to EPA bands at the boundaries', () => {
  assert.equal(aqiCategory(0), 'Good');
  assert.equal(aqiCategory(50), 'Good');
  assert.equal(aqiCategory(51), 'Moderate');
  assert.equal(aqiCategory(100), 'Moderate');
  assert.equal(aqiCategory(101), 'Unhealthy for sensitive');
  assert.equal(aqiCategory(200), 'Unhealthy');
  assert.equal(aqiCategory(301), 'Hazardous');
});

test('daylight delta reads in the direction the day moved', () => {
  assert.equal(daylightLabel({ seconds: 50780, deltaSeconds: -152 }), '14h 06m  ·  2m 32s shorter');
  assert.equal(daylightLabel({ seconds: 50780, deltaSeconds: 152 }), '14h 06m  ·  2m 32s longer');
  assert.equal(daylightLabel({ seconds: 50780, deltaSeconds: 45 }), '14h 06m  ·  45s longer');
  // Around the solstice the change is under a rounding threshold.
  assert.equal(daylightLabel({ seconds: 54000, deltaSeconds: 3 }), '15h 00m  ·  same as yesterday');
});

test('weather ids stay on the local day through the evening', async () => {
  const { weatherKey } = await import('../src/sources/weather.js');
  // 7:00pm and 9:00am on Aug 12 in Chicago: different UTC dates, same local day.
  assert.equal(weatherKey('today', new Date('2026-08-13T00:00:00Z')), 'today:2026-08-12');
  assert.equal(weatherKey('today', new Date('2026-08-12T14:00:00Z')), 'today:2026-08-12');
});
