// Ferrix logo header. Prints the real branding bitmap (mascot + wordmark) via
// ESC/POS raster on the TM-T88VI, instead of ASCII art.
//
// Print asset: branding/ferrix-logo-print.png (1-bit, 384px wide — regenerate
// with scripts/gen-logo.py if the source logo changes).
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { ThermalDevice } from './printer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LOGO_PRINT_PATH = resolve(HERE, '../branding/ferrix-logo-print.png');

/** Print the Ferrix logo bitmap, centered, as the receipt header. */
export async function printLogo(p: ThermalDevice): Promise<void> {
  p.alignCenter();
  await p.printImage(LOGO_PRINT_PATH);
  p.alignLeft();
}

/** Browser-visible logo for the web preview (served from /logo.png). */
export function logoPreviewHtml(): string {
  return '<img src="/logo.png" alt="Ferrix Systems" style="max-width:260px;display:block;margin:0 auto 8px">';
}
