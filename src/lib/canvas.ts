import { useEffect, useRef } from "react";

export type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

/** Keeps a canvas sized to its box (in device pixels) and redraws when asked. */
export function useCanvas(draw: Draw, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const frame = useRef(0);

  const redraw = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const c = ref.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (!w || !h) return;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRef.current(ctx, w, h);
    });
  };

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ro = new ResizeObserver(redraw);
    ro.observe(c);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(redraw, deps);
  return { ref, redraw };
}

/** Reads the current theme's colours for canvas drawing. */
export function palette() {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return {
    bg: v("--surface"),
    panel: v("--panel"),
    line: v("--line"),
    grid: v("--grid"),
    text: v("--text"),
    muted: v("--muted"),
    trace: v("--trace"),
    accent: v("--accent"),
    amber: v("--amber"),
    danger: v("--danger"),
    mono: v("--mono"),
    sans: v("--sans"),
  };
}

export const SERIES = ["#5b8ff0", "#e8963a", "#4fb286", "#e0646b", "#a583e0", "#3fb5c4", "#d6a23d", "#9aa5b5"];

export function niceStep(range: number, target: number) {
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
}

export function ticks(lo: number, hi: number, target: number) {
  const step = niceStep(hi - lo, target);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { step, values: out };
}

export function fmt(v: number, step: number) {
  const d = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  return v.toFixed(d);
}

export function clock(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(s % 1 ? 1 : 0)}`;
}

function lut(stops: number[][]) {
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * (stops.length - 1);
    const a = Math.floor(p);
    const b = Math.min(stops.length - 1, a + 1);
    const f = p - a;
    for (let k = 0; k < 3; k++) out[i * 3 + k] = stops[a][k] + (stops[b][k] - stops[a][k]) * f;
  }
  return out;
}

export const DIVERGING = lut([
  [5, 48, 97], [33, 102, 172], [67, 147, 195], [146, 197, 222], [209, 229, 240], [247, 247, 247],
  [253, 219, 199], [244, 165, 130], [214, 96, 77], [178, 24, 43], [103, 0, 31],
]);
// viridis
export const SEQUENTIAL = lut([
  [68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142], [33, 144, 141], [39, 173, 129],
  [92, 200, 99], [170, 220, 50], [253, 231, 37],
]);

/** Renders a 2-D grid (NaN = transparent) to a canvas image source. */
export function gridImage(data: Float32Array, w: number, h: number, lo: number, hi: number, map: Uint8ClampedArray) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const span = hi - lo || 1;
  for (let i = 0; i < w * h; i++) {
    const v = data[i];
    if (Number.isNaN(v)) continue;
    const k = Math.max(0, Math.min(255, Math.round(((v - lo) / span) * 255))) * 3;
    img.data[i * 4] = map[k];
    img.data[i * 4 + 1] = map[k + 1];
    img.data[i * 4 + 2] = map[k + 2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function download(name: string, content: BlobPart, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function savePng(canvas: HTMLCanvasElement | null, name: string) {
  canvas?.toBlob((b) => b && download(name, b, "image/png"));
}

/** Slice map `i` out of a stacked (k, n, n) array. */
export function sliceGrid(maps: { data: Float32Array; shape: number[] }, i: number) {
  const n = maps.shape[1];
  return maps.data.subarray(i * n * n, (i + 1) * n * n);
}
