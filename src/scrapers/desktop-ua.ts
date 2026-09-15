/**
 * Shared desktop user-agent for all Playwright scrapers.
 *
 * The scrapers historically hard-coded a Windows Chrome UA string. That is
 * fine on the Windows/macOS dev host, but inside the Linux Docker scraper
 * containers it creates a UA-vs-platform mismatch — the UA claims Windows while
 * `navigator.platform` = "Linux x86_64" and the `Sec-CH-UA-Platform` client
 * hint = "Linux". That inconsistency is itself a well-known bot signal.
 *
 * So on Linux we return `undefined`: Playwright then omits the override and
 * Chromium sends its own native, self-consistent Linux UA + client hints.
 * On Windows/macOS we keep the Windows UA (matches the host closely enough and
 * preserves the pre-Docker behavior). Fully spoofing a coherent Windows
 * identity on Linux (UA + navigator.platform + every Sec-CH-UA-* header +
 * userAgentData) is fragile and version-coupled; a self-consistent native UA
 * beats a half-spoofed Windows one.
 */
export const DESKTOP_UA: string | undefined =
  process.platform === 'linux'
    ? undefined
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
