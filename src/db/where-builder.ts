/**
 * Tiny accumulator for hand-built SQL WHERE clauses. Every route handler that
 * takes optional `brand`/`days`/etc query filters used to manage a
 * `conditions: string[]` + `params: unknown[]` + `let idx = 1; ...$${idx++}`
 * trio by hand — this replaces that bookkeeping so call sites just describe
 * each condition once.
 */
export class WhereBuilder {
  private conditions: string[];
  private params: unknown[] = [];

  constructor(initial: string[] = ['1=1']) {
    this.conditions = [...initial];
  }

  /** Adds `sql` (containing one `?` placeholder) + its bound value; `?` becomes the next `$N`. */
  add(sql: string, value: unknown): this {
    this.conditions.push(sql.replace('?', `$${this.params.length + 1}`));
    this.params.push(value);
    return this;
  }

  /** Same as add(), but only when `cond` is true — for optional filters. */
  addIf(cond: boolean, sql: string, value: unknown): this {
    return cond ? this.add(sql, value) : this;
  }

  /** Adds a condition with no bound value (e.g. a literal `col = true`). */
  addRaw(sql: string): this {
    this.conditions.push(sql);
    return this;
  }

  /**
   * Registers extra bound values with no matching single condition — for a
   * condition (added via addRaw, referencing `$${nextIndex}` etc. directly)
   * that reuses one placeholder multiple times or binds more than one value
   * at once. Call after addRaw, before reading `.values`.
   */
  pushValues(...values: unknown[]): this {
    this.params.push(...values);
    return this;
  }

  /**
   * Date-range filter shared by every platform route. `columnSql` is the raw
   * column/expression (e.g. `tp.posted_at` or `COALESCE(xp.published_at, xp.scraped_at)`).
   * `from`/`to` (YYYY-MM-DD, inclusive both ends) win when both are given —
   * `to` is treated as the whole day, not midnight. Otherwise falls back to
   * the legacy `days`-lookback window. No-ops if neither is given.
   */
  dateRange(columnSql: string, range: { days?: number; from?: string; to?: string }): this {
    if (range.from && range.to) {
      this.conditions.push(
        `${columnSql} >= $${this.params.length + 1}::date AND ${columnSql} < $${this.params.length + 2}::date + INTERVAL '1 day'`,
      );
      this.params.push(range.from, range.to);
      return this;
    }
    if (range.days) return this.add(`${columnSql} >= NOW() - INTERVAL '1 day' * ?`, range.days);
    return this;
  }

  get where(): string {
    return this.conditions.join(' AND ');
  }

  /** Params bound so far, in placeholder order — pass as the query's param array. */
  get values(): unknown[] {
    return this.params;
  }

  /** 1-based index of the next placeholder — for appending LIMIT/OFFSET etc. after the WHERE. */
  get nextIndex(): number {
    return this.params.length + 1;
  }
}
