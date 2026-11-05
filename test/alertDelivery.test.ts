import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchResult } from '../src/sources/types.js';
import type { NwsAlert } from '../src/nws.js';
import type { VsAlert } from '../src/visualSentinel.js';

// Isolate from the real state files and .env before anything reads config.
process.chdir(mkdtempSync(join(tmpdir(), 'print-notify-alerts-')));
process.env.PRINTER_DRY_RUN = 'true';
process.env.VS_API_KEY = 'test';
process.env.NEWS_ENABLED = 'false';

const { runPoll } = await import('../src/scheduler.js');
const { runSentinel } = await import('../src/sentinel.js');
const { runWeatherAlerts } = await import('../src/weatherAlerts.js');

const quiet = console.error;
beforeEach(() => {
  rmSync('data', { recursive: true, force: true });
  console.error = () => {};
});
test.after(() => { console.error = quiet; });

const boom = async () => { throw new Error('render failed'); };

test('poll: a failed print is retried, then never repeated once it succeeds', async () => {
  const urgent: FetchResult = {
    errors: [],
    items: [{ id: 'poll-1', source: 'certs', title: 'x', severity: 'urgent', timestamp: 0 }],
  };
  const fetchItems = async () => urgent;
  await assert.rejects(runPoll(fetchItems, boom));

  let prints = 0;
  const ok = async () => { prints++; return { printed: true }; };
  assert.equal(await runPoll(fetchItems, ok), 1);
  assert.equal(await runPoll(fetchItems, ok), 0);
  assert.equal(prints, 1);
});

test('poll: overlapping runs print an alert once', async () => {
  const fetchItems = async (): Promise<FetchResult> => ({
    errors: [],
    items: [{ id: 'poll-2', source: 'certs', title: 'x', severity: 'urgent', timestamp: 0 }],
  });
  let prints = 0;
  const ok = async () => { prints++; return { printed: true }; };
  await Promise.all([runPoll(fetchItems, ok), runPoll(fetchItems, ok)]);
  assert.equal(prints, 1);
});

test('sentinel: an outage survives a failed print and alerts exactly once', async () => {
  const down: VsAlert = { id: 'a1', subject: 'api is down', message: '', state: 'OPEN', severity: 'CRITICAL' };
  await runSentinel(async () => [], boom); // first run baselines an empty world

  await runSentinel(async () => [down], boom);
  let printed = 0;
  const ok = async (alerts: VsAlert[]) => { printed += alerts.length; };
  await runSentinel(async () => [down], ok);
  await runSentinel(async () => [down], ok);
  assert.equal(printed, 1);
});

test('weather: a warning survives a failed print and alerts exactly once', async () => {
  const alert = {
    id: 'w1', event: 'Tornado Warning', severity: 'Extreme', urgency: 'Immediate', certainty: 'Observed',
    status: 'Actual', messageType: 'Alert', areas: [], same: [], references: [],
  } as NwsAlert;
  await runWeatherAlerts(async () => [], boom); // first run baselines an empty world

  await runWeatherAlerts(async () => [alert], boom);
  let printed = 0;
  const ok = async (events: unknown[]) => { printed += events.length; };
  await runWeatherAlerts(async () => [alert], ok);
  await runWeatherAlerts(async () => [alert], ok);
  assert.equal(printed, 1);
});
