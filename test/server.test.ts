import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Isolate from the real .env, queue, and printer before config is imported.
process.chdir(mkdtempSync(join(tmpdir(), 'print-notify-server-')));
process.env.PRINTER_DRY_RUN = 'true';
process.env.WEBHOOK_TOKEN = 'hook-secret';
process.env.NEWS_ENABLED = 'false';
process.env.DASHBOARD_PASSWORD = '';

const { config } = await import('../src/config.js');
const { createServer, isLoopback } = await import('../src/server.js');

let server: Server;
let port: number;

before(async () => {
  await new Promise<void>((ready) => {
    server = createServer().listen(0, '127.0.0.1', () => ready());
  });
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

const call = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', ...init });
const basic = (pw: string) => ({ Authorization: `Basic ${Buffer.from(`me:${pw}`).toString('base64')}` });

test('a same-origin dashboard request is allowed', async () => {
  const res = await call('/api/queue/clear', { headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.equal(res.status, 200);
});

test('a cross-origin POST is refused before it can print or clear anything', async () => {
  for (const path of ['/api/print', '/api/queue/clear', '/api/test']) {
    const res = await call(path, { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403, path);
  }
  const res = await call('/api/queue/clear', { headers: { Origin: 'null' } });
  assert.equal(res.status, 403);
});

test('a rebound hostname is refused when there is no password', async () => {
  const res = await new Promise<number>(async (done) => {
    const { request } = await import('node:http');
    request({ port, path: '/api/status', headers: { Host: 'rebind.evil.example' } }, (r) => done(r.statusCode!)).end();
  });
  assert.equal(res, 403);
});

test('the webhook still requires its token', async () => {
  assert.equal((await call('/api/hooks/print')).status, 401);
  assert.equal((await call('/api/hooks/print?what=nope&token=wrong')).status, 401);
});

test('malformed JSON gets a clean 400 with no stack trace', async () => {
  const res = await call('/api/print', { headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
  assert.doesNotMatch(await res.text(), /node_modules|\n\s+at /);
});

test('with a password set, everything but the webhook needs it', async () => {
  config.server.password = 'pw';
  try {
    const anon = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get('www-authenticate') ?? '', /^Basic/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`, { headers: basic('wrong') })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`, { headers: basic('pw') })).status, 200);
    // Wrong token, but it got past the password to the webhook's own check.
    const hook = await call('/api/hooks/print');
    assert.equal((await hook.json() as { error: string }).error, 'bad token');
  } finally {
    config.server.password = '';
  }
});

test('isLoopback only accepts addresses that stay on this machine', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1']) assert.equal(isLoopback(h), true, h);
  for (const h of ['0.0.0.0', '::', '192.168.1.5']) assert.equal(isLoopback(h), false, h);
});
