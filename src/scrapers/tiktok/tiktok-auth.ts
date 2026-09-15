export interface TikTokCookies {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
}

// Returns a Cookie: header string for direct HTTP requests (Watsons-style).
// Priority: TIKTOK_COOKIE_HEADER (raw string) > TIKTOK_COOKIES (JSON) > TIKTOK_MS_TOKEN (minimal).
export function buildCookieHeader(): string {
  // Option 1: raw header string copied from DevTools (same as SHOPEE_COOKIE_HEADER pattern)
  const raw = process.env.TIKTOK_COOKIE_HEADER;
  if (raw && raw.trim()) return raw.trim();

  // Option 2: JSON array of cookie objects
  const json = process.env.TIKTOK_COOKIES;
  if (json) {
    try {
      const cookies = JSON.parse(json) as TikTokCookies[];
      return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch { /* fall through */ }
  }

  // Option 3: ms_token only (minimal — may not be enough for item_list API)
  const msToken = process.env.TIKTOK_MS_TOKEN;
  if (msToken) return `msToken=${msToken}`;

  return '';
}

// Kept for backwards-compat with any code that still uses Playwright cookie injection.
export function loadTikTokCookies(): TikTokCookies[] {
  const json = process.env.TIKTOK_COOKIES;
  if (json) {
    try { return JSON.parse(json) as TikTokCookies[]; } catch { /* fall through */ }
  }
  const msToken = process.env.TIKTOK_MS_TOKEN;
  if (msToken) {
    return [{ name: 'msToken', value: msToken, domain: '.tiktok.com', path: '/', httpOnly: false, secure: true }];
  }
  return [];
}

export function getProxyConfig(): { server: string; username?: string; password?: string } | undefined {
  const server = process.env.TIKTOK_PROXY;
  if (!server) return undefined;
  return {
    server,
    username: process.env.TIKTOK_PROXY_USER,
    password: process.env.TIKTOK_PROXY_PASS,
  };
}
