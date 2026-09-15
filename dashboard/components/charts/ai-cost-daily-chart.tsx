'use client';

import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, ChartEvent, ActiveElement,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip);

export interface DailyCostPoint {
  date: string;
  cost_usd: number;
  calls: number;
}

function fmtDay(d: string) {
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtUsd(n: number): string {
  return n >= 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(6)}`;
}

export default function AiCostDailyChart({ data, onBarClick, selectedDate }: {
  data: DailyCostPoint[];
  /** Fired with the bar's raw `date` (YYYY-MM-DD) when a bar is clicked. */
  onBarClick?: (date: string) => void;
  /** Currently drilled-down date, if any — highlights the matching bar. */
  selectedDate?: string | null;
}) {
  if (!data.length) {
    return <div className="flex items-center justify-center h-full text-sm text-muted">No cost data yet</div>;
  }

  const chartData = {
    labels: data.map((d) => fmtDay(d.date)),
    datasets: [
      {
        data: data.map((d) => d.cost_usd),
        backgroundColor: data.map((d) => (selectedDate && d.date === selectedDate ? '#1d4ed8' : '#3b82f6')),
        borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 } as unknown as number,
        borderSkipped: false,
        maxBarThickness: 36,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    // Hit-test by x-column, not the bar's own rectangle — a short bar (small
    // cost day) is otherwise a tiny sliver near the bottom, hard to land a
    // click on. `intersect: false` makes anywhere in that day's full-height
    // column count, matching the nearest bar regardless of its height.
    interaction: { mode: 'index' as const, intersect: false },
    onClick: onBarClick
      ? (_evt: ChartEvent, elements: ActiveElement[]) => {
          if (elements.length > 0) onBarClick(data[elements[0].index].date);
        }
      : undefined,
    onHover: onBarClick
      ? (evt: ChartEvent, elements: ActiveElement[]) => {
          const target = evt.native?.target as HTMLElement | null;
          if (target?.style) target.style.cursor = elements.length > 0 ? 'pointer' : 'default';
        }
      : undefined,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0f172a',
        padding: 8,
        titleFont: { size: 11 },
        bodyFont: { size: 12 },
        callbacks: {
          title: (items: { dataIndex: number }[]) => fmtDay(data[items[0].dataIndex].date),
          label: (item: { dataIndex: number }) => {
            const d = data[item.dataIndex];
            return [`Cost: ${fmtUsd(d.cost_usd)}`, `Calls: ${d.calls}`];
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { font: { size: 10 }, color: '#94a3b8' },
      },
      y: {
        beginAtZero: true,
        grid: { color: '#f1f5f9' },
        ticks: {
          font: { size: 10 }, color: '#94a3b8',
          callback: (v: string | number) => fmtUsd(typeof v === 'number' ? v : parseFloat(v)),
        },
      },
    },
  };

  return <Bar data={chartData} options={options} />;
}
