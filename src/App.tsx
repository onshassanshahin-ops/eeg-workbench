import {
  Activity, AudioWaveform, Code2, FolderOpen, GraduationCap, Grid3x3, Loader2, Lock, Moon, SlidersHorizontal, Sparkles, Sun, Upload, X, Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ChannelsDialog } from "./components/ChannelsDialog";
import { ErpTab } from "./components/ErpTab";
import { ExportTab } from "./components/ExportTab";
import { ComponentsTab, SignalTab, SpectrumTab, TfTab } from "./components/tabs";
import { Tour } from "./components/Tour";
import { clock } from "./lib/canvas";
import { useLab } from "./store";
import type { Tab } from "./types";

const TABS: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: "signal", label: "Signal", icon: Activity },
  { id: "components", label: "Components", icon: Sparkles },
  { id: "spectrum", label: "Spectrum", icon: AudioWaveform },
  { id: "erp", label: "Evoked", icon: Zap },
  { id: "tf", label: "Time-frequency", icon: Grid3x3 },
  { id: "export", label: "Export", icon: Code2 },
];

const collect = (list: FileList | null) => (list ? Array.from(list) : []);

export default function App() {
  const info = useLab((s) => s.info);
  const tab = useLab((s) => s.tab);
  const theme = useLab((s) => s.theme);
  const busy = useLab((s) => s.busy);
  const toast = useLab((s) => s.toast);
  const eng = useLab((s) => s.engine);
  const { boot, openFiles, openDemo, setTab, setTheme, setToast, setTour, closeRecording } = useLab.getState();
  const [dragging, setDragging] = useState(false);
  const [channels, setChannels] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => boot(), [boot]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast, setToast]);

  const startTour = async () => {
    if (!useLab.getState().info?.name.startsWith("Demo recording")) await openDemo();
    if (useLab.getState().info) setTour({ active: true, step: 0 });
  };

  return (
    <div
      className="app"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const files = collect(e.dataTransfer.files);
        if (files.length) void openFiles(files);
      }}
    >
      <input ref={picker} type="file" multiple hidden onChange={(e) => { const f = collect(e.target.files); e.target.value = ""; if (f.length) void openFiles(f); }} />

      <header className="topbar">
        <button className="brand" onClick={() => info && setTab("signal")} title="EEG Workbench">
          <Logo /> <span>EEG <b>Workbench</b></span>
        </button>
        {info && (
          <div className="rec">
            <strong title={info.name}>{info.name}</strong>
            <span>{info.channels.length} ch</span>
            <span>{info.sfreq} Hz</span>
            <span>{clock(info.duration)}</span>
            {Object.keys(info.event_counts).length > 0 && <span>{info.annotations.length} events</span>}
          </div>
        )}
        <span className="spacer" />
        {info && <button className="btn ghost" title="Channels" onClick={() => setChannels(true)} disabled={!!busy}><SlidersHorizontal size={14} /> <span className="lbl">Channels</span></button>}
        {info && <button className="btn ghost" title="Open another recording" onClick={() => picker.current?.click()}><FolderOpen size={14} /> <span className="lbl">Open</span></button>}
        <button className="btn ghost" title="Guided walkthrough" onClick={() => void startTour()} disabled={!!busy}><GraduationCap size={14} /> <span className="lbl">Walkthrough</span></button>
        {info && <button className="icon" title="Close this recording" onClick={closeRecording}><X size={16} /></button>}
        <button className="icon" title="Switch between light and dark" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>

      {info ? (
        <div className="body">
          <nav className="rail" aria-label="Workspaces">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)} data-tab={t.id}>
                <t.icon size={18} />
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
          <main className="stage" key={tab}>
            {tab === "signal" && <SignalTab />}
            {tab === "components" && <ComponentsTab />}
            {tab === "spectrum" && <SpectrumTab />}
            {tab === "erp" && <ErpTab />}
            {tab === "tf" && <TfTab />}
            {tab === "export" && <ExportTab />}
          </main>
        </div>
      ) : (
        <Welcome onPick={() => picker.current?.click()} onTour={() => void startTour()} />
      )}

      <footer className="status">
        {eng.status === "error" ? (
          <span className="bad">The analysis engine could not start: {eng.stage}</span>
        ) : busy && eng.status === "starting" ? (
          <span className="working"><Loader2 size={13} className="spin" /> {busy} — waiting for the engine ({eng.stage.toLowerCase()}, {Math.round(eng.progress * 100)}%) <i><b style={{ width: `${eng.progress * 100}%` }} /></i></span>
        ) : busy ? (
          <span className="working"><Loader2 size={13} className="spin" /> {busy}…</span>
        ) : eng.status === "starting" ? (
          <span className="working"><Loader2 size={13} className="spin" /> {eng.stage}… <i><b style={{ width: `${eng.progress * 100}%` }} /></i></span>
        ) : (
          <span>Ready</span>
        )}
        <span className="spacer" />
        <span><Lock size={11} /> Your data stays on this computer</span>
        <span>For research and education. Not a medical device.</span>
      </footer>

      {dragging && <div className="drop-veil"><Upload size={34} /><b>Drop to open</b></div>}
      {toast && (
        <div className={`toast ${toast.kind}`} role="alert">
          <span>{toast.text}</span>
          <button className="icon" onClick={() => setToast(null)}><X size={14} /></button>
        </div>
      )}
      {channels && info && <ChannelsDialog onClose={() => setChannels(false)} />}
      <Tour />
    </div>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" stroke="currentColor" strokeWidth="1.5" opacity=".35" />
      <path d="M3.5 12h3l1.6-5 2.6 10 2.3-7.5 1.5 4.5 1.2-2h4.8" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Welcome({ onPick, onTour }: { onPick: () => void; onTour: () => void }) {
  const eng = useLab((s) => s.engine);
  const busy = useLab((s) => s.busy);
  const openDemo = useLab((s) => s.openDemo);
  return (
    <div className="welcome">
      <div className="welcome-art" aria-hidden><Traces /></div>
      <section className="hero">
        <p className="eyebrow">EEG workbench in your browser</p>
        <h1>Open a recording.<br />Clean it. Understand it.<br /><em>Keep the code.</em></h1>
        <p className="lede">
          Filter, repair channels, remove blinks with ICA, average evoked responses and map them on the scalp. Every
          step becomes Python you can run anywhere. Nothing to install, and your data never leaves this computer.
        </p>
        <button className="dropzone" onClick={onPick} disabled={!!busy}>
          <Upload size={22} />
          <span><b>Drop a recording here</b> or click to choose</span>
          <em>EDF · BDF · BrainVision (.vhdr + .vmrk + .eeg) · EEGLAB (.set) · FIF · GDF</em>
        </button>
        <div className="hero-actions">
          <button className="btn primary big" onClick={() => void openDemo()} disabled={!!busy}><Activity size={16} /> Try the demo recording</button>
          <button className="btn ghost big" onClick={onTour} disabled={!!busy}><GraduationCap size={16} /> Take the 5-minute walkthrough</button>
        </div>
        {eng.status === "starting" && (
          <p className="boot"><Loader2 size={13} className="spin" /> Preparing the analysis engine ({Math.round(eng.progress * 100)}%). The first visit downloads it once; after that it starts quickly.</p>
        )}
      </section>
      <section className="features">
        {[
          ["See", "A fast viewer for long, many-channel recordings, with events, annotations and a before/after overlay."],
          ["Clean", "Filters, re-referencing, automatic bad-channel detection and repair, and ICA with suggested artifact components."],
          ["Analyse", "Power spectra and band maps, evoked responses with scalp maps and peak measures, time-frequency maps."],
          ["Reproduce", "A visible, editable pipeline with undo, exported as an MNE-Python script or Jupyter notebook."],
        ].map(([h, p]) => (
          <article key={h}><h3>{h}</h3><p>{p}</p></article>
        ))}
      </section>
    </div>
  );
}

function Traces() {
  const rows = 9;
  const path = (r: number) => {
    let d = "";
    for (let x = 0; x <= 1200; x += 6) {
      const t = x / 1200;
      const y =
        Math.sin(t * 60 + r * 1.7) * 5 * (0.4 + 0.6 * Math.sin(t * 5 + r) ** 2) +
        Math.sin(t * 13 + r * 0.6) * 4 +
        (r < 2 ? 34 * Math.exp(-(((((t * 6) % 1) - 0.5) ** 2) * 260)) : 0);
      d += `${x ? "L" : "M"}${x} ${r * 46 + 30 - y}`;
    }
    return d;
  };
  return (
    <svg viewBox="0 0 1200 440" preserveAspectRatio="none">
      {Array.from({ length: rows }, (_, r) => <path key={r} d={path(r)} style={{ animationDelay: `${r * 90}ms` }} />)}
    </svg>
  );
}
