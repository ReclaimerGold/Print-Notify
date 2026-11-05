import { config } from '../config.js';
import type { Source, NotificationItem, DigestContext } from './types.js';

/**
 * Scores for a configured set of teams, via ESPN's public site API (keyless).
 *
 * We use the per-team schedule endpoint rather than the daily scoreboard: one
 * call per team returns the whole season, so the same request answers both
 * "what happened last night" and "when do they play next" without guessing
 * dates. Last night's final score is exactly the kind of thing paper is good at.
 */

/** Short league key -> ESPN's `{sport}/{league}` path segment. */
const LEAGUE_PATHS: Record<string, string> = {
  nfl: 'football/nfl',
  ncaaf: 'football/college-football',
  cfb: 'football/college-football',
  mlb: 'baseball/mlb',
  nba: 'basketball/nba',
  wnba: 'basketball/wnba',
  ncaam: 'basketball/mens-college-basketball',
  ncaaw: 'basketball/womens-college-basketball',
  nhl: 'hockey/nhl',
  mls: 'soccer/usa.1',
  epl: 'soccer/eng.1',
};

export const KNOWN_LEAGUES = Object.keys(LEAGUE_PATHS);

interface TeamSpec { league: string; abbr: string; path: string }

/** Parse "nfl:MIN" into a league path + team abbreviation. Unknown leagues are dropped. */
export function parseTeam(entry: string): TeamSpec | null {
  const [league, abbr] = entry.split(':').map((s) => s.trim());
  const path = LEAGUE_PATHS[league?.toLowerCase()];
  if (!path || !abbr) return null;
  return { league: league.toLowerCase(), abbr: abbr.toUpperCase(), path };
}

export interface Game {
  ms: number;
  completed: boolean;
  /** e.g. "Final", "Fri 7:00 PM CT", "Top 5th". */
  status: string;
  us: { abbr: string; name: string; score?: number; winner?: boolean; home: boolean };
  them: { abbr: string; name: string; score?: number; winner?: boolean; home: boolean };
}

/** Scores arrive as a bare string on the scoreboard feed and as an object on the schedule feed. */
function scoreOf(competitor: any): number | undefined {
  const raw = competitor?.score;
  const v = typeof raw === 'object' ? (raw?.value ?? raw?.displayValue) : raw;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function competitorInfo(c: any) {
  return {
    abbr: String(c?.team?.abbreviation ?? '').toUpperCase(),
    name: c?.team?.shortDisplayName ?? c?.team?.displayName ?? c?.team?.abbreviation ?? '?',
    score: scoreOf(c),
    winner: c?.winner === true,
    home: c?.homeAway === 'home',
  };
}

export function toGame(event: any, abbr: string): Game | null {
  const comp = event?.competitions?.[0];
  const competitors = comp?.competitors;
  if (!Array.isArray(competitors) || competitors.length < 2) return null;

  const sides = competitors.map(competitorInfo);
  const us = sides.find((s) => s.abbr === abbr);
  const them = sides.find((s) => s !== us);
  if (!us || !them) return null;

  const ms = Date.parse(comp?.date ?? event?.date ?? '');
  if (Number.isNaN(ms)) return null;

  const type = comp?.status?.type ?? event?.status?.type ?? {};
  return {
    ms,
    completed: type?.completed === true || type?.state === 'post',
    status: type?.shortDetail ?? type?.description ?? '',
    us,
    them,
  };
}

/** "W 27-24 vs CHI" / "L 3-5 at MIL" — the result, in the shape a fan reads it. */
export function resultLine(g: Game): string {
  const wl = g.us.winner ? 'W' : g.them.winner ? 'L' : 'T';
  const scores = g.us.score !== undefined && g.them.score !== undefined
    ? ` ${g.us.score}-${g.them.score}`
    : '';
  return `${wl}${scores} ${g.us.home ? 'vs' : 'at'} ${g.them.name}`;
}

/** "vs CHI · Sun 12:00 PM" — the next game, in local time. */
export function upcomingLine(g: Game): string {
  const when = new Date(g.ms).toLocaleString('en-US', {
    weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: config.timezone,
  });
  return `${g.us.home ? 'vs' : 'at'} ${g.them.name}  ·  ${when}`;
}

async function fetchTeamGames(spec: TeamSpec): Promise<Game[]> {
  const url =
    `https://site.api.espn.com/apis/site/v2/sports/${spec.path}` +
    `/teams/${encodeURIComponent(spec.abbr.toLowerCase())}/schedule`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'print-notify' } });
    if (!res.ok) throw new Error(`ESPN ${spec.league}:${spec.abbr} ${res.status}`);
    const body: any = await res.json();
    return (body?.events ?? [])
      .map((e: any) => toGame(e, spec.abbr))
      .filter((g: Game | null): g is Game => g !== null)
      .sort((a: Game, b: Game) => a.ms - b.ms);
  } finally {
    clearTimeout(timer);
  }
}

export const sportsSource: Source = {
  name: 'sports',
  enabled: config.sources.sports.enabled,
  async fetch(ctx?: DigestContext): Promise<NotificationItem[]> {
    const specs = config.sources.sports.teams.map(parseTeam).filter((s): s is TeamSpec => s !== null);
    if (!specs.length) return [];

    const settled = await Promise.allSettled(specs.map(fetchTeamGames));
    const now = Date.now();
    const lookbackMs = config.sources.sports.lookbackHours * 3_600_000;
    const items: NotificationItem[] = [];
    const failures: string[] = [];

    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      const spec = specs[i];
      if (r.status === 'rejected') {
        failures.push(String((r.reason as Error)?.message ?? r.reason));
        continue;
      }
      const games = r.value;
      const league = spec.league.toUpperCase();

      // A game in progress right now outranks both — it's the live thing.
      const live = games.find((g) => !g.completed && g.ms <= now && now - g.ms < 5 * 3_600_000);
      const recent = [...games].reverse().find((g) => g.completed && now - g.ms <= lookbackMs);
      const next = games.find((g) => !g.completed && g.ms > now);

      if (live) {
        items.push({
          id: `sports:${spec.league}:${spec.abbr}:live:${live.ms}`,
          source: 'sports',
          title: `${live.us.name} ${live.us.score ?? 0}-${live.them.score ?? 0} ${live.them.name}`,
          detail: [league, live.status || 'in progress'].filter(Boolean).join('  ·  '),
          severity: 'notice',
          icon: '◉',
          timestamp: live.ms,
        });
      } else if (recent) {
        items.push({
          id: `sports:${spec.league}:${spec.abbr}:final:${recent.ms}`,
          source: 'sports',
          title: `${recent.us.name} ${resultLine(recent)}`,
          detail: [league, 'Final'].join('  ·  '),
          severity: 'info',
          icon: recent.us.winner ? '★' : '▪',
          timestamp: recent.ms,
        });
      }

      // The evening digest is about tomorrow, so a next-game line always earns
      // its space there. In the morning it only does when there's nothing more
      // immediate to report — a team shouldn't print both a final and a preview.
      if (next && (ctx?.day === 'tomorrow' || (!recent && !live))) {
        items.push({
          id: `sports:${spec.league}:${spec.abbr}:next:${next.ms}`,
          source: 'sports',
          title: `${next.us.name} ${upcomingLine(next)}`,
          detail: league,
          severity: 'info',
          icon: '▫',
          timestamp: next.ms,
        });
      }
    }

    if (!items.length && failures.length === specs.length && failures.length > 0) {
      throw new Error(`all ${failures.length} teams failed: ${failures[0]}`);
    }
    // Most recent/soonest activity first.
    return items.sort((a, b) => Math.abs(a.timestamp - now) - Math.abs(b.timestamp - now));
  },
};
