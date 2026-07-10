import { config } from '../config.js';
import type { Source, NotificationItem } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SHOWN = 3;

export const githubSource: Source = {
  name: 'github',
  enabled: config.sources.github.enabled,
  async fetch(): Promise<NotificationItem[]> {
    const res = await fetch('https://api.github.com/notifications', {
      headers: {
        Authorization: `Bearer ${config.sources.github.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'print-notify',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const notifications = (await res.json()) as any[];

    const now = Date.now();
    // Only pull-request notifications updated within the last 24h — nothing else.
    const recentPrs = notifications
      .filter((n) => n.subject?.type === 'PullRequest')
      .filter((n) => now - new Date(n.updated_at).getTime() <= DAY_MS)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    const items: NotificationItem[] = recentPrs.slice(0, MAX_SHOWN).map((n) => ({
      id: `github:${n.id}:${n.updated_at}`,
      source: 'github',
      title: n.repository.full_name,
      detail: `${n.subject.title}  (${n.reason.replace(/_/g, ' ')})`,
      severity: 'notice',
      url: n.subject.url,
      timestamp: new Date(n.updated_at).getTime(),
    }));

    // Note how many recent PRs were not shown.
    const extra = recentPrs.length - items.length;
    if (extra > 0) {
      items.push({
        id: `github:more:${new Date().toISOString().slice(0, 13)}`,
        source: 'github',
        title: `+ ${extra} more PR${extra === 1 ? '' : 's'} in the last 24h`,
        severity: 'info',
        timestamp: now,
      });
    }
    return items;
  },
};
