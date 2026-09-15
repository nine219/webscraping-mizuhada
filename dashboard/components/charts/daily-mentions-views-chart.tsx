'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Chart as ChartJS, LinearScale, PointElement, LineElement,
  Filler, Tooltip, Legend,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { interpolatedCrosshairPlugin, CrosshairState } from './chart-crosshair';

ChartJS.register(LinearScale, PointElement, LineElement, Filler, Tooltip, Legend, interpolatedCrosshairPlugin);

export interface DailyTrendPoint {
  date: string;
  post_count: number;
  total_views: number;
  total_engagement: number;
}

function fmtDay(d: string) {
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

export default function DailyMentionsViewsChart({ data }: { data: DailyTrendPoint[] }) {
  const [hover, setHover] = useState<CrosshairState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);

  if (!data.length) {
    return <div className="flex items-center justify-center h-full text-sm text-muted">No daily data yet</div>;
  }

  const chartData = {
    datasets: [
      {
        label: 'Mentions', data: data.map((d, i) => ({ x: i, y: d.post_count })), yAxisID: 'mentions',
        borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.08)',
        fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 0, borderWidth: 2,
      },
      {
        label: 'Views', data: data.map((d, i) => ({ x: i, y: d.total_views })), yAxisID: 'views',
        borderColor: '#8b5cf6', backgroundColor: 'rgba(139,92,246,0.06)',
        fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 0, borderWidth: 2,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    events: ['mousemove', 'mouseout', 'click'] as ('mousemove' | 'mouseout' | 'click')[],
    plugins: {
      legend: {
        display: true, position: 'bottom' as const,
        labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { size: 11 }, color: '#475569' },
      },
      tooltip: { enabled: false },
      interpolatedCrosshair: {
        onHover: setHover,
      },
    },
    scales: {
      x: {
        type: 'linear' as const, min: 0, max: data.length - 1,
        grid: { display: false },
        ticks: {
          maxTicksLimit: 8, font: { size: 10 }, color: '#94a3b8', stepSize: 1,
          callback: (v: string | number) => {
            const i = Math.round(typeof v === 'number' ? v : parseFloat(v));
            return data[i] ? fmtDay(data[i].date) : '';
          },
        },
      },
      mentions: {
        type: 'linear' as const, position: 'left' as const, beginAtZero: true,
        grid: { color: '#f1f5f9' },
        ticks: { font: { size: 10 }, color: '#3b82f6', precision: 0 },
        title: { display: true, text: 'Mentions', font: { size: 10 }, color: '#3b82f6' },
      },
      views: {
        type: 'linear' as const, position: 'right' as const, beginAtZero: true,
        grid: { display: false },
        ticks: {
          font: { size: 10 }, color: '#8b5cf6',
          callback: (v: string | number) => fmtCompact(typeof v === 'number' ? v : parseFloat(v)),
        },
        title: { display: true, text: 'Views', font: { size: 10 }, color: '#8b5cf6' },
      },
    },
  };

  useEffect(() => {
    if (chartRef.current) {
      chartRef.current.$crosshairLabels = data.map((d) => fmtDay(d.date));
    }
  }, [data]);

  const containerWidth = containerRef.current?.clientWidth ?? 0;
  const tooltipLeft = hover ? Math.min(hover.x + 12, Math.max(0, containerWidth - 160)) : 0;

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Line ref={chartRef} data={chartData} options={options} />
      {hover && (
        <div
          style={{
            position: 'absolute', left: tooltipLeft, top: 8, pointerEvents: 'none',
            background: '#0f172a', color: '#fff', borderRadius: 8, padding: '8px 10px',
            fontSize: 12, lineHeight: 1.5, whiteSpace: 'nowrap', boxShadow: '0 4px 12px rgba(0,0,0,0.25)', zIndex: 10,
          }}
        >
          <div style={{ opacity: 0.7, fontSize: 10, marginBottom: 2 }}>{hover.dateLabel}</div>
          {hover.points.map((p) => (
            <div key={p.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, display: 'inline-block' }} />
              <span>{p.label}: {fmtCompact(p.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
