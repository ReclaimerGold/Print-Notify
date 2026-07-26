import express from 'express';
import { config } from './config.js';
import { sources, fetchAll } from './sources/index.js';
import { buildDigestBlocks, printSection, sourceRank } from './digest.js';
import { receiptImage, checklistImage } from './bitmap.js';
import { buildChecklistSpec, printChecklist } from './checklist.js';
import { priceGroceries } from './prices/priceEstimator.js';
import { fetchWeatherData } from './sources/weather.js';
import { setTaskCompleted, insertTask, listTaskLists } from './googleTasks.js';
import { runDigest, runPoll, state } from './scheduler.js';
import { weatherAlertsStatus } from './weatherAlerts.js';
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
      weatherAlerts: weatherAlertsStatus(),
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

  // Structured data for the dashboard tiles: weather (JSON) + items grouped by
  // source. Weather gets its own field; every other source becomes one tile.
  app.get('/api/dashboard', async (_req, res) => {
    try {
      const errors: { source: string; message: string }[] = [];
      const [weather, all] = await Promise.all([
        config.sources.weather.enabled
          ? fetchWeatherData().catch((e) => {
              errors.push({ source: 'weather', message: String(e?.message ?? e) });
              return null;
            })
          : Promise.resolve(null),
        fetchAll(),
      ]);
      errors.push(...all.errors);

      // Annotate grocery items with estimated prices (best-effort — a geocode
      // or estimate failure just leaves them unpriced).
      let priceCity: string | undefined;
      try {
        const pricing = await priceGroceries(all.items);
        priceCity = pricing?.city || undefined;
      } catch {
        // pricing is optional; ignore failures
      }

      // Group non-weather items by source, preserving first-seen order.
      const groupMap = new Map<string, { price?: number }[]>();

      // Seed the configured Google Tasks lists first, so Tasks/Groceries always
      // render a tile (with their add-item box) even when the list is empty.
      const taskListTitles = new Set<string>();
      if (config.sources.googleTasks.enabled) {
        try {
          const wanted = config.sources.googleTasks.lists; // lowercased titles; [] = all
          const lists = await listTaskLists();
          const shown = wanted.length ? lists.filter((l) => wanted.includes(l.title.toLowerCase())) : lists;
          for (const l of shown) {
            taskListTitles.add(l.title);
            groupMap.set(l.title, []); // establishes order (task lists first) + empty tile
          }
        } catch {
          // best-effort: non-empty lists still appear via their items below
        }
      }

      for (const it of all.items) {
        if (it.source === 'weather') continue;
        const list = groupMap.get(it.source) ?? [];
        list.push({
          // `id` lets the dashboard target a task for two-way toggle (checkables only).
          id: it.checked !== undefined ? it.id : undefined,
          title: it.title, detail: it.detail, severity: it.severity,
          checked: it.checked, due: it.due, url: it.url, price: it.price,
        } as { price?: number });
        groupMap.set(it.source, list);
      }
      const groups = [...groupMap]
        .sort((a, b) => sourceRank(a[0]) - sourceRank(b[0]))
        .map(([source, items]) => {
        const priced = items.filter((i) => i.price !== undefined);
        const estTotal = priced.length
          ? Math.round(priced.reduce((s, i) => s + (i.price ?? 0), 0) * 100) / 100
          : undefined;
        // Task/grocery lists accept new items from the dashboard — even when empty.
        const addable = taskListTitles.has(source)
          || items.some((i) => (i as { checked?: boolean }).checked !== undefined);
        return {
          source, label: source.toUpperCase(), count: items.length, items, addable,
          estTotal, priceCity: estTotal !== undefined ? priceCity : undefined,
        };
      });

      res.json({ weather, groups, errors, timezone: config.timezone });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Virtual receipt: renders the exact digest layout (bitmaps + text) as a PNG.
  app.get('/api/receipt.png', async (_req, res) => {
    try {
      const { items, errors } = await fetchAll();
      const blocks = await buildDigestBlocks('Digest Preview', items, errors);
      const png = await receiptImage(blocks, config.printer.width);
      res.set('Cache-Control', 'no-store');
      res.sendFile(png);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Virtual pocket checklist (Tasks + Groceries) as a PNG.
  app.get('/api/checklist.png', async (_req, res) => {
    try {
      const png = await checklistImage(await buildChecklistSpec());
      res.set('Cache-Control', 'no-store');
      res.sendFile(png);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Print the pocket checklist now.
  app.post('/api/checklist', async (_req, res) => {
    try {
      const count = await printChecklist();
      res.json({ ok: true, count });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Two-way sync: toggle a Google Tasks item's completion from the dashboard.
  // `id` is the NotificationItem id `task:{listId}:{taskId}` (see sources/tasks.ts).
  app.post('/api/tasks/toggle', async (req, res) => {
    try {
      if (!config.sources.googleTasks.enabled) {
        return res.status(400).json({ ok: false, error: 'Google Tasks is not configured' });
      }
      const id = String(req.body?.id ?? '');
      const completed = Boolean(req.body?.completed);
      const m = /^task:([^:]+):(.+)$/.exec(id); // list ids have no colon; task id is the remainder
      if (!m) return res.status(400).json({ ok: false, error: 'invalid task id' });
      await setTaskCompleted(m[1], m[2], completed);
      return res.json({ ok: true, completed });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e) });
    }
  });

  // Add a new item to a Google Tasks list (Tasks / Groceries) from the dashboard.
  // `list` is the list *title* as shown on the tile (matched case-insensitively).
  app.post('/api/tasks/add', async (req, res) => {
    try {
      if (!config.sources.googleTasks.enabled) {
        return res.status(400).json({ ok: false, error: 'Google Tasks is not configured' });
      }
      const list = String(req.body?.list ?? '').trim();
      const title = String(req.body?.title ?? '').trim();
      if (!list || !title) return res.status(400).json({ ok: false, error: 'list and title required' });
      const match = (await listTaskLists()).find((l) => l.title.toLowerCase() === list.toLowerCase());
      if (!match) return res.status(404).json({ ok: false, error: `no task list named "${list}"` });
      const task = await insertTask(match.id, title);
      return res.json({ ok: true, id: `task:${match.id}:${task.id}` });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e) });
    }
  });

  // Quick-print one dashboard tile: just that source's items.
  app.post('/api/print/section', async (req, res) => {
    try {
      const source = String(req.body?.source ?? '').trim();
      if (!source) return res.status(400).json({ ok: false, error: 'source required' });
      const { items } = await fetchAll();
      const section = items.filter((i) => i.source === source);
      if (!section.length) return res.json({ ok: true, count: 0 });
      await printSection(source, section);
      return res.json({ ok: true, count: section.length });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
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
