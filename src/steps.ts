import type { RecordingInfo, StepType } from "./types";

export type Field =
  | { key: string; label: string; kind: "number"; unit?: string; min?: number; max?: number; step?: number; optional?: boolean; hint?: string }
  | { key: string; label: string; kind: "select"; options: { value: string | number; label: string }[] }
  | { key: string; label: string; kind: "toggle" }
  | { key: string; label: string; kind: "channels"; showIf?: (p: Record<string, unknown>) => boolean };

export type Preset = { label: string; params: Record<string, unknown> };

export type StepDef = {
  type: StepType;
  label: string;
  verb: string;
  explain: string;
  tip?: string;
  fields: Field[];
  presets?: Preset[];
  defaults: (info: RecordingInfo) => Record<string, unknown>;
  summary: (p: Record<string, unknown>) => string;
  validate?: (p: Record<string, unknown>, info: RecordingInfo) => string | null;
};

const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);

export const STEP_DEFS: Record<StepType, StepDef> = {
  filter: {
    type: "filter",
    label: "Filter",
    verb: "Filtering",
    explain:
      "Keeps the frequencies you care about and removes the rest. The low cut-off removes slow drift; the high cut-off removes fast noise such as muscle activity.",
    tip: "For evoked responses, keep the low cut-off at 0.1 Hz or below so slow components are not distorted. For ICA, 1 Hz works best.",
    fields: [
      { key: "l_freq", label: "Low cut-off", kind: "number", unit: "Hz", min: 0, step: 0.1, optional: true, hint: "Leave empty for none" },
      { key: "h_freq", label: "High cut-off", kind: "number", unit: "Hz", min: 0, step: 1, optional: true, hint: "Leave empty for none" },
    ],
    presets: [
      { label: "General 1–40 Hz", params: { l_freq: 1, h_freq: 40 } },
      { label: "Evoked 0.1–30 Hz", params: { l_freq: 0.1, h_freq: 30 } },
      { label: "Drift only (1 Hz high-pass)", params: { l_freq: 1, h_freq: null } },
    ],
    defaults: () => ({ l_freq: 1, h_freq: 40 }),
    summary: (p) =>
      p.l_freq != null && p.h_freq != null
        ? `${p.l_freq}–${p.h_freq} Hz`
        : p.l_freq != null
          ? `above ${p.l_freq} Hz`
          : `below ${p.h_freq} Hz`,
    validate: (p, info) => {
      const lo = p.l_freq as number | null, hi = p.h_freq as number | null;
      if (lo == null && hi == null) return "Enter at least one cut-off.";
      if (lo != null && hi != null && lo >= hi) return "The low cut-off must be below the high cut-off.";
      if (hi != null && hi >= info.sfreq / 2) return `The high cut-off must be below ${info.sfreq / 2} Hz (half the sampling rate).`;
      return null;
    },
  },
  notch: {
    type: "notch",
    label: "Notch",
    verb: "Removing line noise",
    explain:
      "Removes the narrow hum picked up from mains electricity. Use 50 Hz in most of the world and 60 Hz in the Americas and parts of Asia.",
    fields: [
      { key: "freq", label: "Mains frequency", kind: "select", options: [{ value: 50, label: "50 Hz" }, { value: 60, label: "60 Hz" }] },
      { key: "harmonics", label: "Also remove harmonics", kind: "toggle" },
    ],
    defaults: () => ({ freq: 50, harmonics: true }),
    summary: (p) => `${p.freq} Hz${p.harmonics ? " + harmonics" : ""}`,
  },
  reference: {
    type: "reference",
    label: "Re-reference",
    verb: "Re-referencing",
    explain:
      "EEG voltages are always measured relative to a reference. The average reference uses the mean of all electrodes, which suits recordings with many well-spread channels.",
    tip: "Mark bad channels first, otherwise their noise is mixed into every other channel.",
    fields: [
      { key: "kind", label: "Reference", kind: "select", options: [{ value: "average", label: "Average of all EEG channels" }, { value: "channels", label: "Chosen channels" }] },
      { key: "channels", label: "Reference channels", kind: "channels", showIf: (p) => p.kind === "channels" },
    ],
    defaults: () => ({ kind: "average", channels: [] }),
    summary: (p) => (p.kind === "average" ? "average" : list(p.channels).join(", ") || "none chosen"),
    validate: (p) => (p.kind === "channels" && !list(p.channels).length ? "Choose at least one reference channel." : null),
  },
  resample: {
    type: "resample",
    label: "Resample",
    verb: "Resampling",
    explain: "Lowers the number of samples per second. Smaller data makes every later step faster.",
    tip: "Keep the new rate at least 2.5 times your highest frequency of interest.",
    fields: [{ key: "sfreq", label: "New sampling rate", kind: "number", unit: "Hz", min: 20, step: 1 }],
    defaults: (info) => ({ sfreq: Math.min(250, Math.round(info.sfreq / 2)) }),
    summary: (p) => `${p.sfreq} Hz`,
    validate: (p) => (!(Number(p.sfreq) >= 20) ? "Enter a sampling rate of 20 Hz or more." : null),
  },
  crop: {
    type: "crop",
    label: "Crop",
    verb: "Cropping",
    explain: "Keeps only part of the recording, for example to drop the setup period at the start.",
    fields: [
      { key: "tmin", label: "Start", kind: "number", unit: "s", min: 0, step: 1 },
      { key: "tmax", label: "End", kind: "number", unit: "s", min: 0, step: 1, optional: true, hint: "Leave empty for the end" },
    ],
    defaults: (info) => ({ tmin: 0, tmax: Math.floor(info.duration) }),
    summary: (p) => `${p.tmin ?? 0}–${p.tmax ?? "end"} s`,
    validate: (p) => (p.tmax != null && Number(p.tmax) <= Number(p.tmin ?? 0) ? "The end must be after the start." : null),
  },
  bads: {
    type: "bads",
    label: "Bad channels",
    verb: "Marking bad channels",
    explain:
      "Marks channels that are flat, very noisy or disconnected so later steps ignore them. You can also click a channel name in the viewer.",
    fields: [{ key: "channels", label: "Bad channels", kind: "channels" }],
    defaults: (info) => ({ channels: info.channels.filter((c) => c.bad).map((c) => c.name) }),
    summary: (p) => list(p.channels).join(", ") || "none",
  },
  interpolate: {
    type: "interpolate",
    label: "Interpolate",
    verb: "Interpolating bad channels",
    explain: "Rebuilds each bad channel from its neighbours, so you keep the full set of electrodes for maps and averages.",
    fields: [],
    defaults: () => ({}),
    summary: () => "bad channels rebuilt",
    validate: (_p, info) =>
      !info.channels.some((c) => c.bad) ? "There are no bad channels to interpolate. Mark some first." : null,
  },
  drop: {
    type: "drop",
    label: "Drop channels",
    verb: "Dropping channels",
    explain: "Removes channels you do not need, such as unused inputs.",
    fields: [{ key: "channels", label: "Channels to remove", kind: "channels" }],
    defaults: () => ({ channels: [] }),
    summary: (p) => list(p.channels).join(", ") || "none",
    validate: (p) => (!list(p.channels).length ? "Choose at least one channel." : null),
  },
  ica: {
    type: "ica",
    label: "ICA",
    verb: "Separating components (this can take a moment)",
    explain:
      "Splits the recording into independent sources. Eye blinks, muscle tension and heartbeat usually land in a few components, which you can then remove without discarding any data.",
    tip: "Filter first (1 Hz or higher) and deal with bad channels before running ICA.",
    fields: [{ key: "n_components", label: "Number of components", kind: "number", min: 2, max: 64, step: 1 }],
    defaults: (info) => ({
      n_components: Math.max(2, Math.min(20, info.channels.filter((c) => c.type === "eeg" && !c.bad).length - 1)),
      method: "picard",
      seed: 97,
      exclude: [],
    }),
    summary: (p) => {
      const n = list(p.exclude).length;
      return `${p.n_components} components, ${n ? `${n} removed` : "none removed yet"}`;
    },
  },
};

export const ADD_ORDER: StepType[] = ["filter", "notch", "bads", "interpolate", "reference", "ica", "resample", "crop", "drop"];
