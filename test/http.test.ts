import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { timedFetch } from '../src/http.js';

test('a stalled server is abandoned instead of hanging', async () => {
  const server = createServer(() => { /* never answers */ });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  await assert.rejects(timedFetch(`http://127.0.0.1:${port}`, {}, 50), /TimeoutError|aborted/);
  server.closeAllConnections();
  server.close();
});

test('no network call in src/ goes out without a timeout', () => {
  const root = join(import.meta.dirname, '..', 'src');
  const bare: string[] = [];
  for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.ts') || entry === 'http.ts') continue;
    const code = readFileSync(join(root, entry), 'utf8');
    // The call's options may wrap onto the next line.
    for (const m of code.matchAll(/await fetch\((.*\n?){2}/g)) {
      if (!m[0].includes('signal')) bare.push(`${entry}: ${m[0]}`);
    }
  }
  assert.deepEqual(bare, []);
});
