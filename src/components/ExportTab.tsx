import { Check, Copy, Download, FileCode2, FileDown, Layers } from "lucide-react";
import { useEffect, useState } from "react";
import { engine } from "../engine/client";
import { download } from "../lib/canvas";
import { useLab } from "../store";
import type { ScriptResult } from "../types";

type Blob_ = { filename: string; bytes: { data: Uint8Array } };

export function ExportTab() {
  const info = useLab((s) => s.info)!;
  const rev = useLab((s) => s.rev);
  const erp = useLab((s) => s.erp);
  const erpRev = useLab((s) => s.erpRev);
  const psdRev = useLab((s) => s.psdRev);
  const run = useLab((s) => s.run);
  const busy = useLab((s) => s.busy);
  const [script, setScript] = useState<ScriptResult | null>(null);
  const [copied, setCopied] = useState(false);
  const isDemo = info.name.startsWith("Demo recording");
  const epochsOk = !!erp && erpRev === rev;

  useEffect(() => {
    engine.call<ScriptResult>("script").then(setScript).catch(() => setScript(null));
  }, [rev, erpRev, psdRev]);

  const save = (label: string, args: Record<string, unknown>) =>
    void run(label, () => engine.call<Blob_>("export", args)).then((r) => r && download(r.filename, r.bytes.data as BlobPart));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Export</h2>
          <p>Take your results with you: the cleaned data, and code that repeats every step you made here.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3><FileCode2 size={15} /> Reproducible code</h3>
          <div className="row">
            <button className="btn ghost" disabled={!script} onClick={() => {
              void navigator.clipboard.writeText(script!.py).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
            }}>{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}</button>
            <button className="btn ghost" disabled={!script} onClick={() => download("analysis.py", script!.py, "text/x-python")}><Download size={14} /> Python script</button>
            <button className="btn primary" disabled={!script} onClick={() => download("analysis.ipynb", script!.ipynb, "application/x-ipynb+json")}><Download size={14} /> Jupyter notebook</button>
          </div>
        </div>
        <p className="explain">
          Everything you did is written out as MNE-Python code. Run it on your own computer or in Google Colab to get the
          same result, share it with a paper, or use it as a starting point for your own scripts.
        </p>
        <div className="code">
          {script?.sections.map((s, i) => (
            <section key={i}>
              <header><span>{i + 1}</span><b>{s.title}</b><em>{s.why}</em></header>
              <pre>{s.code}</pre>
            </section>
          )) ?? <p className="hint">Preparing…</p>}
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3><FileDown size={15} /> Cleaned recording</h3>
          <p className="explain">The signal after every enabled pipeline step, with your annotations.</p>
          <div className="row wrap">
            <button className="btn ghost" disabled={!!busy} onClick={() => save("Writing FIF file", { what: "raw", format: "fif" })}>FIF (MNE)</button>
            <button className="btn ghost" disabled={!!busy} onClick={() => save("Writing EDF file", { what: "raw", format: "edf" })}>EDF</button>
            <button className="btn ghost" disabled={!!busy} onClick={() => save("Writing BrainVision files", { what: "raw", format: "brainvision" })}>BrainVision (.zip)</button>
          </div>
        </div>
        <div className="card">
          <h3><Layers size={15} /> Epochs and averages</h3>
          {epochsOk ? (
            <>
              <p className="explain">The epochs and evoked responses from the Evoked tab.</p>
              <div className="row wrap">
                <button className="btn ghost" disabled={!!busy} onClick={() => save("Writing epochs", { what: "epochs" })}>Epochs (FIF)</button>
                <button className="btn ghost" disabled={!!busy} onClick={() => save("Writing averages", { what: "evoked" })}>Averages (FIF)</button>
              </div>
            </>
          ) : <p className="explain">Create epochs in the Evoked tab to export them here.</p>}
        </div>
      </div>

      {isDemo && (
        <div className="card">
          <h3>Demo recording</h3>
          <p className="explain">Download the simulated recording so the exported code has a file to load.</p>
          <button className="btn ghost" disabled={!!busy} onClick={() => save("Writing the demo recording", { what: "original" })}><Download size={14} /> eeg_workbench_demo_raw.fif</button>
        </div>
      )}
      <p className="foot">Figures and tables are saved from the screen that shows them, using the buttons at the top of each one.</p>
    </div>
  );
}
