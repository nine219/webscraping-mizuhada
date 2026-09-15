'use client';

import { useState } from 'react';
import { fetchSocial } from '@/lib/api';

const reports = [
  { name: 'Weekly Social Sentiment Digest',  sub: 'Auto-generated every Monday 08:00',           status: 'Scheduled', format: 'PDF + Teams', action: 'teams' },
  { name: 'Monthly Brand Mention Analysis',  sub: 'Platform × Brand breakdown',                  status: 'Scheduled', format: 'PDF',         action: 'teams' },
  { name: 'Sentiment Trend Report',          sub: 'TikTok / IG / FB sentiment shifts',           status: 'On-demand', format: 'CSV',         action: 'csv_sentiment' },
  { name: 'TikTok Spike Alert Summary',      sub: 'Triggered when engagement ≥5× baseline',     status: 'Auto',      format: 'Teams + LINE', action: 'teams' },
];

const schedules = [
  { name: 'Social Scrape',           freq: 'Every 30 min',     platforms: 'TikTok · Instagram · Facebook · Weibo', next: 'In ~15 min' },
  { name: 'Sentiment Analysis',      freq: 'Every 2 hours',    platforms: 'TikTok · Instagram · Facebook',        next: 'In ~1h 20m' },
  { name: 'Spike Detection',         freq: 'After every scrape', platforms: 'TikTok',                            next: 'In ~15 min' },
  { name: 'Weekly Digest',           freq: 'Monday 08:00 BKK', platforms: 'MS Teams',                            next: 'Monday 08:00' },
];

async function downloadSentimentCSV() {
  const { data } = await fetchSocial({ page: 1 });
  const header = 'Brand,Platform,Sentiment,Score,Topic,Content,Date';
  const rows = data.map((c) =>
    [c.brand_name, c.platform, c.sentiment ?? '', c.sentiment_score ?? '', c.topic ?? '', c.content, c.published_at ?? '']
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
  );
  return [header, ...rows].join('\n');
}

function triggerDownload(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const [toast, setToast] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 4000);
  }

  async function handleDownload(report: typeof reports[0]) {
    if (report.action === 'teams') {
      showToast('This report is delivered via MS Teams/LINE on schedule. Configure webhook in Settings.');
      return;
    }
    setDownloading(report.name);
    try {
      const date = new Date().toISOString().slice(0, 10);
      if (report.action === 'csv_sentiment') {
        const csv = await downloadSentimentCSV();
        triggerDownload(csv, `sentiment-${date}.csv`);
      } else {
        showToast('No data available for this report yet — run a scraper first.');
      }
    } catch {
      showToast('Failed to fetch data — make sure the API server is running.');
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div>
      {toast && (
        <div
          className="fixed bottom-6 right-6 z-50 max-w-sm px-4 py-3 rounded-xl text-sm font-medium"
          style={{ background: 'var(--accent-primary)', color: '#fff', boxShadow: 'var(--shadow-lg)' }}
        >
          {toast}
        </div>
      )}

      <div className="flex justify-between items-center mb-7">
        <div>
          <h2 className="text-[28px] font-bold text-primary">Reports</h2>
          <p className="text-sm mt-1 text-secondary">Automated and on-demand intelligence reports</p>
        </div>
        <button
          onClick={() => showToast('Scheduled reports run automatically. For CSV exports, use the Download button on each row.')}
          style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--accent-primary)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
        >
          + Generate Report
        </button>
      </div>

      <div className="rounded-xl p-6 mb-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
        <div className="text-base font-semibold mb-5 text-primary">Available Reports</div>
        <div
          className="grid text-xs font-semibold uppercase tracking-wide pb-3"
          style={{ gridTemplateColumns: '2fr 1fr 130px 80px 120px', gap: 12, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}
        >
          <span>Report</span><span>Format</span><span>Type</span><span>Status</span><span>Action</span>
        </div>
        {reports.map((r) => (
          <div
            key={r.name}
            className="grid py-3.5"
            style={{ gridTemplateColumns: '2fr 1fr 130px 80px 120px', gap: 12, borderBottom: '1px solid var(--border-light)', alignItems: 'center', fontSize: 13 }}
          >
            <div className="flex items-center">
              <div className="w-8 h-8 rounded-lg inline-flex items-center justify-center mr-2.5 flex-shrink-0" style={{ background: '#eff6ff' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0284c7" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
              </div>
              <div>
                <div className="font-medium text-primary">{r.name}</div>
                <div className="text-[11px] mt-0.5 text-muted">{r.sub}</div>
              </div>
            </div>
            <span className="text-secondary">{r.format}</span>
            <span><span className="tag tag-blue">{r.status}</span></span>
            <span><span className="tag tag-green">Active</span></span>
            <button
              onClick={() => handleDownload(r)}
              disabled={downloading === r.name}
              style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface)', cursor: 'pointer', fontSize: 12, opacity: downloading === r.name ? 0.6 : 1 }}
            >
              {downloading === r.name ? 'Fetching...' : r.action.startsWith('csv') ? 'Download CSV' : 'Delivery Info'}
            </button>
          </div>
        ))}
      </div>

      <div className="rounded-xl p-6" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
        <div className="text-base font-semibold mb-5 text-primary">Scheduled Jobs</div>
        <div
          className="grid text-xs font-semibold uppercase tracking-wide pb-3"
          style={{ gridTemplateColumns: '2fr 1fr 120px 80px', gap: 12, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}
        >
          <span>Job</span><span>Frequency</span><span>Next Run</span><span>Status</span>
        </div>
        {schedules.map((s) => (
          <div
            key={s.name}
            className="grid py-3.5"
            style={{ gridTemplateColumns: '2fr 1fr 120px 80px', gap: 12, borderBottom: '1px solid var(--border-light)', alignItems: 'center', fontSize: 13 }}
          >
            <div>
              <div className="font-medium text-primary">{s.name}</div>
              <div className="text-xs mt-0.5 text-muted">{s.platforms}</div>
            </div>
            <span className="text-secondary">{s.freq}</span>
            <span className="font-mono text-xs font-medium text-secondary">{s.next}</span>
            <span><span className="tag tag-green">Running</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}
