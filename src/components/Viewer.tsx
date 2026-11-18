import { useEffect, useRef, useState } from "react";
import { engine } from "../engine/client";
import { clock, palette, SERIES, ticks, useCanvas } from "../lib/canvas";
import { useLab } from "../store";
import type { WindowData } from "../types";

const GUTTER = 58;
const TOP = 22;
const BOTTOM = 24;

type Chunk = WindowData & { mode: string; rev: number };

const isBad = (d: string) => d.toUpperCase().startsWith("BAD");

// event markers avoid the colours used for the original-signal overlay and for bad data
const EVENT_COLORS = [SERIES[2], SERIES[4], SERIES[5], SERIES[0], SERIES[7]];

function eventColor(description: string, all: string[]) {
  const i = Math.max(0, all.indexOf(description));
  return EVENT_COLORS[i % EVENT_COLORS.length];
}

export function Viewer({ mode = "data" }: { mode?: "data" | "ica" }) {
  const info = useLab((s) => s.info)!;
  const view = useLab((s) => s.view);
  const rev = useLab((s) => s.rev);
  const theme = useLab((s) => s.theme);
  const ica = useLab((s) => s.ica);
  const setView = useLab((s) => s.setView);
  const toggleBad = useLab((s) => s.toggleBad);
  const annotate = useLab((s) => s.annotate);

  const chunk = useRef<Chunk | null>(null);
  const token = useRef(0);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x0: number; t0: number; x: number; brushing: boolean } | null>(null);
  const [width, setWidth] = useState(0);

  const rows =
    mode === "ica"
      ? Array.from({ length: ica?.n ?? 0 }, (_, i) => ({ name: `IC ${i + 1}`, type: "ica", bad: !!ica?.exclude.includes(i) }))
      : info.channels;
  const eventNames = Object.keys(info.event_counts).filter((d) => !isBad(d));

  const { ref, redraw } = useCanvas(
    (ctx, w, h) => {
      const p = palette();
      const plotW = w - GUTTER;
      const plotH = h - TOP - BOTTOM;
      const rowH = plotH / Math.max(1, rows.length);
      const { t0, span } = view;
      const xOf = (t: number) => GUTTER + ((t - t0) / span) * plotW;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = p.bg;
      ctx.fillRect(0, 0, w, h);

      // time grid
      const tk = ticks(t0, t0 + span, Math.max(4, plotW / 110));
      ctx.lineWidth = 1;
      ctx.strokeStyle = p.grid;
      ctx.beginPath();
      for (const t of tk.values) {
        const x = Math.round(xOf(t)) + 0.5;
        ctx.moveTo(x, TOP);
        ctx.lineTo(x, TOP + plotH);
      }
      ctx.stroke();

      // annotations
      ctx.save();
      ctx.beginPath();
      ctx.rect(GUTTER, 0, plotW, h);
      ctx.clip();
      ctx.font = `10px ${p.mono}`;
      ctx.textBaseline = "middle";
      for (const a of info.annotations) {
        if (a.onset + a.duration < t0 || a.onset > t0 + span) continue;
        const x = xOf(a.onset);
        if (isBad(a.description)) {
          ctx.fillStyle = p.danger + "26";
          ctx.fillRect(x, TOP, Math.max(2, (a.duration / span) * plotW), plotH);
          ctx.fillStyle = p.danger;
          ctx.fillRect(x, TOP, Math.max(2, (a.duration / span) * plotW), 2);
        } else {
          const col = eventColor(a.description, eventNames);
          ctx.strokeStyle = col + "aa";
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, TOP - 4);
          ctx.lineTo(Math.round(x) + 0.5, TOP + plotH);
          ctx.stroke();
          if (span <= 40) {
            ctx.fillStyle = col;
            ctx.fillText(a.description.slice(0, 12), x + 3, 9);
          }
        }
      }

      // traces
      const c = chunk.current;
      if (c && c.mode === mode && c.data.shape[0] === rows.length) {
        const drawSet = (
          data: Float32Array, nRows: number, nPts: number, minmax: boolean, rowIndex: (r: number) => number,
          color: (r: number) => string, alpha: (r: number) => number,
        ) => {
          const dur = c.t1 - c.t0;
          const cols = minmax ? nPts / 2 : nPts;
          const tOf = (j: number) => c.t0 + ((minmax ? Math.floor(j / 2) + 0.5 : j) / cols) * dur;
          let j0 = 0;
          let j1 = nPts;
          const per = (minmax ? 2 : 1) * (cols / dur);
          j0 = Math.max(0, Math.floor((t0 - c.t0) * per) - 2);
          j1 = Math.min(nPts, Math.ceil((t0 + span - c.t0) * per) + 2);
          if (j1 - j0 < 2) return;
          for (let r = 0; r < nRows; r++) {
            const row = rowIndex(r);
            if (row < 0) continue;
            const off = r * nPts;
            let mean = 0;
            let lo = Infinity;
            let hi = -Infinity;
            for (let j = j0; j < j1; j++) {
              const v = data[off + j];
              mean += v;
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
            mean /= j1 - j0;
            const type = rows[row].type;
            const gain =
              type === "eeg"
                ? (rowH / view.uvPerRow) * 1e6
                : ((rowH * 0.8) / (hi - lo || 1)) * (80 / view.uvPerRow) * (type === "ica" ? 1.6 : 1);
            const yc = TOP + rowH * (row + 0.5);
            ctx.globalAlpha = alpha(row);
            ctx.strokeStyle = color(row);
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let j = j0; j < j1; j++) {
              const x = xOf(tOf(j));
              const y = yc - (data[off + j] - mean) * gain;
              if (j === j0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        };
        if (c.compare && c.compare_names && mode === "data") {
          const names = c.compare_names;
          const index = names.map((n) => rows.findIndex((r) => r.name === n));
          drawSet(c.compare.data, c.compare.shape[0], c.compare.shape[1], !!c.compare_minmax, (r) => index[r], () => p.amber, () => 0.6);
        }
        drawSet(
          c.data.data, c.data.shape[0], c.data.shape[1], c.minmax, (r) => r,
          (r) => (rows[r].bad ? p.danger : rows[r].type === "eeg" || rows[r].type === "ica" ? p.trace : p.accent),
          (r) => (rows[r].bad ? 0.45 : 1),
        );
      }

      // brush
      const d = drag.current;
      if (d?.brushing) {
        ctx.fillStyle = p.danger + "33";
        ctx.fillRect(Math.min(d.x0, d.x), TOP, Math.abs(d.x - d.x0), plotH);
      }
      // cursor
      const hv = hover.current;
      if (hv && hv.x > GUTTER && !d) {
        ctx.strokeStyle = p.accent;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hv.x + 0.5, TOP);
        ctx.lineTo(hv.x + 0.5, TOP + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        const label = `${(t0 + ((hv.x - GUTTER) / plotW) * span).toFixed(3)} s`;
        ctx.font = `11px ${p.mono}`;
        const tw = ctx.measureText(label).width + 10;
        const lx = Math.min(w - tw - 2, hv.x + 6);
        ctx.fillStyle = p.accent;
        ctx.fillRect(lx, TOP + plotH - 18, tw, 16);
        ctx.fillStyle = p.bg;
        ctx.fillText(label, lx + 5, TOP + plotH - 9);
      }
      ctx.restore();

      // gutter
      ctx.fillStyle = p.panel;
      ctx.fillRect(0, 0, GUTTER, h);
      ctx.strokeStyle = p.line;
      ctx.beginPath();
      ctx.moveTo(GUTTER + 0.5, 0);
      ctx.lineTo(GUTTER + 0.5, h);
      ctx.stroke();
      const fs = Math.max(8, Math.min(11, rowH - 1));
      ctx.font = `${fs}px ${p.mono}`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const skip = Math.ceil(9 / Math.max(1, rowH));
      rows.forEach((r, i) => {
        if (i % skip) return;
        const y = TOP + rowH * (i + 0.5);
        const hot = hv && hv.x <= GUTTER && Math.abs(hv.y - y) < rowH / 2;
        ctx.fillStyle = r.bad ? p.danger : hot ? p.accent : r.type === "eeg" || r.type === "ica" ? p.text : p.muted;
        ctx.fillText(r.name.slice(0, 7), GUTTER - 8, y);
        if (r.bad) {
          const tw = ctx.measureText(r.name.slice(0, 7)).width;
          ctx.fillRect(GUTTER - 8 - tw, y, tw, 1);
        }
      });

      // time axis
      ctx.fillStyle = p.panel;
      ctx.fillRect(GUTTER + 1, TOP + plotH, plotW, BOTTOM);
      ctx.strokeStyle = p.line;
      ctx.beginPath();
      ctx.moveTo(GUTTER, TOP + plotH + 0.5);
      ctx.lineTo(w, TOP + plotH + 0.5);
      ctx.stroke();
      ctx.font = `10px ${p.mono}`;
      ctx.textAlign = "center";
      ctx.fillStyle = p.muted;
      for (const t of tk.values) {
        const x = xOf(t);
        if (x < GUTTER + 14 || x > w - 14) continue;
        ctx.fillText(span > 90 ? clock(t) : `${+t.toFixed(3)} s`, x, TOP + plotH + 13);
      }

      // amplitude scale bar
      if (rows.some((r) => r.type === "eeg") && mode === "data") {
        const bar = Math.min(rowH, 60);
        const uv = (bar / rowH) * view.uvPerRow;
        const x = w - 16;
        ctx.strokeStyle = p.text;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, TOP + 8);
        ctx.lineTo(x, TOP + 8 + bar);
        ctx.stroke();
        ctx.textAlign = "right";
        ctx.fillStyle = p.text;
        ctx.font = `10px ${p.mono}`;
        ctx.fillText(`${Math.round(uv)} µV`, x - 6, TOP + 8 + bar / 2);
      }
      ctx.textAlign = "left";
      if (width !== w) setWidth(w);
    },
    [info, view, theme, mode, rows.length, ica?.exclude.join(",")],
  );

  // fetch data around the visible window
  useEffect(() => {
    if (!width || (mode === "ica" && !ica)) return;
    const mine = ++token.current;
    const pad = view.span * 0.5;
    const timer = setTimeout(
      () => {
        engine
          .call<WindowData>("window", {
            t0: view.t0 - pad,
            t1: view.t0 + view.span + pad,
            px: Math.round((width - GUTTER) * 2),
            compare: view.compare && mode === "data",
            mode,
          })
          .then((res) => {
            if (mine !== token.current) return;
            chunk.current = { ...res, mode, rev };
            redraw();
          })
          .catch(() => undefined);
      },
      chunk.current && chunk.current.rev === rev ? 30 : 0,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.t0, view.span, view.compare, rev, mode, width, ica?.n]);

  const clampT = (t: number, span = view.span) => Math.max(0, Math.min(Math.max(0, info.duration - span), t));

  // wheel: pan, or zoom with ctrl
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = useLab.getState().view;
      const plotW = c.clientWidth - GUTTER;
      if (e.ctrlKey || e.metaKey) {
        const frac = Math.max(0, Math.min(1, (e.offsetX - GUTTER) / plotW));
        const span = Math.max(0.5, Math.min(info.duration, s.span * Math.exp(e.deltaY * 0.0022)));
        const anchor = s.t0 + frac * s.span;
        setView({ span, t0: Math.max(0, Math.min(Math.max(0, info.duration - span), anchor - frac * span)) });
      } else {
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setView({ t0: Math.max(0, Math.min(Math.max(0, info.duration - s.span), s.t0 + (delta / plotW) * s.span)) });
      }
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.duration]);

  const rowAt = (y: number, h: number) => Math.floor(((y - TOP) / (h - TOP - BOTTOM)) * rows.length);

  return (
    <canvas
      ref={ref}
      className={`viewer ${view.annotate && mode === "data" ? "brush" : ""}`}
      tabIndex={0}
      aria-label="EEG signal viewer. Arrow keys scroll, plus and minus change amplitude."
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - r.left;
        hover.current = { x, y: e.clientY - r.top };
        const d = drag.current;
        if (d) {
          d.x = x;
          if (!d.brushing) setView({ t0: clampT(d.t0 - ((x - d.x0) / (r.width - GUTTER)) * view.span) });
        }
        e.currentTarget.style.cursor = x <= GUTTER && mode === "data" ? "pointer" : "";
        redraw();
      }}
      onPointerLeave={() => {
        hover.current = null;
        redraw();
      }}
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        if (x <= GUTTER) {
          const row = rows[rowAt(y, r.height)];
          if (mode === "data" && row && row.type === "eeg") void toggleBad(row.name);
          return;
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x0: x, x, t0: view.t0, brushing: view.annotate && mode === "data" };
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        const r = e.currentTarget.getBoundingClientRect();
        const tOf = (x: number) => view.t0 + ((x - GUTTER) / (r.width - GUTTER)) * view.span;
        if (d.brushing) {
          const a = tOf(Math.min(d.x0, d.x));
          const b = tOf(Math.max(d.x0, d.x));
          if (Math.abs(d.x - d.x0) > 4) void annotate("add", Math.max(0, a), b - Math.max(0, a), "BAD_segment");
          else {
            const hit = info.annotations.find((n) => isBad(n.description) && a >= n.onset && a <= n.onset + n.duration);
            if (hit) void annotate("remove", hit.onset, hit.duration, hit.description);
          }
        }
        redraw();
      }}
      onKeyDown={(e) => {
        const k = e.key;
        if (k === "ArrowRight") setView({ t0: clampT(view.t0 + view.span * (e.shiftKey ? 1 : 0.5)) });
        else if (k === "ArrowLeft") setView({ t0: clampT(view.t0 - view.span * (e.shiftKey ? 1 : 0.5)) });
        else if (k === "ArrowUp" || k === "+" || k === "=") setView({ uvPerRow: Math.max(5, view.uvPerRow / 1.25) });
        else if (k === "ArrowDown" || k === "-") setView({ uvPerRow: Math.min(2000, view.uvPerRow * 1.25) });
        else if (k === "Home") setView({ t0: 0 });
        else if (k === "End") setView({ t0: clampT(info.duration) });
        else return;
        e.preventDefault();
      }}
    />
  );
}

/** Whole-recording strip: activity envelope, events, and the visible window. */
export function Overview() {
  const info = useLab((s) => s.info)!;
  const view = useLab((s) => s.view);
  const rev = useLab((s) => s.rev);
  const theme = useLab((s) => s.theme);
  const setView = useLab((s) => s.setView);
  const env = useRef<Float32Array | null>(null);
  const down = useRef(false);

  const { ref, redraw } = useCanvas(
    (ctx, w, h) => {
      const p = palette();
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = p.panel;
      ctx.fillRect(0, 0, w, h);
      const e = env.current;
      if (e) {
        const sorted = Float32Array.from(e).sort();
        const top = sorted[Math.floor(sorted.length * 0.98)] || 1;
        ctx.fillStyle = p.muted + "66";
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let i = 0; i < e.length; i++) ctx.lineTo((i / (e.length - 1)) * w, h - Math.min(1, e[i] / top) * (h - 6));
        ctx.lineTo(w, h);
        ctx.fill();
      }
      for (const a of info.annotations) {
        const x = (a.onset / info.duration) * w;
        if (isBad(a.description)) {
          ctx.fillStyle = p.danger + "88";
          ctx.fillRect(x, 0, Math.max(1, (a.duration / info.duration) * w), h);
        } else {
          ctx.fillStyle = p.amber + "66";
          ctx.fillRect(x, 0, 1, 4);
        }
      }
      const x0 = (view.t0 / info.duration) * w;
      const ww = Math.max(3, (view.span / info.duration) * w);
      ctx.fillStyle = p.accent + "33";
      ctx.fillRect(x0, 0, ww, h);
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0 + 0.75, 0.75, ww - 1.5, h - 1.5);
    },
    [info, view.t0, view.span, theme],
  );

  useEffect(() => {
    engine
      .call<{ env: { data: Float32Array } }>("overview", { bins: 600 })
      .then((r) => {
        env.current = r.env.data;
        redraw();
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  const seek = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * info.duration - view.span / 2;
    setView({ t0: Math.max(0, Math.min(Math.max(0, info.duration - view.span), t)) });
  };

  return (
    <canvas
      ref={ref}
      className="overview"
      aria-label="Recording overview. Click to jump."
      onPointerDown={(e) => {
        down.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seek(e);
      }}
      onPointerMove={(e) => down.current && seek(e)}
      onPointerUp={() => (down.current = false)}
    />
  );
}
