// Thin client for the Visual Sentinel REST API (https://visualsentinel.com).
// Auth: X-API-Key with a `vs_...` key. We poll OPEN alerts to learn which
// monitors are currently DOWN. Each alert already carries the monitor name/url,
// so no second lookup is needed.
import { timedFetch } from './http.js';
import { config } from './config.js';

export interface VsAlert {
  id: string;
  source?: string; // "incident" | "server" | ...
  subject?: string;
  message: string;
  state: string; // OPEN | ACKNOWLEDGED | RESOLVED
  severity: string; // INFO | WARNING | CRITICAL
  monitorId?: string;
  monitorName?: string;
  monitor?: { id?: string; name?: string; url?: string; status?: string };
  serverName?: string;
  createdAt?: string;
  triggeredAt?: string;
}

async function vsGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(config.visualSentinel.baseUrl + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await timedFetch(url, {
    headers: {
      'X-API-Key': config.visualSentinel.apiKey,
      Accept: 'application/json',
      'User-Agent': 'print-notify',
    },
  });
  if (!res.ok) throw new Error(`Visual Sentinel ${res.status} on ${path}`);
  return res.json();
}

function asArray(json: any, ...keys: string[]): any[] {
  if (Array.isArray(json)) return json;
  for (const k of [...keys, 'data']) if (Array.isArray(json?.[k])) return json[k];
  return [];
}

/** Currently-open alerts (active problems, all kinds). */
export async function fetchOpenAlerts(): Promise<VsAlert[]> {
  const json = await vsGet('/api/alerts', { state: 'OPEN', limit: '100' });
  return asArray(json, 'alerts');
}

// A monitor.status that explicitly is NOT a down (visual/perf/content/etc).
const NOT_DOWN_STATUS = new Set(['UI_CHANGED', 'CONTENT_CHANGED', 'UP', 'SLOW', 'DEGRADED', 'SSL_EXPIRING']);
// Message patterns for non-down alert kinds we must never treat as "down".
const NOT_DOWN_TEXT = /ui changed|content changed|\bload\b|\bcpu\b|memory|response time|\bssl\b|certificate|pagespeed|latency/i;
// Unambiguous outage phrasing. This beats NOT_DOWN_TEXT, whose bare words also
// appear in monitor names: "Load balancer is down" is an outage, not a load alert.
// The lookahead keeps metrics out: "Response time is down 20%" is good news.
const OUTAGE_TEXT = /\b(is|are|went|gone) (down|offline)\b(?!\s+(to|by|\d))|\b(unreachable|not responding|stopped reporting|connection refused)\b/i;
// Message patterns that indicate an actual outage.
const DOWN_TEXT = /\b(down|offline|unreachable|not responding|no response|stopped reporting|timed out|timeout|is unavailable|connection refused)\b/i;

/** True only for genuine DOWN/offline events (not UI-change, load, SSL, etc.). */
export function isDownAlert(a: VsAlert): boolean {
  const status = (a.monitor?.status ?? '').toUpperCase();
  if (status === 'DOWN' || status === 'OFFLINE') return true;
  if (NOT_DOWN_STATUS.has(status)) return false;
  const text = `${a.subject ?? ''} ${a.message ?? ''}`;
  if (OUTAGE_TEXT.test(text)) return true;
  if (NOT_DOWN_TEXT.test(text)) return false;
  return DOWN_TEXT.test(text);
}

/** Human label for an alert's target. */
export function alertName(a: VsAlert): string {
  return a.monitorName ?? a.serverName ?? a.monitor?.name ?? a.subject ?? 'Monitor';
}
