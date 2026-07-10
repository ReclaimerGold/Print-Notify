import { config } from './config.js';
import { createServer } from './server.js';
import { startScheduler } from './scheduler.js';
import { sources } from './sources/index.js';

const app = createServer();

app.listen(config.server.port, () => {
  const enabled = sources.filter((s) => s.enabled).map((s) => s.name);
  console.log(`\nPrint-Notify running: http://localhost:${config.server.port}`);
  console.log(`Printer queue: ${config.printer.queue}${config.printer.dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`Enabled sources: ${enabled.length ? enabled.join(', ') : '(none — set keys in .env)'}\n`);
  startScheduler();
});
