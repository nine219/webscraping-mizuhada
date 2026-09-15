import { describe, it, expect } from 'vitest';
import { WhereBuilder } from '../src/db/where-builder';

// tiktok.ts, instagram.ts, xhs.ts, and command-center.ts all used to hand-roll a
// conditions[]/params[]/idx++ trio for optional query filters (37 occurrences
// across 6 route files). These tests cover the shared replacement directly.

describe('WhereBuilder', () => {
  it('defaults to a 1=1 no-op condition with no values', () => {
    const wb = new WhereBuilder();
    expect(wb.where).toBe('1=1');
    expect(wb.values).toEqual([]);
    expect(wb.nextIndex).toBe(1);
  });

  it('accepts a custom initial condition list', () => {
    const wb = new WhereBuilder(["tp.source_type = 'search'"]);
    expect(wb.where).toBe("tp.source_type = 'search'");
  });

  it('add() numbers placeholders in call order and joins with AND', () => {
    const wb = new WhereBuilder();
    wb.add('b.slug = ?', 'mizumi');
    wb.add('tp.posted_at >= ?', 30);
    expect(wb.where).toBe('1=1 AND b.slug = $1 AND tp.posted_at >= $2');
    expect(wb.values).toEqual(['mizumi', 30]);
  });

  it('replaces only the placeholder, leaving the rest of the SQL untouched', () => {
    const wb = new WhereBuilder();
    wb.add('? = ANY(tp.search_keywords)', 'gentle colors');
    expect(wb.where).toBe('1=1 AND $1 = ANY(tp.search_keywords)');
  });

  it('addIf() only adds the condition when true, and skips the placeholder number otherwise', () => {
    const wb = new WhereBuilder();
    wb.addIf(false, 'b.slug = ?', 'skipped');
    wb.addIf(true, 'tp.days = ?', 7);
    expect(wb.where).toBe('1=1 AND tp.days = $1');
    expect(wb.values).toEqual([7]);
  });

  it('addRaw() adds a condition with no bound value and no placeholder', () => {
    const wb = new WhereBuilder();
    wb.addRaw('tp.watchlist = true');
    wb.add('b.slug = ?', 'bomi');
    expect(wb.where).toBe('1=1 AND tp.watchlist = true AND b.slug = $1');
    expect(wb.values).toEqual(['bomi']);
  });

  it('nextIndex tracks the next free placeholder for LIMIT/OFFSET appended after the WHERE', () => {
    const wb = new WhereBuilder();
    wb.add('b.slug = ?', 'mizumi');
    wb.add('tp.days = ?', 7);
    expect(wb.nextIndex).toBe(3);
    const sql = `LIMIT $${wb.nextIndex} OFFSET $${wb.nextIndex + 1}`;
    expect(sql).toBe('LIMIT $3 OFFSET $4');
  });

  it('pushValues() binds extra values for a condition added via addRaw that reuses one placeholder multiple times', () => {
    const wb = new WhereBuilder();
    wb.add('b.slug = ?', 'mizumi'); // takes $1
    const i = wb.nextIndex; // $2 — reused 3x below, plus $3 for the second value
    wb.addRaw(`(LOWER(tp.caption) LIKE $${i} OR LOWER(tp.post_id) LIKE $${i} OR h LIKE $${i + 1})`);
    wb.pushValues('%mizumi%', '%mizumi%');
    expect(wb.where).toBe('1=1 AND b.slug = $1 AND (LOWER(tp.caption) LIKE $2 OR LOWER(tp.post_id) LIKE $2 OR h LIKE $3)');
    expect(wb.values).toEqual(['mizumi', '%mizumi%', '%mizumi%']);
  });

  it('methods are chainable', () => {
    const wb = new WhereBuilder();
    const result = wb.add('a = ?', 1).addIf(true, 'b = ?', 2).addRaw('c = true');
    expect(result).toBe(wb);
    expect(wb.where).toBe('1=1 AND a = $1 AND b = $2 AND c = true');
  });
});
