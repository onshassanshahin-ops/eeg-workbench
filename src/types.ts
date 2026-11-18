export type Nd<T = Float32Array> = { data: T; shape: number[] };

export type Channel = { name: string; type: string; bad: boolean; pos: [number, number] | null };
export type Annotation = { onset: number; duration: number; description: string };

export type StepType =
  | "filter"
  | "notch"
  | "resample"
  | "reference"
  | "crop"
  | "bads"
  | "interpolate"
  | "drop"
  | "ica";

export type Step = { id: string; type: StepType; params: Record<string, unknown>; enabled: boolean };

export type RecordingInfo = {
  loaded: boolean;
  name: string;
  sfreq: number;
  n_times: number;
  duration: number;
  highpass: number;
  lowpass: number;
  channels: Channel[];
  annotations: Annotation[];
  event_counts: Record<string, number>;
  montage: string | null;
  montages: string[];
  typical_uv: number;
  memory_mb: number;
  ica: { n: number; exclude: number[] } | null;
  steps: Step[];
};

export type WindowData = {
  t0: number;
  t1: number;
  data: Nd;
  minmax: boolean;
  compare?: Nd;
  compare_minmax?: boolean;
  compare_names?: string[];
};

export type Band = { name: string; lo: number; hi: number };
export type PsdResult = {
  names: string[];
  freqs: Nd;
  psd: Nd;
  bands: Band[];
  abs: Nd;
  rel: Nd;
  maps?: Nd;
  map_names?: string[];
  peak_alpha?: number;
  metrics: Record<string, number>;
};

export type IcaInfo = {
  fitted: boolean;
  n: number;
  exclude: number[];
  suggest: Record<string, string>;
  var: Nd;
  freqs: Nd;
  psd: Nd;
  maps?: Nd;
  duration: number;
};

export type EpochsResult = {
  conditions: string[];
  names: string[];
  times: Nd;
  evoked: Nd;
  gfp: Nd;
  kept: Record<string, number>;
  found: Record<string, number>;
  has_maps: boolean;
};

export type TfrResult = { kind: "epochs" | "raw"; times: Nd; freqs: Nd; power: Nd; unit: string };
export type ScriptResult = { py: string; ipynb: string; sections: { title: string; why: string; code: string }[] };
export type BadSuggestion = { name: string; reason: string; score: number };

export type Tab = "signal" | "components" | "spectrum" | "erp" | "tf" | "export";
