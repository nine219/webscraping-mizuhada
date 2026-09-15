// Shared CSV export — every data-table page uses this so escaping/BOM/download
// mechanics live in exactly one place. Client-side only (Blob + <a download>).
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

function csvField(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadCsv<T>(filename: string, columns: CsvColumn<T>[], rows: T[]): void {
  const header = columns.map((c) => c.header);
  const body = rows.map((r) => columns.map((c) => csvField(c.value(r))));
  // Leading BOM so Excel opens UTF-8 (Thai/CJK captions) without mangling.
  const csv = '﻿' + [header, ...body].map((r) => r.map(csvField).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
