import { config } from '../config.js';
import type { Source, NotificationItem } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SHOWN = 3;

// Monochrome symbol glyph per GitHub notification reason, drawn in the styled
// receipt list row (see scripts/render_list.py, which per-glyph picks the first
// font that has it). Unknown reasons fall back to the plain bullet.
const REASON_ICON: Record<string, string> = {
  review_requested: '◉',   // eyes on you
  mention: '@',
  team_mention: '@',
  comment: '🗨',           // speech balloon
  assign: '⚑',            // flagged / assigned to you
  author: '✎',            // your PR
  ci_activity: '⚙',       // CI
  state_change: '●',      // opened / merged / closed
  security_alert: '⚠',
};

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
      icon: REASON_ICON[n.reason] ?? '▪',
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
        icon: '…',
        timestamp: now,
      });
    }
    return items;
  },
};
