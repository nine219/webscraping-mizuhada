'use client';

import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement,
  Filler, Tooltip,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { CrisisTimelinePoint } from '@/lib/api';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip);

function fmtDay(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function CrisisRiskChart({ data, onDateClick }: { data: CrisisTimelinePoint[]; onDateClick?: (isoDate: string) => void }) {
  const labels = data.map((d) => fmtDay(d.date));

  const chartData = {
    labels,
    datasets: [
      {
        label: 'Negative comments',
        data: data.map((d) => d.negative),
        borderColor: '#ef4444',
        backgroundColor: 'rgba(239,68,68,0.12)',
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
      legend: { display: false },
      tooltip: { backgroundColor: '#0f172a', padding: 10, cornerRadius: 8 },
    },
    scales: {
      x: { grid: { display: false }, ticks: { maxTicksLimit: 7, font: { size: 10 }, color: '#94a3b8' } },
      y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 }, color: '#94a3b8', precision: 0 } },
    },
  };

  if (!data.length) {
    return <div className="flex items-center justify-center h-full text-sm text-muted">No negative-volume data yet</div>;
  }

  return <Line data={chartData} options={options} />;
}
