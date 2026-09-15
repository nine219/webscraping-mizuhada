import { socialQuery } from '../db/social-client';

// Logs every LLM call (sentiment/translate/theme/relevance/captcha) to
// ai_usage_log. Powers the Admin > AI usage card (src/api/routes/admin.ts).

export type AiPurpose = 'sentiment' | 'translate' | 'post-theme' | 'brand-relevance' | 'captcha-vision';

export interface AiUsageEntry {
  provider: string; // 'gemini' | 'deepseek' | 'openrouter'
  model: string;
  purpose: AiPurpose;
  tokensIn: number | null;
  tokensOut: number | null;
  success: boolean;
  errorMessage?: string | null;
}

// Approximate public list prices in USD per 1M tokens. These drift as providers
// reprice — treat as ballpark cost tracking, not billing-accurate.
const PRICING_PER_1M: Record<string, { in: number; out: number }> = {
  'gemini-3.1-flash-lite': { in: 0.10, out: 0.40 },
  'deepseek-chat':         { in: 0.28, out: 0.42 },
  'qwen/qwen-plus':        { in: 0.40, out: 1.20 },
  'qwen/qwen-2.5-vl-72b-instruct': { in: 0.40, out: 1.20 },
};

// Shared date-range filter for every query below — mirrors the Today/7D/14D/30D/
// All-time/Custom-range picker on Admin > AI usage, plus a single exact `date`
// for the daily-cost bar chart's click-to-drill-down.
export interface AiUsageDateFilter {
  days?: number; from?: string; to?: string; date?: string;
  /** Admin request log filters — action type and failed-only. Only meaningful
   * for getRecentAiUsage/getAiUsageLogCount; other callers (summary/totals/
   * by_purpose/by_model/daily) don't pass these. */
  purpose?: string;
  failedOnly?: boolean;
}

function dateFilterSql(f: AiUsageDateFilter, startIdx = 1): { sql: string; params: unknown[] } {
  let sql: string;
  let params: unknown[];
  if (f.date) { sql = `created_at::date = $${startIdx}::date`; params = [f.date]; }
  else if (f.from && f.to) { sql = `created_at >= $${startIdx}::date AND created_at < $${startIdx + 1}::date + INTERVAL '1 day'`; params = [f.from, f.to]; }
  else if (f.days && f.days > 0) { sql = `created_at >= NOW() - ($${startIdx} || ' days')::interval`; params = [f.days]; }
  else { sql = 'TRUE'; params = []; } // all time

  if (f.purpose) { sql += ` AND purpose = $${startIdx + params.length}`; params = [...params, f.purpose]; }
  if (f.failedOnly) { sql += ` AND success = false`; }
  return { sql, params };
}

function estimateCostUsd(model: string, tokensIn: number | null, tokensOut: number | null): number | null {
  const price = PRICING_PER_1M[model];
  if (!price || tokensIn == null || tokensOut == null) return null;
  return (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out;
}

export async function logAiUsage(entry: AiUsageEntry): Promise<void> {
  const costUsd = estimateCostUsd(entry.model, entry.tokensIn, entry.tokensOut);
  try {
    await socialQuery(
      `INSERT INTO ai_usage_log (provider, model, purpose, tokens_in, tokens_out, cost_usd, success, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [entry.provider, entry.model, entry.purpose, entry.tokensIn, entry.tokensOut, costUsd, entry.success, entry.errorMessage ?? null],
    );
  } catch (err) {
    console.error('[ai-usage] failed to log usage:', err);
  }
}

export interface AiUsageSummaryRow {
  provider: string;
  calls: number;
  failures: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export interface AiUsageRecentRow {
  id: number;
  provider: string;
  model: string;
  purpose: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  success: boolean;
  error_message: string | null;
  created_at: string;
}

export async function getAiUsageSummary(filter: AiUsageDateFilter = { days: 30 }): Promise<AiUsageSummaryRow[]> {
  const { sql, params } = dateFilterSql(filter);
  return socialQuery<AiUsageSummaryRow>(
    `SELECT provider,
            COUNT(*)::int                                  AS calls,
            COUNT(*) FILTER (WHERE NOT success)::int        AS failures,
            COALESCE(SUM(tokens_in), 0)::int                AS tokens_in,
            COALESCE(SUM(tokens_out), 0)::int                AS tokens_out,
            COALESCE(SUM(cost_usd), 0)::float                AS cost_usd
     FROM ai_usage_log
     WHERE ${sql}
     GROUP BY provider
     ORDER BY calls DESC`,
    params,
  );
}

export interface AiUsageTotals {
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export async function getAiUsageTotals(filter: AiUsageDateFilter = { days: 30 }): Promise<AiUsageTotals> {
  const { sql, params } = dateFilterSql(filter);
  const row = await socialQuery<AiUsageTotals>(
    `SELECT COUNT(*)::int                  AS calls,
            COALESCE(SUM(tokens_in), 0)::int  AS tokens_in,
            COALESCE(SUM(tokens_out), 0)::int AS tokens_out,
            COALESCE(SUM(cost_usd), 0)::float AS cost_usd
     FROM ai_usage_log
     WHERE ${sql}`,
    params,
  );
  return row[0] ?? { calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 };
}

export interface AiUsageGroupRow {
  key: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export async function getAiUsageByPurpose(filter: AiUsageDateFilter = { days: 30 }): Promise<AiUsageGroupRow[]> {
  const { sql, params } = dateFilterSql(filter);
  return socialQuery<AiUsageGroupRow>(
    `SELECT purpose AS key,
            COUNT(*)::int                     AS calls,
            COALESCE(SUM(tokens_in), 0)::int  AS tokens_in,
            COALESCE(SUM(tokens_out), 0)::int AS tokens_out,
            COALESCE(SUM(cost_usd), 0)::float AS cost_usd
     FROM ai_usage_log
     WHERE ${sql}
     GROUP BY purpose
     ORDER BY cost_usd DESC`,
    params,
  );
}

export async function getAiUsageByModel(filter: AiUsageDateFilter = { days: 30 }): Promise<AiUsageGroupRow[]> {
  const { sql, params } = dateFilterSql(filter);
  return socialQuery<AiUsageGroupRow>(
    `SELECT model AS key,
            COUNT(*)::int                     AS calls,
            COALESCE(SUM(tokens_in), 0)::int  AS tokens_in,
            COALESCE(SUM(tokens_out), 0)::int AS tokens_out,
            COALESCE(SUM(cost_usd), 0)::float AS cost_usd
     FROM ai_usage_log
     WHERE ${sql}
     GROUP BY model
     ORDER BY cost_usd DESC`,
    params,
  );
}

export interface AiUsageDailyRow {
  date: string;
  cost_usd: number;
  calls: number;
}

// Note: intentionally takes days/from/to only (no `date`) — this feeds the bar
// chart that the single-day drill-down is clicked FROM, so it always shows the
// full range regardless of which day is currently selected as a filter.
export async function getAiUsageDaily(filter: Pick<AiUsageDateFilter, 'days' | 'from' | 'to'> = { days: 30 }): Promise<AiUsageDailyRow[]> {
  const { sql, params } = dateFilterSql(filter);
  return socialQuery<AiUsageDailyRow>(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
            COALESCE(SUM(cost_usd), 0)::float AS cost_usd,
            COUNT(*)::int                     AS calls
     FROM ai_usage_log
     WHERE ${sql}
     GROUP BY 1
     ORDER BY 1 ASC`,
    params,
  );
}

export async function getRecentAiUsage(filter: AiUsageDateFilter = { days: 30 }, limit = 25, offset = 0): Promise<AiUsageRecentRow[]> {
  const { sql, params } = dateFilterSql(filter);
  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;
  return socialQuery<AiUsageRecentRow>(
    `SELECT id, provider, model, purpose, tokens_in, tokens_out, cost_usd::float AS cost_usd, success, error_message, created_at::text
     FROM ai_usage_log
     WHERE ${sql}
     ORDER BY created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...params, limit, offset],
  );
}

export async function getAiUsageLogCount(filter: AiUsageDateFilter = { days: 30 }): Promise<number> {
  const { sql, params } = dateFilterSql(filter);
  const rows = await socialQuery<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ai_usage_log WHERE ${sql}`, params);
  return parseInt(rows[0]?.count ?? '0', 10);
}
