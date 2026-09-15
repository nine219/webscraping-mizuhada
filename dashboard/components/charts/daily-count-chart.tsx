'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Chart as ChartJS, LinearScale, PointElement, LineElement,
  Filler, Tooltip, Legend,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { interpolatedCrosshairPlugin, CrosshairState } from './chart-crosshair';

ChartJS.register(LinearScale, PointElement, LineElement, Filler, Tooltip, Legend, interpolatedCrosshairPlugin);

export interface DailyCountPoint {
  date: string;
  count: number;
}

function fmtDay(d: string) {
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function DailyCountChart({ data, label = 'Mentions' }: { data: DailyCountPoint[]; label?: string }) {
  const [hover, setHover] = useState<CrosshairState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);

  if (!data.length) {
    return <div className="flex items-center justify-center h-full text-sm text-muted">No daily data yet</div>;
  }

  const chartData = {
    datasets: [
      {
        label, data: data.map((d, i) => ({ x: i, y: d.count })),
        borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.08)',
        fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 0, borderWidth: 2,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    events: ['mousemove', 'mouseout', 'click'] as ('mousemove' | 'mouseout' | 'click')[],
    plugins: {
      legend: { display: false },
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
      y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 }, color: '#94a3b8', precision: 0 } },
    },
  };

  useEffect(() => {
    if (chartRef.current) {
      chartRef.current.$crosshairLabels = data.map((d) => fmtDay(d.date));
    }
  }, [data]);

  const containerWidth = containerRef.current?.clientWidth ?? 0;
  const tooltipLeft = hover ? Math.min(hover.x + 12, Math.max(0, containerWidth - 140)) : 0;

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
              <span>{p.label}: {p.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
