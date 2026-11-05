import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { buildDigestBlocks, sectionRows, sourceRank, SOURCE_ORDER, type Block } from '../src/digest.js';
import { matchSnapshot } from './snapshot.js';
import type { NotificationItem } from '../src/sources/types.js';

const HOUR = 3_600_000;
// Fixed offsets from "now" so relative ages ("3h ago") are stable across runs.
const now = Date.now();

const item = (over: Partial<NotificationItem> & Pick<NotificationItem, 'id' | 'source' | 'title'>): NotificationItem => ({
  severity: 'info',
  timestamp: now,
  ...over,
});

/** A digest with every section type represented, in deliberately wrong order. */
const FIXTURE: NotificationItem[] = [
  item({ id: 'gh:1', source: 'github', title: 'acme/widgets', detail: 'Fix the flange (review requested)', icon: '◉', url: 'https://github.com/acme/widgets/pull/7', timestamp: now - 3 * HOUR }),
  item({ id: 'news:1', source: 'news', title: 'City council approves the thing', detail: 'Local Herald', url: 'https://herald.test/a', timestamp: now - 5 * HOUR }),
  item({ id: 'news:2', source: 'news', title: 'Second story with no link', detail: 'Local Herald', timestamp: now - 6 * HOUR }),
  item({ id: 'cal:1', source: 'calendar', title: 'Standup', detail: '9:00a-9:30a' }),
  item({ id: 'cal:2', source: 'calendar', title: 'Offsite', detail: 'all day' }),
  item({ id: 'bday:1', source: 'birthdays', title: 'Dana', detail: 'tomorrow  ·  turns 36', icon: '★' }),
  item({ id: 'sport:1', source: 'sports', title: 'Twins L 1-2 at Orioles', detail: 'MLB  ·  Final', icon: '▪' }),
  item({ id: 'cert:1', source: 'certs', title: 'example.com — TLS cert expires in 5 days', detail: 'Sep 1, 2026  ·  Let\'s Encrypt', severity: 'urgent', icon: '⚠' }),
  item({ id: 'task:1', source: 'tasks', title: 'Call the plumber', checked: false }),
];

/**
 * Strip the parts that legitimately vary between runs, keeping what the snapshot
 * is actually about: section order, headers, row text, link markers, and which
 * kind of bitmap sits where. Image paths are content-hashed into a temp cache,
 * so only their kind prefix is meaningful.
 */
function normalize(blocks: Block[]): unknown[] {
  return blocks.map((b) => {
    if (b.type === 'image') {
      const kind = basename(b.path).replace(/-[0-9a-f]{8,}\.png$/, '').replace(/\.png$/, '');
      return { type: 'image', kind, align: b.align };
    }
    if (b.type === 'text' && 'text' in b) {
      // The dateline is the only genuinely time-varying text block.
      const text = /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d+, /.test(b.text) ? '<TIMESTAMP>' : b.text;
      return { ...b, text };
    }
    return b;
  });
}

test('sections print in the canonical order regardless of input order', async () => {
  const blocks = await buildDigestBlocks('Test Digest', FIXTURE);
  assert.ok(blocks.length > 0);
  // Section headers render as bitmaps, so assert on the ranking function that
  // decides their order rather than trying to read text out of the blocks.
  assert.ok(sourceRank('weather') < sourceRank('calendar'));
  assert.ok(sourceRank('calendar') < sourceRank('birthdays'));
  assert.ok(sourceRank('birthdays') < sourceRank('news'));
  assert.ok(sourceRank('news') < sourceRank('sports'));
  assert.ok(sourceRank('sports') < sourceRank('github'));
  assert.ok(sourceRank('github') < sourceRank('certs'));
  // Case-insensitive, since Tasks/Groceries are Google Tasks list titles.
  assert.equal(sourceRank('Groceries'), sourceRank('groceries'));
  // Anything unregistered sorts to the end.
  assert.equal(sourceRank('something-new'), SOURCE_ORDER.length);
});

test('full digest layout', async () => {
  const blocks = await buildDigestBlocks('Test Digest', FIXTURE);
  matchSnapshot('digest-full', normalize(blocks));
});

test('section rows, in print order', () => {
  // The row text is what the reader actually sees; the block list above only
  // proves which *kind* of bitmap sits where.
  const rows = Object.fromEntries(
    ['calendar', 'birthdays', 'news', 'sports', 'github', 'certs']
      .map((s) => [s, sectionRows(s, FIXTURE.filter((i) => i.source === s))]),
  );
  matchSnapshot('digest-rows', rows);
});

test('a source with no list renderer falls back to plain text lines', () => {
  assert.equal(sectionRows('tasks', FIXTURE.filter((i) => i.source === 'tasks')), null);
});

test('a failed source prints a placeholder instead of vanishing', async () => {
  const blocks = await buildDigestBlocks('Test Digest', FIXTURE, [
    { source: 'weather', message: 'Open-Meteo 503' },
  ]);
  const texts = blocks.flatMap((b) => (b.type === 'text' && 'text' in b ? [b.text] : []));
  assert.ok(texts.some((t) => t.includes('Unavailable') && t.includes('Open-Meteo 503')));
});

test('an over-long source error is truncated to fit the paper', async () => {
  const blocks = await buildDigestBlocks('Test Digest', [], [
    { source: 'news', message: 'x'.repeat(200) },
  ]);
  const line = blocks.flatMap((b) => (b.type === 'text' && 'text' in b ? [b.text] : []))
    .find((t) => t.includes('Unavailable'));
  assert.ok(line);
  assert.ok(line.length < 80, `error line was ${line.length} chars`);
  assert.ok(line.endsWith('…'));
});

test('an empty digest says so rather than printing empty sections', async () => {
  const blocks = await buildDigestBlocks('Test Digest', []);
  const texts = blocks.flatMap((b) => (b.type === 'text' && 'text' in b ? [b.text] : []));
  assert.ok(texts.some((t) => t.includes('Nothing new')));
  matchSnapshot('digest-empty', normalize(blocks));
});

test('a printer-health footnote rides out on the receipt', async () => {
  const blocks = await buildDigestBlocks('Test Digest', FIXTURE, [], '** paper low — load a new roll **');
  const last = blocks[blocks.length - 1];
  assert.equal(last.type === 'text' && 'text' in last ? last.text : null, '** paper low — load a new roll **');
});
