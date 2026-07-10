import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { ThermalPrinter, PrinterTypes, CharacterSet } from 'node-thermal-printer';
import { config } from './config.js';

export type ThermalDevice = InstanceType<typeof ThermalPrinter>;
export type PrinterBuilder = (p: ThermalDevice) => void | Promise<void>;

/**
 * Create an in-memory ESC/POS builder. We never call `.execute()` on it — the
 * interface is a no-op path; we read the accumulated bytes with `.getBuffer()`
 * and send them to CUPS ourselves. This avoids native printer bindings.
 */
export function createPrinter(): ThermalDevice {
  return new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: '/dev/null',
    characterSet: CharacterSet.PC437_USA,
    width: config.printer.width,
    removeSpecialCharacters: false,
  });
}

/** Send raw ESC/POS bytes to the printer via the CUPS raw queue (no sudo needed). */
export async function printBuffer(buffer: Buffer): Promise<void> {
  if (config.printer.dryRun) {
    await writeFile('data/last-receipt.bin', buffer);
    console.log(`[printer] DRY RUN — ${buffer.length} bytes written to data/last-receipt.bin`);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const lp = spawn('lp', ['-d', config.printer.queue, '-o', 'raw']);
    let stderr = '';
    lp.stderr.on('data', (d) => (stderr += d.toString()));
    lp.on('error', reject);
    lp.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`lp exited ${code}: ${stderr.trim()}`)),
    );
    lp.stdin.write(buffer);
    lp.stdin.end();
  });
}

/** Build a receipt with the ESC/POS DSL, then feed + cut and print it. */
export async function printDocument(build: PrinterBuilder): Promise<void> {
  const p = createPrinter();
  await build(p);
  p.newLine();
  p.newLine();
  p.cut();
  await printBuffer(p.getBuffer());
}
