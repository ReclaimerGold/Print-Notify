export type Severity = 'info' | 'notice' | 'urgent';

/** A single normalized notification, regardless of which API it came from. */
export interface NotificationItem {
  /** Stable, unique id used to dedupe across polls (e.g. `github:12345`). */
  id: string;
  /** Source adapter name, e.g. "weather" | "github" | "calendar". */
  source: string;
  title: string;
  detail?: string;
  severity: Severity;
  url?: string;
  /** Optional bitmap (absolute path) printed above the item's text, e.g. a weather icon. */
  image?: string;
  /** Optional marker glyph drawn in a styled list row (e.g. a GitHub reason icon). */
  icon?: string;
  /** If set, the item renders as a pen-checkable task box ([ ] / [x]). */
  checked?: boolean;
  /** Due date as 'YYYY-MM-DD' (Google Tasks is date-only). Drives sort + overdue. */
  due?: string;
  /** Estimated price in USD, set by the grocery price estimator for grocery items. */
  price?: number;
  /** ms since epoch. */
  timestamp: number;
}

/** An adapter that knows how to pull items from one external API. */
export interface Source {
  name: string;
  enabled: boolean;
  fetch(): Promise<NotificationItem[]>;
}

export interface FetchResult {
  items: NotificationItem[];
  errors: { source: string; message: string }[];
}
