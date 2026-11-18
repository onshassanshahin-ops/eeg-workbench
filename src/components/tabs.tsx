import { Check, Download, GitCompareArrows, Minus, PenLine, Plus, Sparkles, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { engine } from "../engine/client";
import { download, palette, savePng, sliceGrid, useCanvas } from "../lib/canvas";
import { STEP_DEFS } from "../steps";
import { useLab } from "../store";
import type { TfrResult } from "../types";
import { Heatmap, Plot, Topomap, type Series } from "./charts";
import { PipelinePanel } from "./PipelinePanel";
import { Overview, Viewer } from "./Viewer";

const SPANS = [2, 5, 10, 20, 30, 60, 120];

export function SignalTab() {
  const view = useLab((s) => s.view);
  const info = useLab((s) => s.info)!;
  const steps = useLab((s) => s.steps);
  const setView = useLab((s) => s.setView);
  const bads = info.channels.filter((c) => c.bad).length;

  return (
    <div className="split">
      <section className="main-col">
        <div className="toolbar" data-tour="toolbar">
          <label className="tool">
            <span>Window</span>
            <select value={SPANS.includes(view.span) ? view.span : ""} onChange={(e) => setView({ span: Math.min(info.duration, Number(e.target.value)) })}>
              {!SPANS.includes(view.span) && <option value="">{view.span.toFixed(1)} s</option>}
              {SPANS.map((s) => <option key={s} value={s}>{s} s</option>)}
            </select>
          </label>
          <div className="tool">
            <span>Amplitude</span>
            <div className="stepper">
              <button title="Smaller traces" onClick={() => setView({ uvPerRow: Math.min(2000, view.uvPerRow * 1.25) })}><Minus size={13} /></button>
              <output>{Math.round(view.uvPerRow)} µV</output>
              <button title="Larger traces" onClick={() => setView({ uvPerRow: Math.max(5, view.uvPerRow / 1.25) })}><Plus size={13} /></button>
            </div>
          </div>
          <button className={`toggle ${view.compare ? "on" : ""}`} disabled={!steps.some((s) => s.enabled)} onClick={() => setView({ compare: !view.compare })} title="Draw the original signal underneath in amber">
            <GitCompareArrows size={14} /> Compare with original
          </button>
          <button className={`toggle ${view.annotate ? "on" : ""}`} onClick={() => setView({ annotate: !view.annotate })} title="Drag across the signal to mark a stretch as bad. Click a marked stretch to remove it.">
            <PenLine size={14} /> Mark bad segments
          </button>
          <button className="btn ghost square" title="Save the current view as an image" aria-label="Save the current view as an image" onClick={() => savePng(document.querySelector<HTMLCanvasElement>("canvas.viewer"), "signal.png")}>
            <Download size={14} />
          </button>
          <span className="meta fill">{bads ? `${bads} bad channel${bads > 1 ? "s" : ""} · ` : ""}Click a channel name to mark it bad</span>
        </div>
        <div className="viewer-wrap" data-tour="viewer"><Viewer /></div>
        <Overview />
      </section>
      <PipelinePanel />
    </div>
  );
}

/* ----------------------------------------------------------------------- */

function Spark({ x, y, color }: { x: Float32Array; y: Float32Array; color?: string }) {
  const theme = useLab((s) => s.theme);
  const { ref } = useCanvas(
    (ctx, w, h) => {
      const p = palette();
      ctx.clearRect(0, 0, w, h);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < y.length; i++) { if (y[i] < lo) lo = y[i]; if (y[i] > hi) hi = y[i]; }
      ctx.strokeStyle = color ?? p.muted;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      const x0 = x[0], x1 = x[x.length - 1];
      for (let i = 0; i < y.length; i++) {
        const px = ((x[i] - x0) / (x1 - x0)) * w;
        const py = h - 2 - ((y[i] - lo) / (hi - lo || 1)) * (h - 4);
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.stroke();
    },
    [x, y, theme, color],
  );
  return <canvas ref={ref} className="spark" />;
}

const KIND: Record<string, string> = { eye: "Eye movement", muscle: "Muscle", heart: "Heartbeat" };

export function ComponentsTab() {
  const info = useLab((s) => s.info)!;
  const ica = useLab((s) => s.ica);
  const steps = useLab((s) => s.steps);
  const busy = useLab((s) => s.busy);
  const { addStep, updateStep } = useLab.getState();
  const step = steps.find((s) => s.type === "ica" && s.enabled);

  const spectra = useMemo(() => {
    if (!ica?.fitted) return [];
    const nf = ica.freqs.data.length;
    const keep: number[] = [];
    for (let i = 0; i < nf; i++) if (ica.freqs.data[i] >= 1 && ica.freqs.data[i] <= 45) keep.push(i);
    const fx = Float32Array.from(keep, (i) => ica.freqs.data[i]);
    return Array.from({ length: ica.n }, (_, c) => ({ x: fx, y: Float32Array.from(keep, (i) => Math.log10(ica.psd.data[c * nf + i] + 1e-30)) }));
  }, [ica]);

  if (!step || !ica?.fitted) {
    const filtered = info.highpass >= 1;
    return (
      <div className="empty">
        <Sparkles size={30} />
        <h2>Separate the signal into components</h2>
        <p>
          Independent component analysis splits the recording into separate sources. Eye blinks, muscle tension and
          heartbeat usually end up in a few of them. You review each one and remove the artifacts, keeping the rest of
          the data intact.
        </p>
        {!filtered && <p className="tip"><span>Tip: add a 1 Hz high-pass filter first. Lab will filter a temporary copy for you if you skip this.</span></p>}
        <button className="btn primary" disabled={!!busy} data-tour="run-ica" onClick={() => void addStep("ica", STEP_DEFS.ica.defaults(info), STEP_DEFS.ica.verb)}>
          <Wand2 size={15} /> Run ICA
        </button>
      </div>
    );
  }

  const exclude = ica.exclude;
  const setExclude = (next: number[]) =>
    void updateStep(step.id, { ...step.params, exclude: [...next].sort((a, b) => a - b) }, "Rebuilding the signal");
  const suggested = Object.keys(ica.suggest).map(Number);
  const pending = suggested.filter((i) => !exclude.includes(i));

  return (
    <div className="comp-layout">
      <div className="comp-head">
        <div>
          <h2>Components</h2>
          <p>Click a component to remove it from the signal. Click again to put it back. {exclude.length ? `${exclude.length} removed.` : "None removed yet."}</p>
        </div>
        <div className="row">
          {pending.length > 0 && (
            <button className="btn primary" disabled={!!busy} data-tour="remove-suggested" onClick={() => setExclude([...exclude, ...pending])}>
              <Wand2 size={14} /> Remove {pending.length} suggested
            </button>
          )}
          {exclude.length > 0 && <button className="btn ghost" disabled={!!busy} onClick={() => setExclude([])}>Keep all</button>}
        </div>
      </div>
      <div className="comp-grid">
        {Array.from({ length: ica.n }, (_, i) => {
          const off = exclude.includes(i);
          const kind = ica.suggest[String(i)];
          return (
            <button key={i} className={`comp ${off ? "off" : ""}`} disabled={!!busy} onClick={() => setExclude(off ? exclude.filter((x) => x !== i) : [...exclude, i])} title={off ? "Removed — click to keep" : "Click to remove"}>
              <div className="comp-top">
                <b>IC {i + 1}</b>
                <span>{(ica.var.data[i] * 100).toFixed(1)}%</span>
              </div>
              {ica.maps ? <Topomap grid={sliceGrid(ica.maps, i)} n={ica.maps.shape[1]} size={104} dim={off} /> : <div className="nomap">no positions</div>}
              {spectra[i] && <Spark x={spectra[i].x} y={spectra[i].y} />}
              <div className="comp-foot">
                {kind ? <span className={`tag ${kind}`}>{KIND[kind] ?? kind}</span> : <span className="tag none">Brain or mixed</span>}
                {off && <span className="tag removed"><Check size={11} /> removed</span>}
              </div>
            </button>
          );
        })}
      </div>
      <div className="comp-traces">
        <div className="toolbar slim"><span className="meta">Component time courses · scroll with the wheel, drag to pan</span></div>
        <div className="viewer-wrap"><Viewer mode="ica" /></div>
        <Overview />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- */

export function SpectrumTab() {
  const psd = useLab((s) => s.psd);
  const psdRev = useLab((s) => s.psdRev);
  const rev = useLab((s) => s.rev);
  const info = useLab((s) => s.info)!;
  const computePsd = useLab((s) => s.computePsd);
  const fig = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (psdRev !== rev) void computePsd();
  }, [psdRev, rev, computePsd]);

  const series = useMemo<Series[]>(() => {
    if (!psd) return [];
    const nf = psd.freqs.data.length;
    const nch = psd.names.length;
    const mean = new Float32Array(nf);
    const out: Series[] = [];
    for (let c = 0; c < nch; c++) {
      const y = new Float32Array(nf);
      for (let i = 0; i < nf; i++) {
        const v = psd.psd.data[c * nf + i];
        y[i] = 10 * Math.log10(v + 1e-30);
        mean[i] += v / nch;
      }
      out.push({ x: psd.freqs.data, y, alpha: 0.32, width: 1 });
    }
    out.push({ x: psd.freqs.data, y: mean.map((v) => 10 * Math.log10(v + 1e-30)), color: palette().accent, width: 2.4, label: "Mean of all channels" });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [psd]);

  if (!psd) return <div className="empty"><p>Computing the power spectrum…</p></div>;
  const nch = psd.names.length;
  const meanOf = (arr: Float32Array, b: number) => { let s = 0; for (let c = 0; c < nch; c++) s += arr[b * nch + c]; return s / nch; };
  const pos = (psd.map_names ?? []).map((n) => info.channels.find((c) => c.name === n)?.pos ?? null);

  const csv = () => {
    const head = ["channel", ...psd.bands.flatMap((b) => [`${b.name}_abs_uV2`, `${b.name}_rel`])];
    const rows = psd.names.map((n, c) => [n, ...psd.bands.flatMap((_, b) => [psd.abs.data[b * nch + c].toFixed(4), psd.rel.data[b * nch + c].toFixed(4)])]);
    download("band_power.csv", [head, ...rows].map((r) => r.join(",")).join("\n"), "text/csv");
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Power spectrum</h2>
          <p>How strong the signal is at each frequency. Peaks show rhythms; a spike at 50 or 60 Hz is mains noise.</p>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={() => savePng(fig.current, "power_spectrum.png")}><Download size={14} /> Figure</button>
          <button className="btn ghost" onClick={csv}><Download size={14} /> Band power CSV</button>
        </div>
      </div>
      <div className="card">
        <Plot series={series} xLabel="Frequency (Hz)" yLabel="Power (dB µV²/Hz)" height={330} canvasRef={(c) => (fig.current = c)}
          shades={psd.bands.map((b) => ({ lo: b.lo, hi: b.hi, label: b.name }))} />
      </div>
      <div className="metrics">
        {psd.peak_alpha != null && <Metric label="Peak alpha frequency" value={`${psd.peak_alpha.toFixed(1)} Hz`} note="posterior channels" />}
        {psd.metrics.theta_beta_ratio != null && <Metric label="Theta / beta ratio" value={psd.metrics.theta_beta_ratio.toFixed(2)} note="mean of all channels" />}
        {psd.metrics.alpha_theta_ratio != null && <Metric label="Alpha / theta ratio" value={psd.metrics.alpha_theta_ratio.toFixed(2)} note="mean of all channels" />}
        {psd.metrics.frontal_alpha_asymmetry != null && <Metric label="Frontal alpha asymmetry" value={psd.metrics.frontal_alpha_asymmetry.toFixed(2)} note="ln(F4) − ln(F3)" />}
      </div>
      <div className="card">
        <h3>Frequency bands</h3>
        <div className="bands">
          {psd.bands.map((b, i) => (
            <div className="band" key={b.name}>
              {psd.maps && <Topomap grid={sliceGrid(psd.maps, i)} n={psd.maps.shape[1]} size={132} diverging={false} points={pos} />}
              <b>{b.name}</b>
              <span>{b.lo}–{b.hi} Hz</span>
              <span className="big">{(meanOf(psd.rel.data, i) * 100).toFixed(1)}%</span>
              <span>{meanOf(psd.abs.data, i).toFixed(2)} µV²</span>
            </div>
          ))}
        </div>
        <p className="foot">Maps show each band's share of total power (1–45 Hz) across the scalp; brighter means a larger share.</p>
      </div>
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <b>{value}</b>
      <em>{note}</em>
    </div>
  );
}

/* ----------------------------------------------------------------------- */

export function TfTab() {
  const info = useLab((s) => s.info)!;
  const erp = useLab((s) => s.erp);
  const erpRev = useLab((s) => s.erpRev);
  const rev = useLab((s) => s.rev);
  const run = useLab((s) => s.run);
  const eeg = info.channels.filter((c) => c.type === "eeg" && !c.bad).map((c) => c.name);
  const epochsOk = !!erp && erpRev === rev;
  const [channel, setChannel] = useState(() => ["Oz", "Pz", "Cz"].find((c) => eeg.includes(c)) ?? eeg[0]);
  const [condition, setCondition] = useState<string>("");
  const [res, setRes] = useState<TfrResult | null>(null);
  const fig = useRef<HTMLCanvasElement | null>(null);
  const cond = epochsOk && condition && erp.conditions.includes(condition) ? condition : "";

  useEffect(() => {
    if (!channel) return;
    let live = true;
    void run("Computing the time-frequency map", () =>
      engine.call<TfrResult>("tfr", { channel, condition: cond || null, fmin: 2, fmax: Math.min(45, info.sfreq / 2 - 1) }),
    ).then((r) => live && r && setRes(r));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, cond, rev]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Time-frequency</h2>
          <p>How the strength of each rhythm changes over time. {cond ? "Averaged over the epochs of one event type, relative to the time before the event." : "Shown for the whole recording."}</p>
        </div>
        <div className="row">
          <label className="tool"><span>Channel</span>
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>{eeg.map((c) => <option key={c}>{c}</option>)}</select>
          </label>
          <label className="tool"><span>Data</span>
            <select value={cond} onChange={(e) => setCondition(e.target.value)}>
              <option value="">Whole recording</option>
              {epochsOk && erp.conditions.map((c) => <option key={c} value={c}>Epochs: {c}</option>)}
            </select>
          </label>
          <button className="btn ghost" onClick={() => savePng(fig.current, `time_frequency_${channel}.png`)}><Download size={14} /> Figure</button>
        </div>
      </div>
      <div className="card">
        {res ? (
          <Heatmap data={res.power.data} ny={res.power.shape[0]} nx={res.power.shape[1]} x={res.times.data} y={res.freqs.data}
            diverging={res.kind === "epochs"} xLabel="Time (s)" yLabel="Frequency (Hz)" unit={res.unit} height={420} canvasRef={(c) => (fig.current = c)} />
        ) : <p className="hint">Computing…</p>}
      </div>
      {!epochsOk && <p className="hint">Create epochs in the Evoked tab to see event-related changes, averaged across trials.</p>}
    </div>
  );
}
