import { config } from './config.js';
import { printDocument, type ThermalDevice } from './printer.js';
import { LOGO_PRINT_PATH } from './logo.js';
import { textImage } from './bitmap.js';
import type { NotificationItem } from './sources/types.js';

const SEVERITY_MARK: Record<string, string> = { urgent: '!! ', notice: ' * ', info: '   ' };
const BULLET = '·'; // CP437-safe middle dot used as a list bullet

/**
 * A receipt is an ordered list of Blocks. The printer and the web preview both
 * render from this same list, so what you see is exactly what prints.
 */
export type Block =
  | { type: 'image'; path: string; align?: 'center' | 'left' }
  | { type: 'text'; text: string; bold?: boolean; align?: 'center' | 'left' }
  | { type: 'rule' }
  | { type: 'space' };

function groupBySource(items: NotificationItem[]): Map<string, NotificationItem[]> {
  const groups = new Map<string, NotificationItem[]>();
  for (const it of items) {
    const list = groups.get(it.source) ?? [];
    list.push(it);
    groups.set(it.source, list);
  }
  return groups;
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
  // Calendar: a timeline line — time range on the left, event on the right.
  if (it.source === 'calendar') {
    const time = (it.detail ?? '').padEnd(13);
    return [{ type: 'text', text: `${time}${it.title}` }];
  }
  // News: bullet + headline, then the source (outlet) in bold beneath it.
  if (it.source === 'news') {
    const blocks: Block[] = [{ type: 'text', text: `${BULLET} ${it.title}` }];
    if (it.detail) blocks.push({ type: 'text', text: `  ${it.detail}`, bold: true });
    return blocks;
  }
  const blocks: Block[] = [{ type: 'text', text: `${SEVERITY_MARK[it.severity]}${it.title}` }];
  if (it.detail) blocks.push({ type: 'text', text: `     ${it.detail}` });
  return blocks;
}

/** Build the full ordered block list for a digest. */
export async function buildDigestBlocks(title: string, items: NotificationItem[]): Promise<Block[]> {
  const blocks: Block[] = [
    { type: 'image', path: LOGO_PRINT_PATH, align: 'center' },
    { type: 'image', path: await textImage(title, 'title'), align: 'center' },
    { type: 'text', text: nowStamp(), align: 'center' },
    { type: 'rule' },
  ];

  if (items.length === 0) {
    blocks.push({ type: 'space' }, { type: 'text', text: 'Nothing new. Enjoy the quiet.', align: 'center' });
    return blocks;
  }

  for (const [source, list] of groupBySource(items)) {
    blocks.push({ type: 'image', path: await textImage(`${source.toUpperCase()}  (${list.length})`, 'section'), align: 'center' });
    blocks.push({ type: 'space' });
    for (const it of list) blocks.push(...itemBlocks(it));
    blocks.push({ type: 'space' });
  }
  blocks.push({ type: 'rule' }, { type: 'text', text: `${items.length} items`, align: 'center' });
  return blocks;
}

/** Print any ordered block list (digest, alert, sentinel) through one pipeline. */
export async function printReceipt(blocks: Block[]): Promise<void> {
  await printDocument((p) => renderBlocks(p, blocks));
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
        if (b.bold) p.bold(true);
        p.println(b.text);
        if (b.bold) p.bold(false);
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
export async function printDigest(title: string, items: NotificationItem[]): Promise<void> {
  const blocks = await buildDigestBlocks(title, items);
  await printReceipt(blocks);
}

/** Print a compact, high-visibility alert for a small set of urgent items. */
export async function printAlert(items: NotificationItem[]): Promise<void> {
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
  await printReceipt(blocks);
}
