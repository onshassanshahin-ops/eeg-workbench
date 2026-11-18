/// <reference lib="webworker" />
// Hosts Python (Pyodide) with MNE-Python and the Lab engine. All signal
// processing happens here, off the main thread, on the user's machine.
import engineSource from "./python/engine.py?raw";

const PYODIDE_VERSION = "314.0.8";
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
// MNE is installed without its plotting dependencies (matplotlib and friends): Lab draws
// everything itself, and leaving them out makes the first download much smaller.
const MNE = "mne==1.13.2";
const MNE_RUNTIME = ["decorator", "lazy_loader", "packaging", "tqdm", "jinja2"];
const EXTRAS = ["python-picard", "edfio"];
const MAIN_EXTENSIONS = [".vhdr", ".set", ".edf", ".bdf", ".gdf", ".fif", ".fif.gz", ".cnt"];

/* eslint-disable @typescript-eslint/no-explicit-any */
let py: any = null;
let handle: any = null;
const installed = new Set<string>();

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const status = (stage: string, progress: number) => ctx.postMessage({ type: "status", stage, progress });

async function ensure(packages: string[], deps = true) {
  const missing = packages.filter((p) => !installed.has(p));
  if (!missing.length) return;
  const micropip = py.pyimport("micropip");
  await micropip.install.callKwargs(missing, { deps });
  missing.forEach((p) => installed.add(p));
}

async function init() {
  status("Starting Python", 0.05);
  const { loadPyodide } = await import(/* @vite-ignore */ `${INDEX_URL}pyodide.mjs`);
  py = await loadPyodide({ indexURL: INDEX_URL });
  status("Loading numerical libraries", 0.25);
  await py.loadPackage(["numpy", "scipy", "scikit-learn", "micropip"]);
  status("Loading the EEG toolkit", 0.6);
  await ensure([MNE], false);
  await ensure(MNE_RUNTIME);
  await ensure(EXTRAS, false);
  status("Preparing the workspace", 0.85);
  py.FS.mkdirTree("/lab");
  py.FS.mkdirTree("/data");
  py.FS.writeFile("/lab/engine.py", engineSource);
  await py.runPythonAsync(`import sys\nsys.path.insert(0, "/lab")\nimport engine`);
  handle = py.globals.get("engine").handle;
  status("Ready", 1);
}

function run(cmd: string, args: unknown) {
  const proxy = handle(cmd, JSON.stringify(args ?? {}));
  const [json, buffers] = proxy.toJs({ create_proxies: false }) as [string, ArrayBufferView[]];
  proxy.destroy();
  const meta = JSON.parse(json);
  if (!meta.ok) throw Object.assign(new Error(meta.error), { trace: meta.trace });
  // make sure every buffer owns its memory so it can be transferred
  const owned = buffers.map((b: any) => (b.byteOffset === 0 && b.buffer.byteLength === b.byteLength ? b : b.slice()));
  return { result: meta.result, buffers: owned };
}

function pickMain(names: string[]) {
  for (const ext of MAIN_EXTENSIONS) {
    const hit = names.find((n) => n.toLowerCase().endsWith(ext));
    if (hit) return hit;
  }
  return null;
}

async function loadFiles(files: { name: string; data: ArrayBuffer }[]) {
  for (const f of py.FS.readdir("/data")) if (f !== "." && f !== "..") py.FS.unlink(`/data/${f}`);
  for (const f of files) py.FS.writeFile(`/data/${f.name}`, new Uint8Array(f.data));
  const main = pickMain(files.map((f) => f.name));
  if (!main) {
    throw new Error(
      "This file type is not supported yet. Try EDF, BDF, BrainVision (.vhdr + .vmrk + .eeg), EEGLAB (.set), FIF or GDF.",
    );
  }
  if (main.toLowerCase().endsWith(".vhdr") && files.length < 3) {
    throw new Error("A BrainVision recording has three files. Drop the .vhdr, .vmrk and .eeg files together.");
  }
  if (main.toLowerCase().endsWith(".set")) await ensure(["pymatreader"]).catch(() => undefined);
  return run("load", { path: `/data/${main}` });
}

ctx.onmessage = async (ev: MessageEvent) => {
  const { id, cmd, args, files } = ev.data;
  try {
    let out: { result: unknown; buffers: ArrayBufferView[] };
    if (cmd === "init") {
      await init();
      out = { result: { version: PYODIDE_VERSION }, buffers: [] };
    } else if (cmd === "load_files") {
      out = await loadFiles(files);
    } else {
      if (cmd === "export" && args?.format === "brainvision") await ensure(["pybv"], false);
      out = run(cmd, args);
    }
    ctx.postMessage(
      { type: "result", id, ok: true, result: out.result, buffers: out.buffers },
      out.buffers.map((b) => b.buffer as ArrayBuffer),
    );
  } catch (err: any) {
    ctx.postMessage({ type: "result", id, ok: false, error: String(err?.message ?? err), trace: err?.trace });
  }
};
