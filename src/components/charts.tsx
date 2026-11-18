import { useRef } from "react";
import { DIVERGING, fmt, gridImage, palette, SEQUENTIAL, ticks, useCanvas } from "../lib/canvas";
import { useLab } from "../store";

export type Series = {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  color?: string;
  width?: number;
  alpha?: number;
  label?: string;
  dash?: number[];
};
type Shade = { lo: number; hi: number; label?: string };

type PlotProps = {
  series: Series[];
  xLabel?: string;
  yLabel?: string;
  xRange?: [number, number];
  yRange?: [number, number];
  shades?: Shade[];
  zero?: boolean;
  cursor?: number | null;
  onCursor?: (x: number | null) => void;
  onPick?: (x: number) => void;
  height?: number;
  canvasRef?: (c: HTMLCanvasElement | null) => void;
};

const L = 52;
const R = 14;
const T = 12;
const B = 34;

export function Plot(props: PlotProps) {
  const theme = useLab((s) => s.theme);
  const range = useRef({ x0: 0, x1: 1 });
  const { ref } = useCanvas(
    (ctx, w, h) => {
      const p = palette();
      const { series } = props;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const s of series) {
        for (let i = 0; i < s.x.length; i++) {
          const x = s.x[i], y = s.y[i];
          if (props.xRange && (x < props.xRange[0] || x > props.xRange[1])) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (Number.isFinite(y)) {
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (props.xRange) [x0, x1] = props.xRange;
      if (props.yRange) [y0, y1] = props.yRange;
      else {
        const pad = (y1 - y0 || 1) * 0.08;
        y0 -= pad;
        y1 += pad;
      }
      if (!Number.isFinite(x0)) { x0 = 0; x1 = 1; y0 = 0; y1 = 1; }
      range.current = { x0, x1 };
      const pw = w - L - R, ph = h - T - B;
      const X = (v: number) => L + ((v - x0) / (x1 - x0)) * pw;
      const Y = (v: number) => T + ph - ((v - y0) / (y1 - y0)) * ph;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = p.bg;
      ctx.fillRect(0, 0, w, h);
      ctx.font = `10px ${p.mono}`;

      for (const s of props.shades ?? []) {
        const a = Math.max(x0, s.lo), b = Math.min(x1, s.hi);
        if (b <= a) continue;
        ctx.fillStyle = p.muted + "14";
        ctx.fillRect(X(a), T, X(b) - X(a), ph);
        if (s.label) {
          ctx.fillStyle = p.muted;
          ctx.textAlign = "center";
          ctx.fillText(s.label, (X(a) + X(b)) / 2, T + 10);
        }
      }

      const xt = ticks(x0, x1, pw / 80), yt = ticks(y0, y1, ph / 42);
      ctx.strokeStyle = p.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const v of xt.values) { const x = Math.round(X(v)) + 0.5; ctx.moveTo(x, T); ctx.lineTo(x, T + ph); }
      for (const v of yt.values) { const y = Math.round(Y(v)) + 0.5; ctx.moveTo(L, y); ctx.lineTo(L + pw, y); }
      ctx.stroke();
      if (props.zero) {
        ctx.strokeStyle = p.muted;
        ctx.beginPath();
        if (y0 < 0 && y1 > 0) { ctx.moveTo(L, Math.round(Y(0)) + 0.5); ctx.lineTo(L + pw, Math.round(Y(0)) + 0.5); }
        if (x0 < 0 && x1 > 0) { ctx.moveTo(Math.round(X(0)) + 0.5, T); ctx.lineTo(Math.round(X(0)) + 0.5, T + ph); }
        ctx.stroke();
      }

      ctx.fillStyle = p.muted;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const v of xt.values) ctx.fillText(fmt(v, xt.step), X(v), T + ph + 6);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (const v of yt.values) ctx.fillText(fmt(v, yt.step), L - 7, Y(v));
      ctx.fillStyle = p.text;
      ctx.font = `11px ${p.sans}`;
      ctx.textAlign = "center";
      if (props.xLabel) ctx.fillText(props.xLabel, L + pw / 2, h - 9);
      if (props.yLabel) {
        ctx.save();
        ctx.translate(11, T + ph / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(props.yLabel, 0, 0);
        ctx.restore();
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(L, T, pw, ph);
      ctx.clip();
      for (const s of series) {
        ctx.strokeStyle = s.color ?? p.trace;
        ctx.globalAlpha = s.alpha ?? 1;
        ctx.lineWidth = s.width ?? 1.2;
        ctx.setLineDash(s.dash ?? []);
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i < s.x.length; i++) {
          const y = s.y[i];
          if (!Number.isFinite(y)) { pen = false; continue; }
          if (pen) ctx.lineTo(X(s.x[i]), Y(y));
          else { ctx.moveTo(X(s.x[i]), Y(y)); pen = true; }
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (props.cursor != null && props.cursor >= x0 && props.cursor <= x1) {
        ctx.strokeStyle = p.accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(X(props.cursor), T);
        ctx.lineTo(X(props.cursor), T + ph);
        ctx.stroke();
      }
      ctx.restore();

      const labelled = series.filter((s) => s.label);
      if (labelled.length) {
        ctx.font = `11px ${p.sans}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        let x = L + 10;
        for (const s of labelled) {
          ctx.strokeStyle = s.color ?? p.trace;
          ctx.lineWidth = 2;
          ctx.setLineDash(s.dash ?? []);
          ctx.beginPath();
          ctx.moveTo(x, T + 10);
          ctx.lineTo(x + 16, T + 10);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = p.text;
          ctx.fillText(s.label!, x + 21, T + 10);
          x += 34 + ctx.measureText(s.label!).width;
        }
      }
      ctx.strokeStyle = p.line;
      ctx.lineWidth = 1;
      ctx.strokeRect(L + 0.5, T + 0.5, pw, ph);
    },
    [props.series, props.cursor, props.xRange?.[0], props.xRange?.[1], props.yRange?.[0], props.yRange?.[1], theme],
  );

  const toX = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left - L) / (r.width - L - R);
    if (f < 0 || f > 1) return null;
    return range.current.x0 + f * (range.current.x1 - range.current.x0);
  };

  return (
    <canvas
      ref={(c) => { ref.current = c; props.canvasRef?.(c); }}
      className="plot"
      style={{ height: props.height ?? 260, cursor: props.onCursor || props.onPick ? "crosshair" : undefined }}
      onPointerMove={props.onCursor ? (e) => props.onCursor!(toX(e)) : undefined}
      onPointerLeave={props.onCursor ? () => props.onCursor!(null) : undefined}
      onClick={props.onPick ? (e) => { const x = toX(e as unknown as React.PointerEvent<HTMLCanvasElement>); if (x != null) props.onPick!(x); } : undefined}
    />
  );
}

type HeatProps = {
  data: Float32Array;
  nx: number;
  ny: number;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  diverging?: boolean;
  xLabel?: string;
  yLabel?: string;
  unit?: string;
  height?: number;
  canvasRef?: (c: HTMLCanvasElement | null) => void;
};

export function Heatmap(props: HeatProps) {
  const theme = useLab((s) => s.theme);
  const { ref } = useCanvas(
    (ctx, w, h) => {
      const p = palette();
      const RB = 74;
      const pw = w - L - RB, ph = h - T - B;
      const sorted = Float32Array.from(props.data).filter(Number.isFinite).sort();
      let lo = sorted[Math.floor(sorted.length * 0.01)] ?? 0;
      let hi = sorted[Math.floor(sorted.length * 0.99)] ?? 1;
      if (props.diverging) { const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1; lo = -m; hi = m; }
      // rows arrive low-frequency first; flip so low is at the bottom
      const flipped = new Float32Array(props.data.length);
      for (let r = 0; r < props.ny; r++)
        flipped.set(props.data.subarray(r * props.nx, (r + 1) * props.nx), (props.ny - 1 - r) * props.nx);
      const img = gridImage(flipped, props.nx, props.ny, lo, hi, props.diverging ? DIVERGING : SEQUENTIAL);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = p.bg;
      ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, L, T, pw, ph);

      const x0 = props.x[0], x1 = props.x[props.x.length - 1];
      const y0 = props.y[0], y1 = props.y[props.y.length - 1];
      const X = (v: number) => L + ((v - x0) / (x1 - x0)) * pw;
      const Y = (v: number) => T + ph - ((v - y0) / (y1 - y0)) * ph;
      const xt = ticks(x0, x1, pw / 90), yt = ticks(y0, y1, ph / 42);
      ctx.font = `10px ${p.mono}`;
      ctx.fillStyle = p.muted;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const v of xt.values) ctx.fillText(fmt(v, xt.step), X(v), T + ph + 6);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (const v of yt.values) ctx.fillText(fmt(v, yt.step), L - 7, Y(v));
      if (x0 < 0 && x1 > 0) {
        ctx.strokeStyle = "#ffffffcc";
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(X(0), T);
        ctx.lineTo(X(0), T + ph);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = p.text;
      ctx.font = `11px ${p.sans}`;
      ctx.textAlign = "center";
      if (props.xLabel) ctx.fillText(props.xLabel, L + pw / 2, h - 9);
      if (props.yLabel) {
        ctx.save();
        ctx.translate(11, T + ph / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(props.yLabel, 0, 0);
        ctx.restore();
      }
      // colour bar
      const map = props.diverging ? DIVERGING : SEQUENTIAL;
      const bx = L + pw + 14;
      for (let i = 0; i < ph; i++) {
        const k = Math.round((1 - i / ph) * 255) * 3;
        ctx.fillStyle = `rgb(${map[k]},${map[k + 1]},${map[k + 2]})`;
        ctx.fillRect(bx, T + i, 10, 1.5);
      }
      ctx.font = `10px ${p.mono}`;
      ctx.fillStyle = p.muted;
      ctx.textAlign = "left";
      ctx.fillText(hi.toFixed(1), bx + 14, T + 5);
      ctx.fillText(lo.toFixed(1), bx + 14, T + ph - 5);
      if (props.unit) {
        ctx.save();
        ctx.translate(bx + 40, T + ph / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "center";
        ctx.fillText(props.unit, 0, 0);
        ctx.restore();
      }
      ctx.strokeStyle = p.line;
      ctx.strokeRect(L + 0.5, T + 0.5, pw, ph);
    },
    [props.data, theme],
  );
  return <canvas ref={(c) => { ref.current = c; props.canvasRef?.(c); }} className="plot" style={{ height: props.height ?? 320 }} />;
}

type TopoProps = {
  grid: Float32Array;
  n: number;
  size?: number;
  diverging?: boolean;
  range?: [number, number];
  points?: ([number, number] | null)[];
  dim?: boolean;
};

export function Topomap({ grid, n, size = 120, diverging = true, range, points, dim }: TopoProps) {
  const theme = useLab((s) => s.theme);
  const { ref } = useCanvas(
    (ctx, w, h) => {
      const p = palette();
      let lo = Infinity, hi = -Infinity;
      if (range) [lo, hi] = range;
      else {
        for (let i = 0; i < grid.length; i++) {
          const v = grid[i];
          if (Number.isNaN(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (diverging) { const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1; lo = -m; hi = m; }
      }
      const cx = w / 2, cy = h / 2 + 3;
      const rad = Math.min(w, h) * 0.41;
      const half = rad * 1.12;
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = dim ? 0.35 : 1;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.clip();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(gridImage(grid, n, n, lo, hi, diverging ? DIVERGING : SEQUENTIAL), cx - half, cy - half, half * 2, half * 2);
      ctx.restore();
      ctx.strokeStyle = p.text;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.moveTo(cx - rad * 0.14, cy - rad * 0.985);
      ctx.lineTo(cx, cy - rad * 1.13);
      ctx.lineTo(cx + rad * 0.14, cy - rad * 0.985);
      ctx.stroke();
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(cx + s * rad * 1.035, cy, rad * 0.045, rad * 0.16, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (points) {
        ctx.fillStyle = "#00000099";
        for (const pt of points) {
          if (!pt) continue;
          ctx.beginPath();
          ctx.arc(cx + pt[0] * rad, cy - pt[1] * rad, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    },
    [grid, theme, dim, range?.[0], range?.[1]],
  );
  return <canvas ref={ref} className="topo" style={{ width: size, height: size }} />;
}
