// Hold-and-retry in front of the printer.
//
// CUPS accepts a job whether or not the printer can actually print it: with the
// cover open or the paper out, `lp` exits 0 and the receipt is gone. That makes
// the 7am digest silently unreliable — exactly when nobody is watching. So every
// receipt goes through here, which asks the printer how it's doing first, and
// holds the job on disk when the answer is "not right now".
//
// Held jobs are ordered block lists, not ESC/POS bytes: blocks are JSON, they
// survive a restart, and they re-render against whatever the bitmap cache holds.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.js';
import { getPrinterInfo, type PrinterInfo } from './printerInfo.js';
import type { Block } from './digest.js';

const FILE = 'data/print-queue.json';

export interface HeldJob {
  id: string;
  /** Human label for the dashboard, e.g. "Morning Digest". */
  label: string;
  blocks: Block[];
  /** ms since epoch when the job was first attempted. */
  queuedAt: number;
  attempts: number;
  lastError?: string;
}

/** Why the printer can't take a job right now, or null when it can. */
export function blockedReason(info: PrinterInfo): string | null {
  // A dry run never touches hardware, so it's always printable.
  if (config.printer.dryRun) return null;
  if (!info.connected) return 'printer not on the USB bus';
  if (!info.enabled || info.state === 'disabled') return 'queue disabled';
  if (!info.accepting) return 'queue not accepting jobs';

  // CUPS reason keys are the authoritative signal for the physical faults.
  const fatal: Record<string, string> = {
    'media-empty': 'out of paper',
    'media-jam': 'paper jam',
    'cover-open': 'cover open',
    'door-open': 'cover open',
    offline: 'printer offline',
    paused: 'queue paused',
  };
  for (const r of info.reasons) {
    const hit = fatal[r];
    if (hit) return hit;
  }
  return null;
}

/** True when the printer reports paper running low (a warning, not a blocker). */
export function paperLow(info: PrinterInfo): boolean {
  return info.reasons.includes('media-low');
}

/** The footnote to print on a receipt given current printer health. */
export function healthFootnote(info: PrinterInfo): string | undefined {
  return paperLow(info) ? '** paper low — load a new roll **' : undefined;
}

async function loadQueue(): Promise<HeldJob[]> {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveQueue(jobs: HeldJob[]): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(jobs, null, 2));
}

/** Drop jobs that have aged out, newest-first-capped to maxJobs. */
function prune(jobs: HeldJob[]): { kept: HeldJob[]; dropped: HeldJob[] } {
  const cutoff = Date.now() - config.printQueue.maxAgeHours * 3_600_000;
  const fresh = jobs.filter((j) => j.queuedAt >= cutoff);
  const dropped = jobs.filter((j) => j.queuedAt < cutoff);
  // Past the cap, the oldest go — a stale digest is worth less than a new one.
  if (fresh.length > config.printQueue.maxJobs) {
    dropped.push(...fresh.splice(0, fresh.length - config.printQueue.maxJobs));
  }
  return { kept: fresh, dropped };
}

let seq = 0;
const nextId = () => `job-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** How the queue actually puts bytes on paper. Injected to avoid a cycle with digest.ts. */
type Renderer = (blocks: Block[]) => Promise<void>;
let render: Renderer | null = null;

/** Wire up the renderer. Called once from digest.ts at import time. */
export function setRenderer(fn: Renderer): void {
  render = fn;
}

export interface SubmitResult {
  printed: boolean;
  /** Set when the job was held instead of printed. */
  heldReason?: string;
  /** Printer-health footnote to include on the receipt, if any. */
  footnote?: string;
}

/** Current printer health, or null when it can't be determined (treated as printable). */
async function health(): Promise<PrinterInfo | null> {
  try {
    return await getPrinterInfo();
  } catch {
    // If we can't ask, don't refuse to print — a broken lpstat shouldn't ground
    // the whole system. Fall through and let `lp` have its say.
    return null;
  }
}

/**
 * Print a receipt, or hold it for later if the printer can't take it.
 * Returns whether it went out, so callers can report honestly.
 */
export async function submit(label: string, blocks: Block[]): Promise<SubmitResult> {
  if (!render) throw new Error('print queue has no renderer');
  if (!config.printQueue.enabled) {
    await render(blocks);
    return { printed: true };
  }

  const info = await health();
  let reason = info ? blockedReason(info) : null;
  if (!reason) {
    try {
      await render(blocks);
      // A successful print is the right moment to drain anything held earlier.
      void flush().catch((e) => console.error('[queue] flush after print failed:', e));
      return { printed: true, footnote: info ? healthFootnote(info) : undefined };
    } catch (e) {
      // The printer looked fine a moment ago and `lp` still failed — a USB
      // hiccup, a queue disabled mid-write. Hold it rather than lose it; that's
      // the entire reason this layer exists.
      reason = String((e as Error)?.message ?? e);
    }
  }

  const jobs = await loadQueue();
  jobs.push({ id: nextId(), label, blocks, queuedAt: Date.now(), attempts: reason ? 1 : 0, lastError: reason });
  const { kept, dropped } = prune(jobs);
  await saveQueue(kept);
  if (dropped.length) console.warn(`[queue] dropped ${dropped.length} stale job(s)`);
  console.warn(`[queue] held "${label}" — ${reason} (${kept.length} waiting)`);
  return { printed: false, heldReason: reason };
}

/** Try to print everything held. Stops at the first failure to preserve order. */
export async function flush(): Promise<{ printed: number; remaining: number; reason?: string }> {
  if (!render) throw new Error('print queue has no renderer');
  const { kept, dropped } = prune(await loadQueue());
  if (dropped.length) console.warn(`[queue] dropped ${dropped.length} stale job(s)`);
  if (!kept.length) {
    if (dropped.length) await saveQueue(kept);
    return { printed: 0, remaining: 0 };
  }

  const info = await health();
  const reason = info ? blockedReason(info) : null;
  if (reason) {
    await saveQueue(kept);
    return { printed: 0, remaining: kept.length, reason };
  }

  let printed = 0;
  while (kept.length) {
    const job = kept[0];
    try {
      await render(job.blocks);
      kept.shift();
      printed++;
    } catch (e) {
      // Leave it at the head of the queue; order is the point of a backlog.
      job.attempts++;
      job.lastError = String((e as Error)?.message ?? e);
      console.error(`[queue] "${job.label}" failed (attempt ${job.attempts}):`, job.lastError);
      break;
    }
  }
  await saveQueue(kept);
  if (printed) console.log(`[queue] flushed ${printed} held job(s), ${kept.length} remaining`);
  return { printed, remaining: kept.length };
}

/** Queue contents for the dashboard (without the block payloads). */
export async function queueStatus(): Promise<{
  held: { id: string; label: string; queuedAt: string; attempts: number; lastError?: string }[];
}> {
  const jobs = await loadQueue();
  return {
    held: jobs.map((j) => ({
      id: j.id,
      label: j.label,
      queuedAt: new Date(j.queuedAt).toISOString(),
      attempts: j.attempts,
      lastError: j.lastError,
    })),
  };
}

/** Discard every held job (dashboard "clear" action). Returns how many went. */
export async function clearQueue(): Promise<number> {
  const jobs = await loadQueue();
  await saveQueue([]);
  return jobs.length;
}

let timer: NodeJS.Timeout | null = null;

/** Start the retry loop. Idempotent. */
export function startPrintQueue(): void {
  if (!config.printQueue.enabled || timer) return;
  const everyMs = Math.max(15, config.printQueue.retrySec) * 1000;
  timer = setInterval(() => {
    flush().catch((e) => console.error('[queue] retry failed:', e));
  }, everyMs);
  timer.unref?.();
  console.log(`[queue] hold-and-retry active (every ${config.printQueue.retrySec}s)`);
  // Drain anything left from a previous run as soon as we're up.
  flush().catch((e) => console.error('[queue] startup flush failed:', e));
}
