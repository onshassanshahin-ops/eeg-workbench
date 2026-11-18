import { Download, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { engine } from "../engine/client";
import { download, palette, savePng, SERIES, sliceGrid } from "../lib/canvas";
import { useLab, type ErpConfig } from "../store";
import { Plot, Topomap, type Series } from "./charts";

type Maps = { maps: { data: Float32Array; shape: number[] }; times: number[] };
type Row = { channel: string; peak_uv: number; latency_ms: number; mean_uv: number };

const isBad = (d: string) => d.toUpperCase().startsWith("BAD");

export function ErpTab() {
  const info = useLab((s) => s.info)!;
  const erp = useLab((s) => s.erp);
  const erpRev = useLab((s) => s.erpRev);
  const erpCfg = useLab((s) => s.erpCfg);
  const rev = useLab((s) => s.rev);
  const busy = useLab((s) => s.busy);
  const computeErp = useLab((s) => s.computeErp);

  const events = Object.entries(info.event_counts).filter(([d]) => !isBad(d));
  const [chosen, setChosen] = useState<string[]>(() => erpCfg?.conditions ?? events.slice(0, 4).map(([d]) => d));
  const [tmin, setTmin] = useState(erpCfg ? erpCfg.tmin * 1000 : -200);
  const [tmax, setTmax] = useState(erpCfg ? erpCfg.tmax * 1000 : 800);
  const [useBase, setUseBase] = useState(erpCfg ? erpCfg.baseline !== null : true);
  const [reject, setReject] = useState<number | null>(erpCfg ? erpCfg.reject_uv : 150);

  const cfg = (): ErpConfig => ({
    conditions: chosen.filter((c) => c in info.event_counts),
    tmin: tmin / 1000,
    tmax: tmax / 1000,
    baseline: useBase && tmin < 0 ? [tmin / 1000, 0] : null,
    reject_uv: reject,
  });

  // keep results in step with the data when the pipeline changes
  useEffect(() => {
    if (erpCfg && erpRev !== rev && !busy) void computeErp(erpCfg);
  }, [erpCfg, erpRev, rev, busy, computeErp]);

  const fresh = erp && erpRev === rev;

  return (
    <div className="split">
      <section className="main-col scroll">
        {!events.length ? (
          <div className="empty">
            <h2>No events in this recording</h2>
            <p>Evoked responses are averages around repeated events, such as stimuli or button presses. This file has no event markers, so there is nothing to average.</p>
          </div>
        ) : fresh ? (
          <Results />
        ) : (
          <div className="empty">
            <h2>Find the brain's response to events</h2>
            <p>
              Lab cuts the recording into short pieces around each event and averages them. Random activity cancels
              out and the response that repeats every time remains. Choose the event types on the right and press
              Average.
            </p>
          </div>
        )}
      </section>
      <aside className="side">
        <header className="side-head"><h2>Epochs</h2></header>
        <form className="form flat" onSubmit={(e) => { e.preventDefault(); void computeErp(cfg()); }}>
          <div className="field">
            <span>Event types</span>
            <div className="checks">
              {events.map(([d, n]) => (
                <label key={d} className="check">
                  <input type="checkbox" checked={chosen.includes(d)} onChange={(e) => setChosen(e.target.checked ? [...chosen, d] : chosen.filter((c) => c !== d))} />
                  <i style={{ background: chosen.includes(d) ? SERIES[chosen.indexOf(d) % SERIES.length] : "var(--line)" }} />
                  <span>{d}</span><em>{n}</em>
                </label>
              ))}
            </div>
          </div>
          <div className="pair">
            <label className="field"><span>From</span>
              <div className="input-unit"><input type="number" value={tmin} step={50} onChange={(e) => setTmin(Number(e.target.value))} /><em>ms</em></div>
            </label>
            <label className="field"><span>To</span>
              <div className="input-unit"><input type="number" value={tmax} step={50} onChange={(e) => setTmax(Number(e.target.value))} /><em>ms</em></div>
            </label>
          </div>
          <label className="field check">
            <input type="checkbox" checked={useBase} onChange={(e) => setUseBase(e.target.checked)} />
            <span>Baseline-correct using the time before the event</span>
          </label>
          <label className="field"><span>Reject epochs larger than</span>
            <div className="input-unit">
              <input type="number" value={reject ?? ""} placeholder="off" step={10} onChange={(e) => setReject(e.target.value === "" ? null : Number(e.target.value))} /><em>µV</em>
            </div>
          </label>
          <p className="explain">Epochs with a peak-to-peak swing above this limit are left out, which removes trials spoiled by blinks or movement. Stretches marked bad are skipped too.</p>
          <button className="btn primary wide" type="submit" disabled={!!busy || !chosen.length || tmax <= tmin} data-tour="average">
            <Play size={14} /> Average
          </button>
        </form>
      </aside>
    </div>
  );
}

function Results() {
  const erp = useLab((s) => s.erp)!;
  const info = useLab((s) => s.info)!;
  const nc = erp.conditions.length;
  const [, nch, nt] = erp.evoked.shape;
  const times = useMemo(() => erp.times.data.map((t) => t * 1000), [erp]);
  // with two event types, also offer their difference: the rarer one minus the more common one
  const views = useMemo(() => {
    if (nc !== 2) return erp.conditions;
    const [a, b] = erp.conditions;
    const [rare, common] = erp.found[a] <= erp.found[b] ? [a, b] : [b, a];
    return [...erp.conditions, `${rare} - ${common}`];
  }, [erp, nc]);

  const [channel, setChannel] = useState(() => ["Pz", "Cz", "Fz"].find((c) => erp.names.includes(c)) ?? erp.names[0]);
  const [which, setWhich] = useState(views[views.length - 1]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number>(() => Math.min(times[nt - 1], 300));
  const [live, setLive] = useState<Maps | null>(null);
  const [strip, setStrip] = useState<Maps | null>(null);
  const [win, setWin] = useState<[number, number]>([250, 500]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const figA = useRef<HTMLCanvasElement | null>(null);
  const figB = useRef<HTMLCanvasElement | null>(null);
  const view = views.includes(which) ? which : views[0];
  const ch = Math.max(0, erp.names.indexOf(channel));

  const wave = (cond: string, c: number) => {
    const y = new Float32Array(nt);
    const at = (name: string) => erp.conditions.indexOf(name) * nch * nt + c * nt;
    if (cond.includes(" - ")) {
      const [a, b] = cond.split(" - ");
      for (let i = 0; i < nt; i++) y[i] = erp.evoked.data[at(a) + i] - erp.evoked.data[at(b) + i];
    } else y.set(erp.evoked.data.subarray(at(cond), at(cond) + nt));
    return y;
  };

  const compare = useMemo<Series[]>(() => {
    const out: Series[] = erp.conditions.map((c, i) => ({ x: times, y: wave(c, ch), color: SERIES[i % SERIES.length], width: 2, label: `${c} (${erp.kept[c]})` }));
    if (nc === 2) out.push({ x: times, y: wave(views[2], ch), color: palette().text, width: 1.6, dash: [5, 4], label: "difference" });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erp, ch]);

  const butterfly = useMemo<Series[]>(() => {
    const out: Series[] = [];
    const gfp = new Float32Array(nt);
    const all: Float32Array[] = [];
    for (let c = 0; c < nch; c++) all.push(wave(view, c));
    for (let i = 0; i < nt; i++) {
      let m = 0;
      for (let c = 0; c < nch; c++) m += all[c][i] / nch;
      let v = 0;
      for (let c = 0; c < nch; c++) v += (all[c][i] - m) ** 2 / nch;
      gfp[i] = Math.sqrt(v);
    }
    all.forEach((y) => out.push({ x: times, y, alpha: 0.45, width: 1 }));
    out.push({ x: times, y: gfp, color: palette().accent, width: 2.4, label: "Global field power" });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erp, view]);

  const shown = cursor ?? pinned;
  useEffect(() => {
    if (!erp.has_maps) return;
    let live_ = true;
    const t = setTimeout(() => {
      engine.call<Maps>("evoked_maps", { condition: view, times: [shown / 1000] }).then((r) => live_ && setLive(r)).catch(() => undefined);
    }, 25);
    return () => { live_ = false; clearTimeout(t); };
  }, [erp, view, shown]);

  useEffect(() => {
    if (!erp.has_maps) return;
    const t0 = Math.max(0, times[0]);
    const t1 = times[nt - 1];
    const n = 6;
    const list = Array.from({ length: n }, (_, i) => Math.round((t0 + ((i + 0.5) / n) * (t1 - t0)) / 10) * 10);
    engine.call<Maps>("evoked_maps", { condition: view, times: list.map((t) => t / 1000), avg: 0.02 }).then(setStrip).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erp, view]);

  useEffect(() => {
    engine.call<{ rows: Row[] }>("evoked_measure", { condition: view, tmin: win[0] / 1000, tmax: win[1] / 1000, mode: "abs" })
      .then((r) => setRows([...r.rows].sort((a, b) => Math.abs(b.peak_uv) - Math.abs(a.peak_uv))))
      .catch(() => setRows(null));
  }, [erp, view, win]);

  const stripRange = useMemo<[number, number] | undefined>(() => {
    if (!strip) return undefined;
    let m = 0;
    for (const v of strip.maps.data) if (!Number.isNaN(v) && Math.abs(v) > m) m = Math.abs(v);
    return [-m, m];
  }, [strip]);
  const pos = erp.names.map((n) => info.channels.find((c) => c.name === n)?.pos ?? null);
  const label = (v: string) => v.replace(" - ", " − ");

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Evoked responses</h2>
          <p>{erp.conditions.map((c) => `${c}: ${erp.kept[c]} of ${erp.found[c]} epochs kept`).join(" · ")}</p>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={() => savePng(figA.current, "evoked_comparison.png")}><Download size={14} /> Comparison</button>
          <button className="btn ghost" onClick={() => savePng(figB.current, "evoked_all_channels.png")}><Download size={14} /> All channels</button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Compare event types</h3>
          <label className="tool"><span>Channel</span>
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>{erp.names.map((n) => <option key={n}>{n}</option>)}</select>
          </label>
        </div>
        <Plot series={compare} xLabel="Time after the event (ms)" yLabel="Amplitude (µV)" zero height={250} canvasRef={(c) => (figA.current = c)} />
      </div>

      <div className="card">
        <div className="card-head">
          <h3>All channels</h3>
          <label className="tool"><span>Show</span>
            <select value={view} onChange={(e) => setWhich(e.target.value)}>{views.map((v) => <option key={v} value={v}>{label(v)}</option>)}</select>
          </label>
        </div>
        <div className="erp-row">
          <div className="grow">
            <Plot series={butterfly} xLabel="Time after the event (ms)" yLabel="Amplitude (µV)" zero height={280}
              cursor={shown} onCursor={setCursor} onPick={setPinned} canvasRef={(c) => (figB.current = c)} />
          </div>
          {erp.has_maps && (
            <div className="live-map">
              {live && <Topomap grid={sliceGrid(live.maps, 0)} n={live.maps.shape[1]} size={190} points={pos} />}
              <b>{Math.round(shown)} ms</b>
              <span>Move over the plot · click to pin</span>
            </div>
          )}
        </div>
        {strip && (
          <div className="strip">
            {strip.times.map((t, i) => (
              <button key={t} className="strip-item" onClick={() => setPinned(t * 1000)} title="Pin this time">
                <Topomap grid={sliceGrid(strip.maps, i)} n={strip.maps.shape[1]} size={96} range={stripRange} />
                <span>{Math.round(t * 1000)} ms</span>
              </button>
            ))}
            {stripRange && <span className="strip-scale">±{stripRange[1].toFixed(1)} µV<br />blue − · red +</span>}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Peak in a time window</h3>
          <div className="row">
            <label className="tool"><span>From</span><input type="number" value={win[0]} step={10} onChange={(e) => setWin([Number(e.target.value), win[1]])} /></label>
            <label className="tool"><span>to</span><input type="number" value={win[1]} step={10} onChange={(e) => setWin([win[0], Number(e.target.value)])} /></label>
            <span className="meta">ms · {label(view)}</span>
            {rows && (
              <button className="btn ghost" onClick={() => download("erp_peaks.csv", ["channel,peak_uV,latency_ms,mean_uV", ...rows.map((r) => `${r.channel},${r.peak_uv.toFixed(3)},${r.latency_ms.toFixed(1)},${r.mean_uv.toFixed(3)}`)].join("\n"), "text/csv")}>
                <Download size={14} /> CSV
              </button>
            )}
          </div>
        </div>
        {rows ? (
          <table className="table">
            <thead><tr><th>Channel</th><th>Peak (µV)</th><th>Latency (ms)</th><th>Mean in window (µV)</th></tr></thead>
            <tbody>
              {rows.slice(0, 8).map((r) => (
                <tr key={r.channel}><td>{r.channel}</td><td>{r.peak_uv.toFixed(2)}</td><td>{r.latency_ms.toFixed(0)}</td><td>{r.mean_uv.toFixed(2)}</td></tr>
              ))}
            </tbody>
          </table>
        ) : <p className="hint">Choose a window inside the epoch.</p>}
        <p className="foot">The eight channels with the largest peak are shown. The CSV has every channel.</p>
      </div>
    </div>
  );
}
