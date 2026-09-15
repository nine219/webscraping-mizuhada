import { Chart, Plugin } from 'chart.js';

// Continuous crosshair: instead of snapping to whichever day is "nearest" to
// the cursor, this interpolates a value for each line at the EXACT mouse x
// position (between the two surrounding data points) and draws a dot there —
// so the dot and the reported value always agree with where your cursor
// actually is, not with a discrete day column.

export interface CrosshairPoint {
  color: string;
  label: string;
  value: number;
  px: number;
  py: number;
}

export interface CrosshairState {
  x: number;
  points: CrosshairPoint[];
  dateLabel: string;
}

export interface CrosshairPluginOptions {
  onHover?: (state: CrosshairState | null) => void;
}

declare module 'chart.js' {
  interface PluginOptionsByType<TType> {
    interpolatedCrosshair?: CrosshairPluginOptions;
  }
  interface Chart {
    $crosshair?: CrosshairState | null;
    $crosshairLabels?: string[];
  }
}

let insideAfterEvent = false;

export const interpolatedCrosshairPlugin: Plugin<'line'> = {
  id: 'interpolatedCrosshair',
  afterEvent(chart, args) {
    if (insideAfterEvent) return;
    insideAfterEvent = true;
    try {
      const opts = chart.options.plugins?.interpolatedCrosshair;
      const xScale = chart.scales.x;
      const { event } = args;
      const clear = () => {
        if (chart.$crosshair) {
          chart.$crosshair = null;
          args.changed = true;
          opts?.onHover?.(null);
        }
      };

      if (!xScale || event.x == null || event.y == null) { clear(); return; }
      const { left, right, top, bottom } = chart.chartArea;
      if (event.type === 'mouseout' || event.x < left || event.x > right || event.y < top || event.y > bottom) {
        clear();
        return;
      }

      const maxIndex = (chart.data.datasets[0]?.data.length ?? 1) - 1;
      if (maxIndex <= 0) return;
      const rawIndex = xScale.getValueForPixel(event.x) ?? 0;
      const idx = Math.min(Math.max(rawIndex, 0), maxIndex);
      const i0 = Math.floor(idx);
      const i1 = Math.min(i0 + 1, maxIndex);
      const t = idx - i0;

      const points: CrosshairPoint[] = chart.data.datasets.map((ds) => {
        const data = ds.data as Array<{ x: number; y: number } | null>;
        const y0 = data[i0]?.y ?? 0;
        const y1 = data[i1]?.y ?? 0;
        const value = y0 + (y1 - y0) * t;
        const yAxisId = (ds as unknown as { yAxisID?: string }).yAxisID ?? 'y';
        const yScale = chart.scales[yAxisId];
        return {
          color: (ds.borderColor as string) ?? '#000',
          label: ds.label ?? '',
          value,
          px: event.x as number,
          py: yScale ? yScale.getPixelForValue(value) : event.y as number,
        };
      });

      const roundedIdx = Math.round(idx);
      const dateLabel = chart.$crosshairLabels?.[roundedIdx] ?? String(roundedIdx);
      chart.$crosshair = { x: event.x, points, dateLabel };
      args.changed = true;
      opts?.onHover?.(chart.$crosshair);
    } finally {
      insideAfterEvent = false;
    }
  },
  afterDraw(chart) {
    const state = chart.$crosshair;
    if (!state) return;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(state.x, top);
    ctx.lineTo(state.x, bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(100,116,139,0.4)';
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    for (const p of state.points) {
      ctx.beginPath();
      ctx.arc(p.px, p.py, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    ctx.restore();
  },
};
