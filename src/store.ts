import { create } from "zustand";
import { engine } from "./engine/client";
import type { EpochsResult, IcaInfo, PsdResult, RecordingInfo, Step, StepType, Tab } from "./types";

export type ErpConfig = {
  conditions: string[];
  tmin: number;
  tmax: number;
  baseline: [number, number] | null;
  reject_uv: number | null;
};

type View = { t0: number; span: number; uvPerRow: number; compare: boolean; annotate: boolean };
type Toast = { kind: "error" | "info"; text: string } | null;

type State = {
  engine: { status: "starting" | "ready" | "error"; stage: string; progress: number };
  info: RecordingInfo | null;
  steps: Step[];
  past: Step[][];
  future: Step[][];
  busy: string | null;
  toast: Toast;
  tab: Tab;
  rev: number;
  view: View;
  theme: "dark" | "light";
  ica: IcaInfo | null;
  psd: PsdResult | null;
  psdRev: number;
  erp: EpochsResult | null;
  erpRev: number;
  erpCfg: ErpConfig | null;
  tour: { active: boolean; step: number };

  boot: () => void;
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;
  openDemo: () => Promise<void>;
  openFiles: (files: File[]) => Promise<void>;
  closeRecording: () => void;
  setup: (types: Record<string, string>, montage: string | null) => Promise<boolean>;
  applySteps: (next: Step[], label: string, record?: boolean) => Promise<boolean>;
  addStep: (type: StepType, params: Record<string, unknown>, label: string) => Promise<boolean>;
  updateStep: (id: string, params: Record<string, unknown>, label: string) => Promise<boolean>;
  toggleStep: (id: string) => Promise<boolean>;
  removeStep: (id: string) => Promise<boolean>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  toggleBad: (name: string) => Promise<void>;
  annotate: (op: "add" | "remove", onset: number, duration: number, description: string) => Promise<void>;
  computePsd: () => Promise<void>;
  computeErp: (cfg: ErpConfig) => Promise<void>;
  setView: (v: Partial<View>) => void;
  setTab: (tab: Tab) => void;
  setTheme: (t: "dark" | "light") => void;
  setToast: (t: Toast) => void;
  setTour: (t: Partial<{ active: boolean; step: number }>) => void;
};

const uid = () => Math.random().toString(36).slice(2, 10);
const initialTheme = (): "dark" | "light" => {
  try {
    const saved = localStorage.getItem("ncl-theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* storage unavailable */
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
};

export const useLab = create<State>((set, get) => ({
  engine: { status: "starting", stage: "Starting", progress: 0 },
  info: null,
  steps: [],
  past: [],
  future: [],
  busy: null,
  toast: null,
  tab: "signal",
  rev: 0,
  view: { t0: 0, span: 10, uvPerRow: 80, compare: false, annotate: false },
  theme: initialTheme(),
  ica: null,
  psd: null,
  psdRev: -1,
  erp: null,
  erpRev: -1,
  erpCfg: null,
  tour: { active: false, step: 0 },

  boot: () => {
    engine.onStatus = (stage, progress) => set({ engine: { status: progress >= 1 ? "ready" : "starting", stage, progress } });
    engineCache()
      .then(() => engine.start())
      .then(() => set({ engine: { status: "ready", stage: "Ready", progress: 1 } }))
      .catch((err: Error) =>
        set({ engine: { status: "error", stage: err.message || "The engine could not start.", progress: 0 } }),
      );
  },

  run: async (label, fn) => {
    set({ busy: label });
    try {
      return await fn();
    } catch (err) {
      set({ toast: { kind: "error", text: (err as Error).message } });
      return undefined;
    } finally {
      set({ busy: null });
    }
  },

  openDemo: async () => {
    const info = await get().run("Creating the demo recording", () => engine.call<RecordingInfo>("demo"));
    if (info) afterLoad(info);
  },

  openFiles: async (files) => {
    const info = await get().run(`Opening ${files[0]?.name ?? "file"}`, () => engine.loadFiles<RecordingInfo>(files));
    if (info) afterLoad(info);
  },

  closeRecording: () => set({ info: null, steps: [], past: [], future: [], ica: null, psd: null, erp: null, erpCfg: null }),

  setup: async (types, montage) => {
    const info = await get().run("Updating channels", () => engine.call<RecordingInfo>("setup", { types, montage }));
    if (!info) return false;
    const ica = info.ica ? ((await engine.call<IcaInfo>("ica_info").catch(() => null)) ?? null) : null;
    set((s) => ({ info, ica, rev: s.rev + 1 }));
    return true;
  },

  applySteps: async (next, label, record = true) => {
    const prev = get().steps;
    const info = await get().run(label, () => engine.call<RecordingInfo>("set_steps", { steps: next }));
    if (!info) return false;
    let ica: IcaInfo | null = null;
    if (info.ica) ica = (await engine.call<IcaInfo>("ica_info").catch(() => null)) ?? null;
    set((s) => ({
      info,
      steps: next,
      ica,
      rev: s.rev + 1,
      past: record ? [...s.past, prev].slice(-50) : s.past,
      future: record ? [] : s.future,
      view: { ...s.view, t0: Math.max(0, Math.min(s.view.t0, info.duration - s.view.span)) },
    }));
    return true;
  },

  addStep: (type, params, label) =>
    get().applySteps([...get().steps, { id: uid(), type, params, enabled: true }], label),

  updateStep: (id, params, label) =>
    get().applySteps(get().steps.map((s) => (s.id === id ? { ...s, params } : s)), label),

  toggleStep: (id) =>
    get().applySteps(get().steps.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)), "Updating the pipeline"),

  removeStep: (id) => get().applySteps(get().steps.filter((s) => s.id !== id), "Updating the pipeline"),

  undo: async () => {
    const { past, steps } = get();
    if (!past.length) return;
    const target = past[past.length - 1];
    if (await get().applySteps(target, "Undoing", false))
      set((s) => ({ past: s.past.slice(0, -1), future: [steps, ...s.future] }));
  },

  redo: async () => {
    const { future, steps } = get();
    if (!future.length) return;
    if (await get().applySteps(future[0], "Redoing", false))
      set((s) => ({ future: s.future.slice(1), past: [...s.past, steps] }));
  },

  toggleBad: async (name) => {
    const { steps, info } = get();
    if (!info) return;
    const current = info.channels.filter((c) => c.bad).map((c) => c.name);
    const channels = current.includes(name) ? current.filter((c) => c !== name) : [...current, name];
    const existing = [...steps].reverse().find((s) => s.type === "bads" && s.enabled);
    const lastInterp = steps.map((s) => s.type).lastIndexOf("interpolate");
    if (existing && steps.indexOf(existing) > lastInterp) {
      if (channels.length) await get().updateStep(existing.id, { channels }, "Marking bad channels");
      else await get().removeStep(existing.id);
    } else if (channels.length) {
      await get().addStep("bads", { channels }, "Marking bad channels");
    }
  },

  annotate: async (op, onset, duration, description) => {
    const info = await get().run("Updating annotations", () =>
      engine.call<RecordingInfo>("annotate", { op, onset, duration, description }),
    );
    if (info) set((s) => ({ info, rev: s.rev + 1 }));
  },

  computePsd: async () => {
    const rev = get().rev;
    const psd = await get().run("Computing the power spectrum", () => engine.call<PsdResult>("psd", { fmin: 0.5, fmax: 45 }));
    if (psd) set({ psd, psdRev: rev });
  },

  computeErp: async (cfg) => {
    const rev = get().rev;
    const erp = await get().run("Averaging epochs", () => engine.call<EpochsResult>("epochs", cfg));
    if (erp) set({ erp, erpRev: rev, erpCfg: cfg });
  },

  setView: (v) => set((s) => ({ view: { ...s.view, ...v } })),
  setTab: (tab) => set({ tab }),
  setTheme: (theme) => {
    try {
      localStorage.setItem("ncl-theme", theme);
    } catch {
      /* storage unavailable */
    }
    set({ theme });
  },
  setToast: (toast) => set({ toast }),
  setTour: (t) => set((s) => ({ tour: { ...s.tour, ...t } })),
}));

/**
 * Registers the service worker that caches the engine's downloads, and waits (briefly)
 * until it controls the page so that the very first download is cached too.
 */
async function engineCache() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
    if (navigator.serviceWorker.controller) return;
    await Promise.race([
      new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true })),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch {
    /* caching is an optimisation; the engine works without it */
  }
}

/** A round amplitude per row that suits the recording's typical signal size. */
function displayScale(typicalUv: number) {
  const target = Math.max(5, Math.min(2000, typicalUv * 7));
  const nice = [5, 10, 20, 30, 50, 80, 100, 150, 200, 300, 500, 800, 1000, 2000];
  return nice.reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best), nice[0]);
}

function afterLoad(info: RecordingInfo) {
  useLab.setState((s) => ({
    info,
    steps: [],
    past: [],
    future: [],
    ica: null,
    psd: null,
    psdRev: -1,
    erp: null,
    erpRev: -1,
    erpCfg: null,
    rev: s.rev + 1,
    tab: "signal",
    view: { t0: 0, span: Math.min(10, info.duration), uvPerRow: displayScale(info.typical_uv), compare: false, annotate: false },
  }));
}

// handy when debugging in the browser console during development
if (import.meta.env.DEV) (window as unknown as { __lab: typeof useLab }).__lab = useLab;
