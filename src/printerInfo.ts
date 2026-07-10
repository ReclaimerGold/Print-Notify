import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const run = promisify(exec);

export interface PrinterInfo {
  queue: string;
  deviceUri: string | null;
  state: 'idle' | 'processing' | 'disabled' | 'unknown';
  enabled: boolean;
  accepting: boolean;
  stateSince: string | null;
  /** e.g. "media-empty", "cover-open", "offline" — only if the printer reports them. */
  reasons: string[];
  /** Present on the USB bus right now. */
  connected: boolean;
  recentJobs: { id: string; when: string }[];
  note: string;
}

/** Run a shell command, swallowing non-zero exits (lpstat exits 1 when a queue is odd). */
async function safe(cmd: string): Promise<string> {
  try {
    const { stdout } = await run(cmd);
    return stdout;
  } catch (e: any) {
    return e?.stdout ?? '';
  }
}

const REASON_KEYS = [
  'media-empty', 'media-jam', 'media-low', 'cover-open', 'door-open',
  'toner-empty', 'offline', 'paused', 'marker-supply-empty', 'other',
];

export async function getPrinterInfo(): Promise<PrinterInfo> {
  const q = config.printer.queue;
  const [pStat, vStat, aStat, jobsOut, usb] = await Promise.all([
    safe(`lpstat -l -p ${q}`),
    safe(`lpstat -v ${q}`),
    safe(`lpstat -a ${q}`),
    safe(`lpstat -W completed -o ${q}`),
    safe('lsusb'),
  ]);

  const firstLine = pStat.split('\n')[0] ?? '';
  const disabled = /disabled since/.test(firstLine) || /is stopped/.test(firstLine);
  const stateMatch = firstLine.match(/is (idle|processing)/);
  const state: PrinterInfo['state'] = disabled
    ? 'disabled'
    : (stateMatch?.[1] as 'idle' | 'processing') ?? 'unknown';

  const sinceMatch = firstLine.match(/since (.+?)(?:\s+-|\.|$)/);

  const deviceUri = vStat.match(/device for .+?:\s*(.+)/)?.[1]?.trim() ?? null;
  const connected = /04b8:0202/i.test(usb) || /epson/i.test(usb);

  const reasons = REASON_KEYS.filter((k) => pStat.toLowerCase().includes(k));

  const recentJobs = jobsOut
    .split('\n')
    .filter((l) => l.trim().startsWith(q))
    .slice(0, 5)
    .map((l) => {
      const parts = l.trim().split(/\s+/);
      return { id: parts[0], when: parts.slice(3).join(' ') };
    });

  const note = !connected
    ? 'Printer not detected on USB bus — check power/cable.'
    : deviceUri?.includes('?serial=') && state !== 'disabled'
      ? 'Raw queue: CUPS cannot detect paper-out/cover-open. If jobs complete but nothing prints, check paper/cover and power-cycle the printer.'
      : 'OK';

  return {
    queue: q,
    deviceUri,
    state,
    enabled: !disabled,
    accepting: /accepting requests/.test(aStat),
    stateSince: sinceMatch?.[1]?.trim() ?? null,
    reasons,
    connected,
    recentJobs,
    note,
  };
}
