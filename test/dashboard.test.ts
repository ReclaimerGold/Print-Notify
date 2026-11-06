import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');

test('no data value is interpolated into an inline handler', () => {
  // HTML-decoding runs before the handler parses, so esc() can't protect these.
  assert.deepEqual(html.match(/on(click|submit)="[^"]*\$\{/g) ?? [], []);
});
