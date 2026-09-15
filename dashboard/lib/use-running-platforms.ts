'use client';

import { useEffect, useState } from 'react';
import { fetchScrapeJobs } from './api';

// Every platform's manual triggers (feed scrape, UGC search, campaign
// reply/quote scrape, ...) share ONE persistent Chrome profile per platform
// (see src/scrapers/*/[platform]-browser.ts's pg_advisory_lock). Launching a
// second one while the first is still running doesn't crash — the lock just
// makes it wait, silently, with no indication in the UI of what it's
// actually waiting on (confirmed live: triggering XHS feed + XHS search back
// to back leaves both jobs sitting at "Starting..." with no signal one is
// blocked on the other). Job platform strings are "<family>" or
// "<family>-<subtype>" (e.g. "xhs-search", "twitter-campaign") — the family
// prefix is exactly the browser-profile-sharing boundary.
export function platformFamily(platform: string): string {
  return platform.split('-')[0];
}

const POLL_MS = 4_000;

/** Families (tiktok/instagram/xhs/twitter) with at least one 'running' job right now. */
export function useRunningPlatformFamilies(): Set<string> {
  const [running, setRunning] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const jobs = await fetchScrapeJobs();
        if (cancelled) return;
        setRunning(new Set(jobs.filter((j) => j.status === 'running').map((j) => platformFamily(j.platform))));
      } catch {
        // Transient fetch failure — keep the last known state rather than
        // flashing every trigger button enabled/disabled on a blip.
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return running;
}
