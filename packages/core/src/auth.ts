import type { ChatGPTSession } from './types.js';

export type { ChatGPTSession };

const DEFAULT_API_BASE = 'https://chatgpt.com/backend-api';
const KNOWN_HOSTS = ['chatgpt.com', 'chat.openai.com'];

/**
 * In the browser, call the backend on the SAME origin the user is on — hitting
 * chatgpt.com from a chat.openai.com page is a cross-origin request the session
 * cookie/CORS won't allow. In Node (CLI) there's no location, so use the default.
 */
export function getApiBase(): string {
  const origin =
    typeof location !== 'undefined' && location?.origin ? location.origin : '';
  if (origin && KNOWN_HOSTS.some((host) => origin.endsWith(host))) {
    return `${origin}/backend-api`;
  }
  return DEFAULT_API_BASE;
}

export function createHeaders(session: ChatGPTSession): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.accessToken}`,
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
  if (session.accountId) {
    headers['chatgpt-account-id'] = session.accountId;
  }
  return headers;
}

export async function fetchSessionFromPage(): Promise<ChatGPTSession> {
  const response = await fetch('/api/auth/session', { credentials: 'include' });
  if (!response.ok) {
    throw new Error('Not logged in to ChatGPT. Open chatgpt.com and sign in first.');
  }
  const data = await response.json();
  if (!data.accessToken) {
    throw new Error('No access token in session. Refresh chatgpt.com and try again.');
  }

  const accountId = getAccountIdFromCookie();
  return {
    accessToken: data.accessToken,
    accountId: accountId ?? data.account?.id,
    userId: data.user?.id,
    email: data.user?.email,
  };
}

export function getAccountIdFromCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(/(?:^|;\s*)_account=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export function decodeUserIdFromToken(token: string): string | undefined {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return (
      payload?.['https://api.openai.com/auth']?.chatgpt_user_id ??
      payload?.chatgpt_user_id ??
      payload?.sub
    );
  } catch {
    return undefined;
  }
}

export interface RateLimitInfo {
  waitMs: number;
  attempt: number;
}

let rateLimitNotifier: ((info: RateLimitInfo) => void) | null = null;

/** Register a callback invoked each time a request is delayed by a 429. */
export function setRateLimitNotifier(fn: ((info: RateLimitInfo) => void) | null): void {
  rateLimitNotifier = fn;
}

/** Milliseconds to wait after a 429 — honors Retry-After, else backs off. */
export function rateLimitWaitMs(retryAfterHeader: string | null, attempt: number): number {
  const retryAfter = parseInt(retryAfterHeader || '', 10);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return (30 + attempt * 15) * 1000;
}

export function isRateLimitError(err: unknown): boolean {
  return Boolean((err as { rateLimited?: boolean } | null | undefined)?.rateLimited);
}

// After this many consecutive 429s on one request, give up and surface a tagged
// error so the caller can stop hammering instead of grinding through retries.
const MAX_RATE_LIMIT_ATTEMPTS = 3;

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 5,
): Promise<Response> {
  let rateLimitAttempts = 0;

  for (let attempt = 0; attempt < retries; attempt++) {
    const response = await fetch(url, options);

    if (response.status === 401 || response.status === 403) {
      const error = new Error(
        `Authentication failed (${response.status}). Refresh ChatGPT and try again.`,
      );
      (error as Error & { authError?: boolean }).authError = true;
      throw error;
    }

    if (response.status === 429) {
      rateLimitAttempts++;
      if (rateLimitAttempts > MAX_RATE_LIMIT_ATTEMPTS) {
        const error = new Error('ChatGPT is rate-limiting requests (HTTP 429).');
        (error as Error & { rateLimited?: boolean }).rateLimited = true;
        throw error;
      }
      const waitMs = rateLimitWaitMs(response.headers.get('retry-after'), rateLimitAttempts);
      rateLimitNotifier?.({ waitMs, attempt: rateLimitAttempts });
      await sleep(waitMs);
      attempt--; // don't let 429 waits consume the general (non-429) retry budget
      continue;
    }

    if (!response.ok) {
      if (response.status === 404) {
        const error = new Error(`Not found: ${url}`);
        (error as Error & { noRetry?: boolean }).noRetry = true;
        throw error;
      }
      if (attempt === retries - 1) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      await sleep(2000 * (attempt + 1));
      continue;
    }

    return response;
  }

  throw new Error('Request failed after maximum retries');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Throttle {
  private lastRequest = 0;

  constructor(private ms: number) {}

  async wait(): Promise<void> {
    if (this.ms <= 0) return;
    const elapsed = Date.now() - this.lastRequest;
    const remaining = this.ms - elapsed;
    if (remaining > 0) await sleep(remaining);
    this.lastRequest = Date.now();
  }

  /** Current spacing between requests, in ms. Grows via onRateLimit(). */
  get intervalMs(): number {
    return this.ms;
  }

  onRateLimit(): void {
    this.ms = Math.min(this.ms + 2000, 120_000);
  }
}
