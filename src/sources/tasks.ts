import { config } from '../config.js';
import { listTaskLists, listTasks } from '../googleTasks.js';
import type { Source, NotificationItem } from './types.js';

/**
 * Google Tasks. Pulls the configured lists (e.g. "Tasks" and "Groceries") and
 * emits each as its own digest section of pen-checkable items. Each list's items
 * keep their manual order (a stable sort preserves it through the digest).
 */
export const tasksSource: Source = {
  name: 'google-tasks',
  enabled: config.sources.googleTasks.enabled,
  async fetch(): Promise<NotificationItem[]> {
    const wanted = config.sources.googleTasks.lists; // lowercased titles, or [] = all
    const lists = await listTaskLists();
    const selected = wanted.length
      ? lists.filter((l) => wanted.includes(l.title.toLowerCase()))
      : lists;

    const now = Date.now();
    const items: NotificationItem[] = [];
    for (const list of selected) {
      const tasks = await listTasks(list.id, config.sources.googleTasks.showCompleted);
      for (const t of tasks) {
        items.push({
          id: `task:${list.id}:${t.id}`,
          source: list.title, // section header = the list's own name (TASKS / GROCERIES)
          title: t.title.trim(),
          checked: t.status === 'completed',
          due: t.due ? t.due.slice(0, 10) : undefined, // RFC3339 -> 'YYYY-MM-DD'
          severity: 'info',
          timestamp: now,
        });
      }
    }
    return items;
  },
};
