import { X } from "lucide-react";
import { useState } from "react";
import { useLab } from "../store";

const TYPES: [string, string][] = [
  ["eeg", "EEG"],
  ["eog", "Eye (EOG)"],
  ["ecg", "Heart (ECG)"],
  ["emg", "Muscle (EMG)"],
  ["stim", "Trigger"],
  ["misc", "Other"],
];

const LAYOUT_NAMES: Record<string, string> = {
  standard_1005: "Standard 10-05 (by channel name)",
  standard_1020: "Standard 10-20 (by channel name)",
  biosemi16: "BioSemi 16",
  biosemi32: "BioSemi 32",
  biosemi64: "BioSemi 64",
  biosemi128: "BioSemi 128",
  biosemi256: "BioSemi 256",
  "GSN-HydroCel-32": "HydroCel GSN 32",
  "GSN-HydroCel-64_1.0": "HydroCel GSN 64",
  "GSN-HydroCel-128": "HydroCel GSN 128",
  "GSN-HydroCel-256": "HydroCel GSN 256",
  "easycap-M1": "EasyCap M1",
  "easycap-M10": "EasyCap M10",
};

export function ChannelsDialog({ onClose }: { onClose: () => void }) {
  const info = useLab((s) => s.info)!;
  const busy = useLab((s) => s.busy);
  const setup = useLab((s) => s.setup);
  const [types, setTypes] = useState<Record<string, string>>({});
  const [montage, setMontage] = useState("");
  const located = info.channels.filter((c) => c.pos).length;
  const eeg = info.channels.filter((c) => (types[c.name] ?? c.type) === "eeg").length;
  const changed = Object.keys(types).length > 0 || montage !== "";

  return (
    <div className="veil" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="Channels">
        <header>
          <div>
            <h2>Channels</h2>
            <p>{info.channels.length} channels · {eeg} EEG · {located} with a scalp position</p>
          </div>
          <button className="icon" onClick={onClose} title="Close"><X size={16} /></button>
        </header>

        <label className="field">
          <span>Electrode layout</span>
          <select value={montage} onChange={(e) => setMontage(e.target.value)}>
            <option value="">{info.montage ? `Keep current (${LAYOUT_NAMES[info.montage] ?? info.montage})` : located ? "Keep positions from the file" : "None"}</option>
            {info.montages.map((m) => <option key={m} value={m}>{LAYOUT_NAMES[m] ?? m}</option>)}
          </select>
        </label>
        <p className="explain">
          Scalp maps and channel repair need to know where each electrode sits. Lab recognises standard channel names
          automatically. If your cap uses its own naming, choose its layout here.
        </p>

        <div className="chan-table">
          {info.channels.map((c) => (
            <div key={c.name} className="chan-row">
              <b>{c.name}</b>
              <i className={c.pos ? "ok" : ""} title={c.pos ? "Has a scalp position" : "No scalp position"} />
              <select
                value={types[c.name] ?? c.type}
                onChange={(e) => {
                  const next = { ...types };
                  if (e.target.value === c.type) delete next[c.name];
                  else next[c.name] = e.target.value;
                  setTypes(next);
                }}
              >
                {!TYPES.some(([v]) => v === c.type) && <option value={c.type}>{c.type}</option>}
                {TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </div>
          ))}
        </div>

        <footer>
          <span className="meta">Changing channels replays your pipeline on the updated recording.</span>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!changed || !!busy} onClick={() => void setup(types, montage || null).then((ok) => ok && onClose())}>
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
