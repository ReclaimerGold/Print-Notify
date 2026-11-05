import { connect, type TLSSocket } from 'node:tls';
import { config } from '../config.js';
import { daysUntil } from '../ics.js';
import type { Source, NotificationItem } from './types.js';

/**
 * TLS certificate and domain-registration expiry for a watched list of hosts.
 *
 * Certificates come straight from a TLS handshake — no API, no key, and it sees
 * exactly what a browser would. Domain expiry comes from RDAP (the structured
 * successor to WHOIS) via rdap.org, which redirects to the authoritative
 * registry; also keyless.
 *
 * Only entries inside CERT_NOTICE_DAYS are surfaced, so a healthy fleet prints
 * nothing. That's the whole design goal: silence until it matters.
 */

interface Expiry {
  host: string;
  kind: 'cert' | 'domain';
  expiresMs: number;
  /** Issuer CN for certs, registrar name for domains. */
  by?: string;
}

/** Split "example.com:8443" into host + port (443 default). */
function parseHost(entry: string): { host: string; port: number } {
  const m = entry.match(/^(?:https?:\/\/)?([^/:]+)(?::(\d+))?/);
  if (!m) return { host: entry, port: 443 };
  return { host: m[1], port: m[2] ? Number(m[2]) : 443 };
}

/**
 * The registrable domain to ask RDAP about. A deliberate simplification: the
 * last two labels, plus a third for the common two-part public suffixes we're
 * likely to meet. RDAP simply 404s on a wrong guess, which we swallow.
 */
const TWO_PART_TLDS = new Set(['co.uk', 'org.uk', 'ac.uk', 'co.nz', 'com.au', 'co.jp', 'com.br']);

export function registrableDomain(host: string): string {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  return TWO_PART_TLDS.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

/** Open a TLS connection just far enough to read the peer certificate. */
function fetchCertExpiry(host: string, port: number, timeoutMs: number): Promise<Expiry> {
  return new Promise((resolve, reject) => {
    let socket: TLSSocket;
    const done = (fn: () => void) => {
      clearTimeout(timer);
      socket?.destroy();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error('TLS timeout'))), timeoutMs);

    try {
      socket = connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
        const cert = socket.getPeerCertificate();
        if (!cert?.valid_to) return done(() => reject(new Error('no peer certificate')));
        const expiresMs = Date.parse(cert.valid_to);
        if (Number.isNaN(expiresMs)) return done(() => reject(new Error(`bad valid_to "${cert.valid_to}"`)));
        // Issuer fields are string | string[] depending on how many values the
        // cert carries for that attribute; we only ever want one name to print.
        const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
        const issuer = first(cert.issuer?.O) ?? first(cert.issuer?.CN);
        done(() => resolve({ host, kind: 'cert', expiresMs, by: issuer }));
      });
      socket.on('error', (e) => done(() => reject(e)));
    } catch (e) {
      done(() => reject(e as Error));
    }
  });
}

/** Domain registration expiry via RDAP (keyless; rdap.org routes to the registry). */
async function fetchDomainExpiry(domain: string, timeoutMs: number): Promise<Expiry> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/rdap+json', 'User-Agent': 'print-notify' },
    });
    if (!res.ok) throw new Error(`RDAP ${res.status}`);
    const body: any = await res.json();
    const event = (body.events ?? []).find((e: any) => e.eventAction === 'expiration');
    if (!event?.eventDate) throw new Error('no expiration event');
    const expiresMs = Date.parse(event.eventDate);
    if (Number.isNaN(expiresMs)) throw new Error(`bad eventDate "${event.eventDate}"`);
    // The registrar entity carries an fn (formatted name) in its vCard array.
    const registrar = (body.entities ?? []).find((e: any) => e.roles?.includes('registrar'));
    const fn = registrar?.vcardArray?.[1]?.find((f: any) => f[0] === 'fn')?.[3];
    return { host: domain, kind: 'domain', expiresMs, by: typeof fn === 'string' ? fn : undefined };
  } finally {
    clearTimeout(timer);
  }
}

/** Severity ramp: urgent inside urgentDays, notice inside noticeDays. */
export function expirySeverity(days: number): NotificationItem['severity'] {
  const { urgentDays } = config.sources.certs;
  return days <= urgentDays ? 'urgent' : 'notice';
}

function label(e: Expiry, days: number): { title: string; detail: string } {
  const what = e.kind === 'cert' ? 'TLS cert' : 'Domain';
  const when =
    days < 0 ? `EXPIRED ${Math.abs(days)}d ago`
    : days === 0 ? 'expires today'
    : days === 1 ? 'expires tomorrow'
    : `expires in ${days} days`;
  const on = new Date(e.expiresMs).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: config.timezone,
  });
  return {
    title: `${e.host} — ${what} ${when}`,
    detail: [on, e.by].filter(Boolean).join('  ·  '),
  };
}

export const certsSource: Source = {
  name: 'certs',
  enabled: config.sources.certs.enabled,
  async fetch(): Promise<NotificationItem[]> {
    const { hosts, checkDomains, noticeDays, timeoutMs } = config.sources.certs;

    // One probe per host (and per domain) in parallel; a host that's down must
    // not take the section with it, so every probe is settled independently.
    const probes: Promise<Expiry>[] = [];
    for (const entry of hosts) {
      const { host, port } = parseHost(entry);
      probes.push(fetchCertExpiry(host, port, timeoutMs));
    }
    if (checkDomains) {
      for (const domain of new Set(hosts.map((h) => registrableDomain(parseHost(h).host)))) {
        probes.push(fetchDomainExpiry(domain, timeoutMs));
      }
    }

    const settled = await Promise.allSettled(probes);
    const failures: string[] = [];
    const items: NotificationItem[] = [];

    for (const r of settled) {
      if (r.status === 'rejected') {
        failures.push(String((r.reason as Error)?.message ?? r.reason));
        continue;
      }
      const e = r.value;
      const days = daysUntil(e.expiresMs);
      // Quiet until it's close — a fleet with a year of runway prints nothing.
      if (days > noticeDays) continue;
      const { title, detail } = label(e, days);
      items.push({
        id: `certs:${e.kind}:${e.host}:${new Date(e.expiresMs).toISOString().slice(0, 10)}`,
        source: 'certs',
        title,
        detail,
        severity: expirySeverity(days),
        icon: days <= config.sources.certs.urgentDays ? '⚠' : '▪',
        timestamp: e.expiresMs,
      });
    }

    // Every probe failing is a real signal (network down, all hosts unreachable)
    // and should surface rather than looking like a clean bill of health.
    if (!items.length && failures.length === settled.length && failures.length > 0) {
      throw new Error(`all ${failures.length} checks failed: ${failures[0]}`);
    }
    // Soonest expiry first.
    return items.sort((a, b) => a.timestamp - b.timestamp);
  },
};
