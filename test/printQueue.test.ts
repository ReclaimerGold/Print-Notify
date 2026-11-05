import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedReason, paperLow, healthFootnote } from '../src/printQueue.js';
import type { PrinterInfo } from '../src/printerInfo.js';

/** A healthy printer; each test overrides just the field it cares about. */
const healthy = (over: Partial<PrinterInfo> = {}): PrinterInfo => ({
  queue: 'PrintNotify',
  deviceUri: 'usb://EPSON/TM-T88VI',
  state: 'idle',
  enabled: true,
  accepting: true,
  stateSince: null,
  reasons: [],
  connected: true,
  recentJobs: [],
  note: '',
  ...over,
});

test('a healthy printer is not blocked', () => {
  assert.equal(blockedReason(healthy()), null);
  assert.equal(blockedReason(healthy({ state: 'processing' })), null);
});

test('physical faults block the job rather than letting CUPS swallow it', () => {
  // This is the whole point of the queue: `lp` exits 0 for every one of these.
  assert.equal(blockedReason(healthy({ reasons: ['media-empty'] })), 'out of paper');
  assert.equal(blockedReason(healthy({ reasons: ['cover-open'] })), 'cover open');
  assert.equal(blockedReason(healthy({ reasons: ['door-open'] })), 'cover open');
  assert.equal(blockedReason(healthy({ reasons: ['media-jam'] })), 'paper jam');
  assert.equal(blockedReason(healthy({ reasons: ['offline'] })), 'printer offline');
  assert.equal(blockedReason(healthy({ reasons: ['paused'] })), 'queue paused');
});

test('queue and connection state block too', () => {
  assert.equal(blockedReason(healthy({ connected: false })), 'printer not on the USB bus');
  assert.equal(blockedReason(healthy({ enabled: false })), 'queue disabled');
  assert.equal(blockedReason(healthy({ state: 'disabled' })), 'queue disabled');
  assert.equal(blockedReason(healthy({ accepting: false })), 'queue not accepting jobs');
});

test('paper low warns but never blocks — the receipt still fits', () => {
  const low = healthy({ reasons: ['media-low'] });
  assert.equal(blockedReason(low), null);
  assert.equal(paperLow(low), true);
  assert.match(healthFootnote(low)!, /paper low/);
});

test('a healthy printer prints no footnote', () => {
  assert.equal(healthFootnote(healthy()), undefined);
});

test('an unrecognised reason is not treated as fatal', () => {
  // CUPS emits plenty of informational reasons; only the known faults hold jobs.
  assert.equal(blockedReason(healthy({ reasons: ['com.epson.something-informational'] })), null);
});
