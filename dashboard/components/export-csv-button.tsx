'use client';

import { useState } from 'react';
import { downloadCsv, CsvColumn } from '@/lib/csv-export';

// Every data-table page's "Export CSV" button — downloads every row matching
// the current filters (not just the current page) as CSV. Most callers pass
// already-loaded in-memory data (the page already fetches the full filtered
// set for client-side sort), so this is typically instant, not a re-fetch.
// Sits top-right of the page/card header.
export function ExportCsvButton<T>({
  fetchAll,
  columns,
  filename,
  disabled,
}: {
  /** Resolve every row matching the current filters (no page limit) — from cache or a fresh fetch. */
  fetchAll: () => Promise<T[]>;
  columns: CsvColumn<T>[];
  filename: string | (() => string);
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function run() {
    setBusy(true);
    setFailed(false);
    try {
      const rows = await fetchAll();
      downloadCsv(typeof filename === 'function' ? filename() : filename, columns, rows);
    } catch {
      setFailed(true);
      setTimeout(() => setFailed(false), 3000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={run}
      disabled={busy || disabled}
      className="btn btn-sm"
      title="Export every row matching the current filters to CSV (not just this page)"
    >
      {busy ? 'Exporting…' : failed ? 'Export failed' : '⭳ Export CSV'}
    </button>
  );
}
