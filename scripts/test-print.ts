/**
 * Prints a formatted test receipt from Node (proves the app -> CUPS -> printer
 * path works). Run with: npm run test-print
 */
import { config } from '../src/config.js';
import { printDocument } from '../src/printer.js';
import { printLogo } from '../src/logo.js';

await printDocument(async (p) => {
  await printLogo(p);
  p.drawLine();
  p.println('Node -> CUPS -> TM-T88VI OK');
  p.println(new Date().toLocaleString('en-US', { timeZone: config.timezone }));
  p.alignLeft();
  p.newLine();
  p.println('Sample digest line formatting:');
  p.println('!! urgent item');
  p.println(' * notice item');
  p.println('   info item');
});

console.log('Test receipt sent to queue:', config.printer.queue);
