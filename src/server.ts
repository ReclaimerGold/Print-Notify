import express from 'express';
import { config } from './config.js';
import { sources, fetchAll } from './sources/index.js';
import { buildDigestBlocks } from './digest.js';
import { receiptImage } from './bitmap.js';
import { runDigest, runPoll, state } from './scheduler.js';
import { printDocument } from './printer.js';
import { printLogo } from './logo.js';
import { getPrinterInfo } from './printerInfo.js';

export function createServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static('public'));

  // System + schedule status for the dashboard.
  app.get('/api/status', (_req, res) => {
    res.json({
      printer: { queue: config.printer.queue, dryRun: config.printer.dryRun },
      schedule: config.schedule,
      timezone: config.timezone,
      sources: sources.map((s) => ({ name: s.name, enabled: s.enabled })),
      state,
    });
  });

  // Live printer/queue info for the dashboard.
  app.get('/api/printer', async (_req, res) => {
    try {
      res.json(await getPrinterInfo());
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Item counts + any source errors (drives the summary line under the preview).
  app.get('/api/preview', async (_req, res) => {
    try {
      const { items, errors } = await fetchAll();
      res.json({ count: items.length, errors, sources: [...new Set(items.map((i) => i.source))] });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Virtual receipt: renders the exact digest layout (bitmaps + text) as a PNG.
  app.get('/api/receipt.png', async (_req, res) => {
    try {
      const { items } = await fetchAll();
      const blocks = await buildDigestBlocks('Digest Preview', items);
      const png = await receiptImage(blocks, config.printer.width);
      res.set('Cache-Control', 'no-store');
      res.sendFile(png);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Print a full digest now.
  app.post('/api/print', async (_req, res) => {
    try {
      const count = await runDigest('Digest');
      res.json({ ok: true, count });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Force an urgent poll now.
  app.post('/api/poll', async (_req, res) => {
    try {
      const count = await runPoll();
      res.json({ ok: true, printed: count });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Print a hardware test receipt.
  app.post('/api/test', async (_req, res) => {
    try {
      await printDocument(async (p) => {
        await printLogo(p);
        p.drawLine();
        p.println('Test receipt from the web app');
        p.println(new Date().toLocaleString('en-US', { timeZone: config.timezone }));
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  return app;
}
