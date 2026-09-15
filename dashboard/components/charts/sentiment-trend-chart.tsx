'use client';

import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement,
  Filler, Tooltip, Legend,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { SentimentTrendPoint } from '@/lib/api';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend);

function fmtDay(d: string) {
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function SentimentTrendChart({ data, onDateClick }: { data: SentimentTrendPoint[]; onDateClick?: (isoDate: string) => void }) {
  const labels = data.map((d) => fmtDay(d.date));

  const chartData = {
    labels,
    datasets: [
      {
        label: 'Positive', data: data.map((d) => d.positive),
        borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)',
        fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2,
      },
      {
        label: 'Neutral', data: data.map((d) => d.neutral),
        borderColor: '#94a3b8', backgroundColor: 'rgba(148,163,184,0.05)',
        fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2,
      },
      {
        label: 'Negative', data: data.map((d) => d.negative),
        borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.08)',
        fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    onClick: (_evt: unknown, elements: Array<{ index: number }>) => {
      if (!onDateClick || !elements.length) return;
      onDateClick(data[elements[0].index].date);
    },
    onHover: (evt: { native: Event | null }, elements: unknown[]) => {
      const target = evt.native?.target as HTMLElement | undefined;
      if (target) target.style.cursor = onDateClick && elements.length ? 'pointer' : 'default';
    },
    plugins: {
      legend: {
        display: true, position: 'bottom' as const,
        labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { size: 11 }, color: '#475569' },
      },
      tooltip: {
        backgroundColor: '#0f172a', padding: 10, cornerRadius: 8, titleFont: { size: 12 }, bodyFont: { size: 12 },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { maxTicksLimit: 8, font: { size: 10 }, color: '#94a3b8' } },
      y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 }, color: '#94a3b8', precision: 0 } },
    },
  };

  if (!data.length) {
    return <div className="flex items-center justify-center h-full text-sm text-muted">No sentiment data yet</div>;
  }

  return <Line data={chartData} options={options} />;
}
