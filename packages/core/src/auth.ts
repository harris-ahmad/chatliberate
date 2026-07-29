import type { ChatGPTSession } from './types.js';

export type { ChatGPTSession };

const API_BASE = 'https://chatgpt.com/backend-api';

export function getApiBase(): string {
  return API_BASE;
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

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 5,
): Promise<Response> {
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
      const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
      const waitMs = (retryAfter > 0 ? retryAfter : 30 + attempt * 15) * 1000;
      await sleep(waitMs);
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

  onRateLimit(): void {
    this.ms = Math.min(this.ms + 2000, 120_000);
  }
}
