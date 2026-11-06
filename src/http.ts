// fetch() has no default timeout, so one stalled server would hang a whole digest
// or poll. The signal covers reading the body as well as connecting.
const TIMEOUT_MS = 15_000;

export function timedFetch(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
