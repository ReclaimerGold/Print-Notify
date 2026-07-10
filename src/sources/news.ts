import { config } from '../config.js';
import type { Source, NotificationItem } from './types.js';

/** Decode the handful of XML entities that appear in RSS titles. */
function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return undefined;
  return decode(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
}

/**
 * Local headlines via Google News RSS search (no API key). Google News titles
 * come formatted as "Headline - Source"; we split that into title + source.
 */
export const newsSource: Source = {
  name: 'news',
  enabled: config.sources.news.enabled,
  async fetch(): Promise<NotificationItem[]> {
    const q = encodeURIComponent(`${config.sources.news.query} when:2d`);
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, { headers: { 'User-Agent': 'print-notify' } });
    if (!res.ok) throw new Error(`Google News ${res.status}`);
    const xml = await res.text();

    const items: NotificationItem[] = [];
    const blocks = xml.split(/<item>/).slice(1);
    for (const block of blocks) {
      const rawTitle = tag(block, 'title');
      if (!rawTitle) continue;
      const link = tag(block, 'link');
      const pub = tag(block, 'pubDate');
      const ts = pub ? new Date(pub).getTime() : Date.now();

      // "Headline - Source" -> split on the last " - "
      const sep = rawTitle.lastIndexOf(' - ');
      const headline = sep > 0 ? rawTitle.slice(0, sep) : rawTitle;
      const outlet = sep > 0 ? rawTitle.slice(sep + 3) : (tag(block, 'source') ?? 'News');

      items.push({
        id: `news:${link ?? headline}`,
        source: 'news',
        title: headline,
        detail: outlet,
        severity: 'info',
        url: link,
        timestamp: ts,
      });
    }

    // Most recent first, capped to the configured limit.
    return items.sort((a, b) => b.timestamp - a.timestamp).slice(0, config.sources.news.limit);
  },
};
