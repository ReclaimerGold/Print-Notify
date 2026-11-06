import { config } from './config.js';
import { printDocument, type ThermalDevice } from './printer.js';
import { LOGO_PRINT_PATH } from './logo.js';
import { textImage, checklistImage, listImage, type ListRow } from './bitmap.js';
import { pricedChecklistSpec, checklistItemCount } from './checklist.js';
import { submit, setRenderer, healthFootnote, type SubmitResult } from './printQueue.js';
import { getPrinterInfo } from './printerInfo.js';
import { archiveReceipt } from './archive.js';
import type { NotificationItem } from './sources/types.js';

const SEVERITY_MARK: Record<string, string> = { urgent: '!! ', notice: ' * ', info: '   ' };

/**
 * Canonical section order shared by the printed digest and the dashboard tiles.
 * Matched case-insensitively (Tasks/Groceries are Google Tasks list titles);
 * anything unlisted sorts to the end in first-seen order.
 *
 * Roughly: what the day looks like, then what you owe it, then what happened.
 * Certs sit last — it's an ops footnote that should never crowd the top.
 */
export const SOURCE_ORDER = [
  'weather', 'calendar', 'birthdays', 'tasks', 'groceries', 'news', 'sports', 'github', 'certs',
];

export function sourceRank(source: string): number {
  const i = SOURCE_ORDER.indexOf(source.toLowerCase());
  return i === -1 ? SOURCE_ORDER.length : i;
}

/**
 * A receipt is an ordered list of Blocks. The printer and the web preview both
 * render from this same list, so what you see is exactly what prints.
 */
/** An inline styled span within a `runs` text block (lets a bold label lead a
 *  non-bold value on the same line, e.g. **HAZARD**  destructive winds). */
export type TextRun = { text: string; bold?: boolean };

export type Block =
  | { type: 'image'; path: string; align?: 'center' | 'left' }
  | { type: 'text'; text: string; bold?: boolean; align?: 'center' | 'left' }
  | { type: 'text'; runs: TextRun[]; align?: 'center' | 'left' }
  | { type: 'rule' }
  | { type: 'space' };

function groupBySource(items: NotificationItem[]): Map<string, NotificationItem[]> {
  const groups = new Map<string, NotificationItem[]>();
  for (const it of items) {
    const list = groups.get(it.source) ?? [];
    list.push(it);
    groups.set(it.source, list);
  }
  // Emit sections in the canonical order (weather, calendar, tasks, groceries,
  // news, github); unlisted sources keep first-seen order at the end.
  return new Map([...groups].sort((a, b) => sourceRank(a[0]) - sourceRank(b[0])));
}

function nowStamp(): string {
  return new Date().toLocaleString('en-US', {
    timeZone: config.timezone,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/** Blocks for a single item: bitmap image (if any) + native text lines. */
function itemBlocks(it: NotificationItem): Block[] {
  if (it.image) {
    const blocks: Block[] = [{ type: 'image', path: it.image, align: 'center' }];
    if (it.title) blocks.push({ type: 'text', text: it.title, bold: true, align: 'center' });
    if (it.detail) blocks.push({ type: 'text', text: it.detail, align: 'center' });
    return blocks;
  }
  // Tasks/groceries: a pen-checkable box.
  if (it.checked !== undefined) {
    return [{ type: 'text', text: `${it.checked ? '[x]' : '[ ]'}  ${it.title}` }];
  }
  // News and calendar are rendered as styled bitmaps (see news/calendarRows).
  const blocks: Block[] = [{ type: 'text', text: `${SEVERITY_MARK[it.severity]}${it.title}` }];
  if (it.detail) blocks.push({ type: 'text', text: `     ${it.detail}` });
  return blocks;
}

/** Short, human relative age for a timestamp, e.g. "just now", "3h ago", "2d ago". */
function relAge(ts: number): string {
  const s = Math.max(0, Date.now() - ts) / 1000;
  if (s < 3600) {
    const m = Math.round(s / 60);
    return m <= 1 ? 'just now' : `${m}m ago`;
  }
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  const d = Math.round(s / 86_400);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

/** Join the non-empty parts of a metadata subline with the standard separator. */
const subline = (...parts: (string | undefined)[]) =>
  parts.filter(Boolean).join('  ·  ') || undefined;

/** News rows: bold headline + non-bold "Outlet · 3h ago" metadata subline. */
function newsRows(list: NotificationItem[]): ListRow[] {
  return list.map((it) => ({
    primary: it.title,
    sub: subline(it.detail, relAge(it.timestamp)),
  }));
}

/** Generic marker + headline + detail rows (birthdays, sports, certs). */
function iconRows(list: NotificationItem[]): ListRow[] {
  return list.map((it) => ({
    icon: it.icon,
    primary: it.title,
    sub: subline(it.detail),
  }));
}

/** Calendar rows: bold time in a left column, bold event, "until <end>" subline. */
function calendarRows(list: NotificationItem[]): ListRow[] {
  return list.map((it) => {
    const range = it.detail ?? '';
    if (range === 'all day') return { left: 'All day', primary: it.title };
    const [start, end] = range.split('-');
    return { left: start || '', primary: it.title, sub: end ? `until ${end}` : undefined };
  });
}

/** GitHub rows: per-reason icon marker, bold repo headline, "PR title (reason) · 3h ago" subline. */
function githubRows(list: NotificationItem[]): ListRow[] {
  return list.map((it) => ({
    icon: it.icon,
    primary: it.title,
    // Real PR rows get a "PR title (reason) · 3h ago" subline; the "+N more"
    // summary row has no detail, so it stays a bare headline.
    sub: it.detail ? subline(it.detail, relAge(it.timestamp)) : undefined,
  }));
}

/** Sources rendered as styled `listImage` bitmaps, and whether rows get dividers. */
const LIST_SECTIONS: Record<string, { divider: boolean; rows: (list: NotificationItem[]) => ListRow[] }> = {
  news: { divider: true, rows: newsRows },
  calendar: { divider: false, rows: calendarRows },
  github: { divider: true, rows: githubRows },
  birthdays: { divider: false, rows: iconRows },
  sports: { divider: false, rows: iconRows },
  certs: { divider: false, rows: iconRows },
};

/**
 * The styled rows for one source, or null when it has no list renderer (and so
 * falls back to the per-item text layout). Separated from block-building so the
 * row text — markers, sublines, ordering — is assertable without rendering PNGs.
 */
export function sectionRows(source: string, list: NotificationItem[]): ListRow[] | null {
  const spec = LIST_SECTIONS[source];
  return spec ? spec.rows(list) : null;
}

/** Styled body blocks for one source's items (non-checklist). Most sources render
 *  as a bitmap via listImage; anything unlisted uses the per-item text layout. */
async function sectionBodyBlocks(source: string, list: NotificationItem[]): Promise<Block[]> {
  const rows = sectionRows(source, list);
  if (!rows) return list.flatMap(itemBlocks);
  return [{ type: 'image', path: await listImage(rows, LIST_SECTIONS[source].divider), align: 'center' }];
}

/** A source that failed to fetch (from fetchAll's `errors`). */
export interface SourceError { source: string; message: string }

/** Build the full ordered block list for a digest. `errors` are enabled sources
 *  that failed to fetch; each prints a visible "unavailable" line in its slot so
 *  a failed source (e.g. weather) never just silently vanishes from the digest. */
export async function buildDigestBlocks(
  title: string,
  items: NotificationItem[],
  errors: SourceError[] = [],
  footnote?: string,
): Promise<Block[]> {
  const blocks: Block[] = [
    { type: 'image', path: LOGO_PRINT_PATH, align: 'center' },
    { type: 'image', path: await textImage(title, 'title'), align: 'center' },
    { type: 'text', text: nowStamp(), align: 'center' },
    { type: 'rule' },
  ];

  if (items.length === 0 && errors.length === 0) {
    blocks.push({ type: 'space' }, { type: 'text', text: 'Nothing new. Enjoy the quiet.', align: 'center' });
    return blocks;
  }

  // Checkable items (Google Tasks lists) render as one full-width checklist
  // bitmap combining Tasks + Groceries. It prints at the first checkable
  // source's slot in the canonical order (i.e. between calendar and news),
  // so the digest reads weather, calendar, tasks/groceries, news, github.
  const checklist = await pricedChecklistSpec(items, false);
  const hasChecklist = checklistItemCount(checklist) > 0;
  let checklistEmitted = false;

  // Merge sources that have items with sources that errored, so a failed source
  // still prints a placeholder in its canonical slot instead of disappearing.
  const grouped = groupBySource(items);
  const errored = errors.filter((e) => !grouped.has(e.source));
  const order = [...new Set([...grouped.keys(), ...errored.map((e) => e.source)])]
    .sort((a, b) => sourceRank(a) - sourceRank(b));

  for (const source of order) {
    const list = grouped.get(source);
    if (!list) {
      // Errored source with no items: show a visible "unavailable" placeholder.
      const message = errored.find((e) => e.source === source)?.message ?? 'unavailable';
      const short = message.length > 52 ? `${message.slice(0, 51)}…` : message;
      blocks.push({ type: 'image', path: await textImage(source.toUpperCase(), 'section'), align: 'center' });
      blocks.push({ type: 'space' });
      blocks.push({ type: 'text', text: `   Unavailable — ${short}` });
      blocks.push({ type: 'space' });
      continue;
    }
    if (list.every((it) => it.checked !== undefined)) {
      // Checkable list: emit the combined checklist once, at this position.
      if (hasChecklist && !checklistEmitted) {
        blocks.push({ type: 'image', path: await checklistImage(checklist), align: 'center' });
        blocks.push({ type: 'space' });
        checklistEmitted = true;
      }
      continue;
    }
    blocks.push({ type: 'image', path: await textImage(`${source.toUpperCase()}  (${list.length})`, 'section'), align: 'center' });
    blocks.push({ type: 'space' });
    blocks.push(...await sectionBodyBlocks(source, list));
    blocks.push({ type: 'space' });
  }

  blocks.push({ type: 'rule' }, { type: 'text', text: `${items.length} items`, align: 'center' });
  // Printer-health footnote (e.g. "paper low"), so the warning rides out on the
  // last receipt that fits rather than waiting for a dashboard visit.
  if (footnote) blocks.push({ type: 'text', text: footnote, align: 'center' });
  return blocks;
}

// The queue renders through this module, and this module submits through the
// queue. Injecting the renderer keeps that from becoming an import cycle.
setRenderer((blocks) => printDocument((p) => renderBlocks(p, blocks)));

/**
 * Print any ordered block list (digest, alert, sentinel) through one pipeline:
 * health-check → paper (or hold) → archive. Returns whether it reached paper,
 * so callers can tell the user the truth rather than assuming.
 */
export async function printReceipt(blocks: Block[], label = 'Receipt'): Promise<SubmitResult> {
  const result = await submit(label, blocks);
  // Archiving runs after the paper is out and never blocks or fails the print.
  void archiveReceipt(label, blocks, result.printed);
  return result;
}

/** Send an ordered block list to the thermal printer. */
async function renderBlocks(p: ThermalDevice, blocks: Block[]): Promise<void> {
  for (const b of blocks) {
    switch (b.type) {
      case 'image':
        p.alignCenter();
        if (b.align === 'left') p.alignLeft();
        await p.printImage(b.path);
        p.alignLeft();
        break;
      case 'text':
        p.alignLeft();
        if (b.align === 'center') p.alignCenter();
        if ('runs' in b) {
          // Inline styling: toggle bold per span, flowing on one line (the
          // printer wraps long spans at the column width on its own).
          for (const r of b.runs) {
            if (r.bold) p.bold(true);
            p.print(r.text);
            if (r.bold) p.bold(false);
          }
          p.newLine();
        } else {
          if (b.bold) p.bold(true);
          p.println(b.text);
          if (b.bold) p.bold(false);
        }
        p.alignLeft();
        break;
      case 'rule':
        p.drawLine();
        break;
      case 'space':
        p.newLine();
        break;
    }
  }
}

/** Print a full, grouped digest of all items. */
export async function printDigest(
  title: string,
  items: NotificationItem[],
  errors: SourceError[] = [],
): Promise<SubmitResult> {
  // Ask the printer how it's doing before composing, so a "paper low" warning
  // can ride out on this receipt instead of waiting for someone to check.
  const footnote = await printerFootnote();
  const blocks = await buildDigestBlocks(title, items, errors, footnote);
  return printReceipt(blocks, title);
}

/** Current printer-health footnote, or undefined when it can't be determined. */
async function printerFootnote(): Promise<string | undefined> {
  try {
    return healthFootnote(await getPrinterInfo());
  } catch {
    return undefined;
  }
}

/** Print just one source's items (a single dashboard tile). Checkable lists
 *  (Tasks/Groceries) render as the pen-checkable checklist bitmap; everything
 *  else uses the same per-item layout as the full digest. */
export async function printSection(source: string, items: NotificationItem[]): Promise<SubmitResult> {
  const blocks: Block[] = [
    { type: 'image', path: LOGO_PRINT_PATH, align: 'center' },
    { type: 'image', path: await textImage(source.toUpperCase(), 'title'), align: 'center' },
    { type: 'text', text: nowStamp(), align: 'center' },
    { type: 'rule' },
  ];
  const checklist = await pricedChecklistSpec(items, false);
  if (checklistItemCount(checklist) > 0) {
    blocks.push({ type: 'image', path: await checklistImage(checklist), align: 'center' });
  } else {
    blocks.push({ type: 'space' });
    blocks.push(...await sectionBodyBlocks(source, items));
    blocks.push({ type: 'space' });
  }
  blocks.push({ type: 'rule' }, { type: 'text', text: `${items.length} item${items.length === 1 ? '' : 's'}`, align: 'center' });
  return printReceipt(blocks, source.toUpperCase());
}

/** Print a compact, high-visibility alert for a small set of urgent items. */
export async function printAlert(items: NotificationItem[]): Promise<SubmitResult> {
  const blocks: Block[] = [
    { type: 'image', path: LOGO_PRINT_PATH, align: 'center' },
    { type: 'image', path: await textImage('!! URGENT !!', 'title'), align: 'center' },
    { type: 'text', text: nowStamp(), align: 'center' },
    { type: 'rule' },
  ];
  for (const it of items) {
    blocks.push({ type: 'text', text: `[${it.source}] ${it.title}`, bold: true });
    if (it.detail) blocks.push({ type: 'text', text: it.detail });
    blocks.push({ type: 'space' });
  }
  return printReceipt(blocks, 'Urgent Alert');
}
