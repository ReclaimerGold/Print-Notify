import { config } from './config.js';
import { createServer, isLoopback } from './server.js';
import { startScheduler } from './scheduler.js';
import { sources } from './sources/index.js';

const { host, port, password } = config.server;
if (!isLoopback(host) && !password) {
  console.error(
    `Refusing to listen on ${host} without DASHBOARD_PASSWORD: anyone who can reach ` +
    'this port could print, clear the queue, and read your calendar and tasks.',
  );
  process.exit(1);
}

const app = createServer();

app.listen(port, host, () => {
  const enabled = sources.filter((s) => s.enabled).map((s) => s.name);
  console.log(`\nPrint-Notify running: http://${host}:${port}`);
  console.log(`Printer queue: ${config.printer.queue}${config.printer.dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`Enabled sources: ${enabled.length ? enabled.join(', ') : '(none — set keys in .env)'}\n`);
  startScheduler();
});
