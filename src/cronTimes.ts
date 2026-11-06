// node-cron can say when a schedule fires next, but never when it last should have
// fired, and catch-up needs the latter. Handles the numeric forms: *, lists, ranges
// and steps. Anything else (names like MON) returns null, which skips catch-up.

const FIELDS: [min: number, max: number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const MINUTE_MS = 60_000;

function parseField(spec: string, [min, max]: [number, number]): Set<number> | null {
  const values = new Set<number>();
  for (const part of spec.split(',')) {
    const m = part.match(/^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = Number(m[3] ?? 1);
    if (step < 1) return null;
    const from = m[1] === undefined ? min : Number(m[1]);
    const to = m[1] === undefined ? max : Number(m[2] ?? (m[3] ? max : m[1]));
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

/** Most recent time `expr` fired in `timeZone`, at or before `now` and within `lookbackMs`. */
export function lastFire(expr: string, timeZone: string, now: number, lookbackMs: number): number | null {
  const parts = expr.trim().split(/\s+/);
  // A six-field expression leads with seconds; catch-up only needs the minute.
  const specs = parts.length === 6 ? parts.slice(1) : parts;
  if (specs.length !== 5) return null;
  const fields = specs.map((p, i) => parseField(p, FIELDS[i]));
  if (fields.some((f) => !f)) return null;
  const [minutes, hours, days, months, weekdays] = fields as Set<number>[];
  const anyDay = specs[2] === '*';
  const anyWeekday = specs[4] === '*';

  const format = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short',
  });
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  for (let t = now - (now % MINUTE_MS); t >= now - lookbackMs; t -= MINUTE_MS) {
    const p = Object.fromEntries(format.formatToParts(t).map((x) => [x.type, x.value]));
    if (!minutes.has(Number(p.minute)) || !hours.has(Number(p.hour)) || !months.has(Number(p.month))) continue;
    const dow = WEEKDAYS.indexOf(p.weekday);
    const dayOk = days.has(Number(p.day));
    const weekdayOk = weekdays.has(dow) || (dow === 0 && weekdays.has(7));
    // Cron's rule: when both are restricted, either one matching is enough.
    if (anyDay || anyWeekday ? dayOk && weekdayOk : dayOk || weekdayOk) return t;
  }
  return null;
}
