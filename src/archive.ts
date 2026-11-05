// A rolling archive of what actually printed.
//
// data/last-receipt.bin only ever holds the most recent dry-run buffer, which
// can't answer "what did it print on Tuesday?". Here every receipt is rendered
// through the same preview pipeline the dashboard uses and kept as a PNG with a
// little metadata, capped at config.archive.keep.
import { copyFile, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from './config.js';
import { receiptImage } from './bitmap.js';
import type { Block } from './digest.js';

export interface ArchiveEntry {
  id: string;
  label: string;
  /** ISO timestamp of the print. */
  at: string;
  /** PNG filename within the archive directory. */
  file: string;
  /** Whether this went to paper or was held/dry-run. */
  printed: boolean;
}

const indexPath = () => join(config.archive.dir, 'index.json');

export async function listArchive(): Promise<ArchiveEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(indexPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Absolute path to an archived PNG, or null if the id isn't in the index.
 * Resolving through the index (rather than joining the id into a path) is what
 * keeps a crafted id from reaching outside the archive directory.
 */
export async function archiveFile(id: string): Promise<string | null> {
  const entry = (await listArchive()).find((e) => e.id === id);
  return entry ? resolve(config.archive.dir, entry.file) : null;
}

let seq = 0;

/**
 * Render and store a receipt. Best-effort by design: this runs after the paper
 * is already out, so a Pillow failure here must never look like a print failure.
 */
export async function archiveReceipt(label: string, blocks: Block[], printed: boolean): Promise<ArchiveEntry | null> {
  if (!config.archive.enabled) return null;
  try {
    const at = new Date();
    const id = `${at.toISOString().replace(/[:.]/g, '-')}-${(seq++).toString(36)}`;
    const file = `${id}.png`;

    await mkdir(config.archive.dir, { recursive: true });
    const rendered = await receiptImage(blocks, config.printer.width);
    // receiptImage returns a path in the shared bitmap cache (tmp, and shared by
    // identical receipts) — copy it so the archive owns its own file.
    await copyFile(rendered, join(config.archive.dir, file));

    const entries = await listArchive();
    entries.push({ id, label, at: at.toISOString(), file, printed });

    // Trim the oldest past the cap, deleting their PNGs too.
    const excess = entries.length - config.archive.keep;
    const dropped = excess > 0 ? entries.splice(0, excess) : [];
    await writeFile(indexPath(), JSON.stringify(entries, null, 2));
    for (const d of dropped) {
      await rm(join(config.archive.dir, d.file), { force: true });
    }
    return entries[entries.length - 1];
  } catch (e) {
    console.error('[archive] failed to store receipt:', (e as Error)?.message ?? e);
    return null;
  }
}
