import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDownAlert, type VsAlert } from '../src/visualSentinel.js';

const alert = (message: string, status?: string): VsAlert => ({
  id: '1', message, state: 'OPEN', severity: 'CRITICAL', monitor: status ? { status } : undefined,
});

for (const message of [
  'Load balancer is down',
  'SSL proxy went offline',
  'Memory cache server is unreachable',
  'Certificate service not responding',
  'api.example.com is down',
  'Connection timed out',
]) {
  test(`an outage: ${message}`, () => assert.equal(isDownAlert(alert(message)), true));
}

for (const message of [
  'High load on server',
  'CPU usage at 95%',
  'Memory usage high',
  'SSL certificate expiring in 7 days',
  'Response time is down 20%',
  'Load is down to 0.5',
  'Response time timeout threshold exceeded',
  'UI changed on homepage',
]) {
  test(`not an outage: ${message}`, () => assert.equal(isDownAlert(alert(message)), false));
}

test('monitor status decides before the text does', () => {
  assert.equal(isDownAlert(alert('High load', 'DOWN')), true);
  assert.equal(isDownAlert(alert('site is down', 'UI_CHANGED')), false);
});
