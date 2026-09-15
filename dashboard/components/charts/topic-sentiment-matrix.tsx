'use client';

import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';
import { TopicMatrixRow } from '@/lib/api';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

// Above this negative-share threshold, the topic label is highlighted red —
// a topic that's 40% negative deserves attention even if it's low-volume.
const HIGH_NEGATIVE_SHARE = 0.3;

function negativeShare(d: TopicMatrixRow): number {
  return d.total > 0 ? d.negative / d.total : 0;
}

export default function TopicSentimentMatrix({ data, onTopicClick }: { data: TopicMatrixRow[]; onTopicClick?: (topic: string) => void }) {
  // Sorted by negative share (not raw volume) — a small topic that's mostly
  // negative surfaces above a large mostly-positive one, since that's the
  // one that actually needs a look. Raw counts are still shown per-bar.
  const sorted = [...data].sort((a, b) => negativeShare(b) - negativeShare(a));
  const labels = sorted.map((d) => d.topic);

  const chartData = {
    labels,
    datasets: [
      { label: 'Positive', data: sorted.map((d) => d.positive), backgroundColor: '#10b981', borderRadius: 3, barThickness: 16 },
      { label: 'Neutral', data: sorted.map((d) => d.neutral), backgroundColor: '#cbd5e1', borderRadius: 3, barThickness: 16 },
      { label: 'Negative', data: sorted.map((d) => d.negative), backgroundColor: '#ef4444', borderRadius: 3, barThickness: 16 },
    ],
  };

  const options = {
    indexAxis: 'y' as const,
    responsive: true,
    maintainAspectRatio: false,
    onClick: (_evt: unknown, elements: Array<{ index: number }>) => {
      if (!onTopicClick || !elements.length) return;
      onTopicClick(sorted[elements[0].index].topic);
    },
    onHover: (evt: { native: Event | null }, elements: unknown[]) => {
      const target = evt.native?.target as HTMLElement | undefined;
      if (target) target.style.cursor = onTopicClick && elements.length ? 'pointer' : 'default';
    },
    plugins: {
      legend: {
        display: true, position: 'bottom' as const,
        labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { size: 11 }, color: '#475569' },
      },
      tooltip: {
        backgroundColor: '#0f172a', padding: 10, cornerRadius: 8,
        callbacks: {
          // Extra footer line: this topic's overall negative share, so the
          // sort order (by negative %) is legible from the tooltip too.
          footer: (items: Array<{ dataIndex: number }>) => {
            const row = sorted[items[0]?.dataIndex];
            if (!row) return '';
            return `${Math.round(negativeShare(row) * 100)}% negative overall`;
          },
        },
      },
    },
    scales: {
      x: { stacked: true, beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 }, color: '#94a3b8', precision: 0 } },
      y: {
        stacked: true, grid: { display: false },
        ticks: {
          font: { size: 11 },
          color: (ctx: { tick: { value: number } }) => {
            const row = sorted[ctx.tick.value];
            return row && negativeShare(row) >= HIGH_NEGATIVE_SHARE ? '#ef4444' : '#475569';
          },
        },
      },
    },
  };

  if (!data.length) {
    return <div className="flex items-center justify-center h-full text-sm text-muted">No topic data yet</div>;
  }

  return <Bar data={chartData} options={options} />;
}
