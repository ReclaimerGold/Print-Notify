// Uptime sentinel — Visual Sentinel only. Every `intervalSec` it polls OPEN
// alerts, keeps just the genuine DOWN events, and prints an ad-hoc receipt for
// any newly-detected outage.
//
// Rules (per user):
//   - Notify on DOWN events only (never UI-change / load / SSL / etc.).
//   - Never repeat a notification for the same ongoing outage.
//   - Re-notify only if a monitor recovers and then goes DOWN again (new alert).
//   - On first run, baseline existing outages silently (no paper dump).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from './config.js';
import { printReceipt, type Block } from './digest.js';
import { LOGO_PRINT_PATH } from './logo.js';
import { textImage } from './bitmap.js';
import { fetchOpenAlerts, isDownAlert, alertName, type VsAlert } from './visualSentinel.js';

const STATE_FILE = 'data/sentinel.json';

export type Provider = 'visualsentinel' | 'none';

export function provider(): Provider {
  return config.visualSentinel.apiKey ? 'visualsentinel' : 'none';
}

export interface SentinelEvent {
  name: string;
  to: 'down';
  detail?: string;
}

// Alert ids we've already notified about (or baselined). Persisted so restarts
// never re-notify an ongoing outage.
let notified = new Set<string>();
let baselined = false;
let lastDownAlerts: VsAlert[] = [];
let lastOtherOpen = 0;
let lastError: string | undefined;
let lastCheck: string | undefined;

function loadState(): void {
  if (!existsSync(STATE_FILE)) return;
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    notified = new Set(saved.notified ?? []);
    baselined = Boolean(saved.baselined);
  } catch {
    /* start fresh */
  }
}

function saveState(): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ notified: [...notified], baselined }));
  } catch {
    /* non-fatal */
  }
}

function stamp(): string {
  return new Date().toLocaleString('en-US', {
    timeZone: config.timezone,
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  });
}

/** Print one DOWN receipt for a batch of newly-detected outages. */
async function printDown(alerts: VsAlert[]): Promise<void> {
  const blocks: Block[] = [
    { type: 'image', path: LOGO_PRINT_PATH, align: 'center' },
    { type: 'image', path: await textImage('!! SENTINEL !!', 'title'), align: 'center' },
    { type: 'text', text: stamp(), align: 'center' },
    { type: 'rule' },
  ];
  for (const a of alerts) {
    const name = alertName(a);
    blocks.push({ type: 'image', path: await textImage('DOWN', 'section'), align: 'center' });
    blocks.push({ type: 'text', text: name, bold: true, align: 'center' });
    if (a.monitor?.url) blocks.push({ type: 'text', text: a.monitor.url, align: 'center' });
    if (a.message && a.message !== name) blocks.push({ type: 'text', text: a.message, align: 'center' });
    const when = a.triggeredAt ?? a.createdAt;
    blocks.push({
      type: 'text',
      text: `${a.severity}${when ? '  ·  ' + new Date(when).toLocaleString('en-US', { timeZone: config.timezone }) : ''}`,
      align: 'center',
    });
    blocks.push({ type: 'space' });
  }
  await printReceipt(blocks);
}

/** Run one poll cycle; prints on newly-detected DOWN monitors only. */
export async function runSentinel(): Promise<SentinelEvent[]> {
  lastCheck = new Date().toISOString();
  if (provider() !== 'visualsentinel') return [];
  try {
    const open = await fetchOpenAlerts();
    const down = open.filter(isDownAlert);
    lastDownAlerts = down;
    lastOtherOpen = open.length - down.length;

    const downIds = new Set(down.map((a) => a.id));

    // First ever run: baseline current outages silently (no dump).
    if (!baselined) {
      notified = new Set(downIds);
      baselined = true;
      saveState();
      lastError = undefined;
      return [];
    }

    const fresh = down.filter((a) => !notified.has(a.id));

    // notified = exactly the currently-open down ids. A resolved outage drops
    // out (so an up→down again gets a new id and re-notifies); an ongoing one
    // stays in and never repeats.
    notified = downIds;
    saveState();

    if (fresh.length) await printDown(fresh);
    lastError = undefined;
    return fresh.map((a) => ({ name: alertName(a), to: 'down' as const, detail: a.message }));
  } catch (e) {
    lastError = String(e);
    console.error('[sentinel]', e);
    return [];
  }
}

let timer: NodeJS.Timeout | undefined;

export function startSentinel(): void {
  if (!config.sentinel.enabled || provider() !== 'visualsentinel') {
    console.log('[sentinel] disabled (set VS_API_KEY)');
    return;
  }
  loadState();
  console.log(`[sentinel] Visual Sentinel, DOWN events only, polling every ${config.sentinel.intervalSec}s`);
  const tick = () => runSentinel().catch((e) => console.error('[sentinel]', e));
  tick();
  timer = setInterval(tick, config.sentinel.intervalSec * 1000);
}

export function stopSentinel(): void {
  if (timer) clearInterval(timer);
}

export function sentinelStatus() {
  return {
    provider: provider(),
    enabled: config.sentinel.enabled && provider() === 'visualsentinel',
    intervalSec: config.sentinel.intervalSec,
    lastCheck,
    error: lastError,
    otherOpen: lastOtherOpen,
    down: lastDownAlerts.map((a) => ({
      id: a.id,
      name: alertName(a),
      url: a.monitor?.url,
      message: a.message,
      severity: a.severity,
      since: a.triggeredAt ?? a.createdAt,
    })),
  };
}
