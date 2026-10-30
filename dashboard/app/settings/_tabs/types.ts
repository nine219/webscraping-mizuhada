// Types mirror src/config/settings-loader.ts

export interface KeywordsSettings {
  tiktok: Record<string, string[]>;
  tiktokCategory: string[];
  xhs: string[];
  twitter: Record<string, string[]>;
  competitorTiktok: Record<string, string[]>;
  ownHandlesTiktok: string[];
  ownHandlesTwitter: string[];
  ownInfluencers: string[];
}

export interface ScrapeLimit { maxScrolls: number; maxPosts: number }
export interface ScrapeLimits {
  tiktokFeed: ScrapeLimit;
  tiktokSearch: ScrapeLimit;
  instagramFeed: ScrapeLimit;
  twitterSearch: ScrapeLimit;
  twitterComments: ScrapeLimit;
  xhsFeed: ScrapeLimit;
  xhsSearch: ScrapeLimit;
}

export interface ThresholdSettings {
  commentMinViews: number;
  commentMinCount: number;
  minViewsForSpike: number;
  viralViewsThreshold: number;
  viralEngagementPct: number;
  minEngagementPct: number;
  xMinViewsForSpike: number;
  xViralViewsThreshold: number;
  xViralEngagementPct: number;
  xMinEngagementPct: number;
  negativeSpikePct: number;
  feedMaxAgeDays: number;
  commentGrowthDelta: number;
  scrapeLimits: ScrapeLimits;
}

export interface AlertSettings {
  lineToken: string;
  lineGroupId: string;
}

export interface ScheduleEntry { enabled: boolean; label: string; cron: string }

export interface ScheduleSettings {
  sentiment: ScheduleEntry;
  tiktokFeed: ScheduleEntry;
  tiktokSearch: ScheduleEntry;
  tiktokStatsRefresh: ScheduleEntry;
  instagram: ScheduleEntry;
  twitterSearch: ScheduleEntry;
  twitterComments: ScheduleEntry;
  twitterStatsRefresh: ScheduleEntry;
  campaignSync: ScheduleEntry;
  cleanup: ScheduleEntry;
  morningDigest: ScheduleEntry;
  weeklyDigest: ScheduleEntry;
  tiktokSpikeDigest: ScheduleEntry;
  negativeSpikeDigest: ScheduleEntry;
}

export interface AppSettings {
  keywords: KeywordsSettings;
  thresholds: ThresholdSettings;
  alerts: AlertSettings;
  schedules: ScheduleSettings;
}

export interface Brand {
  id: number;
  name: string;
  slug: string;
  type: 'own' | 'competitor';
  tiktok_handle: string | null;
  instagram_handle: string | null;
}

// keyword_terms platform values (mirrors src/api/routes/settings.ts KEYWORD_PLATFORMS)
export type KeywordPlatform = 'tiktok' | 'tiktok_category' | 'twitter' | 'xhs';
