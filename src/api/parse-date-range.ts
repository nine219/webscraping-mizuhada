const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DateRange { days?: number; from?: string; to?: string }

/**
 * Shared query-param parsing for every platform route's date filter.
 * `from`/`to` (YYYY-MM-DD) win when both are present and valid; otherwise
 * falls back to an explicit `days`, clamped 1..365; otherwise `fallbackDays`.
 * `fallbackDays = 0` means "no filter unless the caller asks for one" (matches
 * routes like /spikes that previously showed all-time by default) — returns
 * `{}`, which `WhereBuilder.dateRange()` treats as a no-op. Feed the result
 * straight into `WhereBuilder.dateRange()`.
 */
export function parseDateRange(
  query: Record<string, string | undefined>,
  fallbackDays = 7,
): DateRange {
  const from = query.from && DATE_RE.test(query.from) ? query.from : undefined;
  const to   = query.to   && DATE_RE.test(query.to)   ? query.to   : undefined;
  if (from && to) return { from, to };

  const parsed = parseInt(query.days ?? '', 10);
  if (Number.isFinite(parsed) && parsed > 0) return { days: Math.max(1, Math.min(365, parsed)) };
  return fallbackDays > 0 ? { days: fallbackDays } : {};
}

/** Short label for insight text / logs, e.g. "last 30 days" or "Jul 1–Jul 14". */
export function describeRange(range: DateRange): string {
  if (range.from && range.to) return `${range.from} to ${range.to}`;
  return `last ${range.days ?? 0} days`;
}

/**
 * Resolves a DateRange into concrete [from, to] Date boundaries, plus an
 * equal-length immediately-preceding "prior" window — for KPIs that compare
 * the selected period against the one before it (e.g. Command Center's
 * mentions delta). A `days`-only range prior-shifts by the same day count; a
 * custom from/to range prior-shifts by its exact length.
 */
export function resolveWindowWithPrior(range: DateRange): {
  from: Date; to: Date; priorFrom: Date; priorTo: Date;
} {
  let from: Date, to: Date;
  if (range.from && range.to) {
    from = new Date(`${range.from}T00:00:00.000Z`);
    to = new Date(`${range.to}T23:59:59.999Z`);
  } else {
    const days = range.days ?? 30;
    to = new Date();
    from = new Date(to.getTime() - days * 86_400_000);
  }
  const lengthMs = to.getTime() - from.getTime();
  return { from, to, priorFrom: new Date(from.getTime() - lengthMs), priorTo: new Date(from.getTime()) };
}
