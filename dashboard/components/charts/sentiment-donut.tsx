'use client';

import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';
import { Doughnut } from 'react-chartjs-2';

ChartJS.register(ArcElement, Tooltip, Legend);

interface Props {
  positive: number;
  negative: number;
  neutral: number;
  // Fires with the clicked slice's sentiment — lets callers drill into
  // e.g. topic breakdown for just that slice. Omit for a static chart.
  onSliceClick?: (sentiment: 'positive' | 'negative' | 'neutral') => void;
}

const SLICE_SENTIMENTS: Array<'positive' | 'negative' | 'neutral'> = ['positive', 'negative', 'neutral'];

export default function SentimentDonut({ positive, negative, neutral, onSliceClick }: Props) {
  const total = positive + negative + neutral || 1;

  const data = {
    labels: ['Positive', 'Negative', 'Neutral'],
    datasets: [
      {
        data: [positive, negative, neutral],
        backgroundColor: ['#10b981', '#ef4444', '#94a3b8'],
        borderWidth: 0,
        hoverOffset: 4,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '72%',
    onClick: onSliceClick
      ? (_evt: unknown, elements: Array<{ index: number }>) => {
          if (elements.length > 0) onSliceClick(SLICE_SENTIMENTS[elements[0].index]);
        }
      : undefined,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: { label: string; raw: unknown }) =>
            `${ctx.label}: ${Math.round((Number(ctx.raw) / total) * 100)}%`,
        },
      },
    },
  };

  return (
    <div className="relative" style={{ height: 180, cursor: onSliceClick ? 'pointer' : undefined }}>
      <Doughnut data={data} options={options} />
      <div
        className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
      >
        <div className="text-2xl font-bold text-primary">
          {Math.round((positive / total) * 100)}%
        </div>
        <div className="text-xs text-muted">Positive</div>
      </div>
    </div>
  );
}
