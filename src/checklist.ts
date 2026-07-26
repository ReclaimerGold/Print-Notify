// Builds and prints a compact, pen-checkable checklist from the Google Tasks
// lists (Tasks + Groceries). Used both for the standalone pocket print and
// embedded inside the morning digest.
import { config } from './config.js';
import { printReceipt } from './digest.js';
import { checklistImage, type ChecklistSpec } from './bitmap.js';
import { tasksSource } from './sources/tasks.js';
import { priceGroceries } from './prices/priceEstimator.js';
import type { NotificationItem } from './sources/types.js';

// Short-item sections (grocery names) flow into 2 columns to save paper.
const TWO_COL_MAX_LEN = 18;

/** Format a USD estimate for the receipt, e.g. 3.2 -> "~$3.20". */
function formatPrice(n: number): string {
  return `~$${n.toFixed(2)}`;
}

function today(): string {
  return new Date().toLocaleDateString('en-US', {
    timeZone: config.timezone,
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

/** Today as 'YYYY-MM-DD' in the configured timezone (for overdue comparison). */
function todayISO(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
}

/** 'YYYY-MM-DD' -> 'Due Jul 12' (built from parts, so no timezone shift). */
function formatDue(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const label = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `Due ${label}`;
}

/**
 * Group checkable items (those with `checked` set, grouped by their list title
 * in `source`) into a checklist spec. Within each section, items are prioritized
 * by due date (earliest first, undated last, completed sink to the bottom); past-
 * due items are flagged. `header` adds the wordmark + date for the standalone
 * print; the digest omits it (it already has its own header). When `city` is
 * given, priced sections gain a right-aligned "Est. total ~$… · <city>" footer.
 */
export function checklistSpec(items: NotificationItem[], header: boolean, city?: string): ChecklistSpec {
  const iso = todayISO();
  const groups = new Map<string, { text: string; checked: boolean; due?: string; price?: number }[]>();
  for (const it of items) {
    if (it.checked === undefined) continue;
    const list = groups.get(it.source) ?? [];
    list.push({ text: it.title, checked: Boolean(it.checked), due: it.due, price: it.price });
    groups.set(it.source, list);
  }
  const sections = [...groups].map(([name, list]) => {
    const sorted = [...list].sort((a, b) => {
      const ra = a.checked ? 1 : 0, rb = b.checked ? 1 : 0; // completed last
      if (ra !== rb) return ra - rb;
      const ad = a.due ?? '9999-99-99', bd = b.due ?? '9999-99-99'; // undated last
      return ad < bd ? -1 : ad > bd ? 1 : 0;
    });
    const rows = sorted.map((i) => ({
      text: i.text,
      checked: i.checked,
      due: i.due ? formatDue(i.due) : undefined,
      overdue: i.due !== undefined && !i.checked && i.due < iso,
      price: i.price !== undefined ? formatPrice(i.price) : undefined,
    }));
    const hasDue = rows.some((r) => r.due);
    const hasPrice = rows.some((r) => r.price);
    // Estimated total for the section: sum of priced items only, so the number
    // stays honest and notes "n/m priced" when some items couldn't be matched.
    const priced = list.filter((i) => i.price !== undefined);
    let total: string | undefined;
    if (priced.length > 0) {
      const sum = priced.reduce((s, i) => s + (i.price ?? 0), 0);
      const where = city ? ` · ${city}` : '';
      const partial = priced.length < list.length ? `  (${priced.length}/${list.length} priced)` : '';
      total = `Est. total ${formatPrice(sum)}${where}${partial}`;
    }
    return {
      name: name.toUpperCase(),
      // Two columns only for short, undated, unpriced lists (a subline or an
      // inline price needs the full width).
      columns: !hasDue && !hasPrice && rows.every((r) => r.text.length <= TWO_COL_MAX_LEN) ? 2 : 1,
      total,
      items: rows,
    };
  });
  return { title: header ? 'FERRIX CHECKLIST' : '', date: header ? today() : '', sections };
}

/**
 * Like `checklistSpec`, but first annotates grocery items with estimated prices
 * (best-effort — any geocode/estimate failure prints the list without prices).
 * This is the single entry point used by the digest, section, and standalone
 * checklist paths so pricing is applied consistently.
 */
export async function pricedChecklistSpec(items: NotificationItem[], header: boolean): Promise<ChecklistSpec> {
  let city: string | undefined;
  try {
    const pricing = await priceGroceries(items);
    city = pricing?.city || undefined;
  } catch {
    // Pricing is best-effort; on any failure fall back to a price-less list.
  }
  return checklistSpec(items, header, city);
}

export function checklistItemCount(spec: ChecklistSpec): number {
  return spec.sections.reduce((n, s) => n + s.items.length, 0);
}

/** Print the standalone pocket checklist. Returns item count (0 = nothing printed). */
export async function printChecklist(): Promise<number> {
  if (!config.sources.googleTasks.enabled) {
    throw new Error('Google Tasks is not configured (set GOOGLE_* in .env)');
  }
  const spec = await pricedChecklistSpec(await tasksSource.fetch(), true);
  const count = checklistItemCount(spec);
  if (count === 0) return 0; // nothing to do — don't waste paper
  await printReceipt([{ type: 'image', path: await checklistImage(spec), align: 'center' }]);
  return count;
}

/** Convenience for the standalone preview endpoint. */
export async function buildChecklistSpec(): Promise<ChecklistSpec> {
  return pricedChecklistSpec(await tasksSource.fetch(), true);
}
