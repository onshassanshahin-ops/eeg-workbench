// End-to-end test of the Python engine under Pyodide (the same runtime the browser uses).
// Run: npm run test:engine
import { loadPyodide } from "pyodide";
import { mkdirSync, readFileSync } from "node:fs";

const CACHE_DIR = ".cache/pyodide";
mkdirSync(CACHE_DIR, { recursive: true });

const t0 = performance.now();
const py = await loadPyodide({ packageCacheDir: CACHE_DIR });
await py.loadPackage(["numpy", "scipy", "scikit-learn", "micropip"], { messageCallback: () => {} });
// same minimal install as src/engine/worker.ts (no plotting libraries)
await py.runPythonAsync(`
import micropip
await micropip.install("mne==1.13.2", deps=False)
await micropip.install(["decorator", "lazy_loader", "packaging", "tqdm", "jinja2"])
await micropip.install(["python-picard", "edfio", "pybv"], deps=False)
`);
py.FS.mkdirTree("/lab");
py.FS.writeFile("/lab/engine.py", readFileSync("src/engine/python/engine.py", "utf8"));
py.runPython(`import sys; sys.path.insert(0, "/lab"); import engine`);
const handle = py.globals.get("engine").handle;
console.log(`engine ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

let failed = 0;
function call(cmd, args = {}) {
  const t = performance.now();
  const res = handle(cmd, JSON.stringify(args)).toJs({ create_proxies: false });
  const meta = JSON.parse(res[0]);
  const ms = (performance.now() - t).toFixed(0);
  if (!meta.ok) {
    failed++;
    console.log(`✗ ${cmd} (${ms} ms): ${meta.error}\n${meta.trace}`);
    return null;
  }
  console.log(`✓ ${cmd} (${ms} ms)`);
  return { r: meta.result, bufs: res[1] };
}
function check(label, cond) {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok " : "BAD"} ${label}`);
}
const step = (type, params) => ({ id: type + Math.random(), type, params, enabled: true });

let x = call("demo");
check("32 channels", x.r.channels.length === 32);
check("events present", x.r.event_counts.target > 10 && x.r.event_counts.standard > 50);
check("positions present", Array.isArray(x.r.channels[0].pos));

x = call("window", { t0: 0, t1: 10, px: 800 });
check("window shape", x.r.data.shape[0] === 32 && x.bufs[x.r.data.$buf].length === 32 * x.r.data.shape[1]);
call("overview", { bins: 400 });

x = call("detect_bads");
check("finds noisy P7", x.r.bads.some((b) => b.name === "P7"));
console.log("   ", JSON.stringify(x.r.bads));

const steps = [
  step("filter", { l_freq: 1, h_freq: 40 }),
  step("notch", { freq: 50, harmonics: true }),
  step("bads", { channels: ["P7"] }),
  step("interpolate", {}),
  step("reference", { kind: "average" }),
];
x = call("set_steps", { steps });
check("highpass set", x.r.highpass === 1);
x = call("window", { t0: 0, t1: 10, px: 800, compare: true });
check("compare returned", !!x.r.compare);

steps.push(step("ica", { n_components: 15, method: "picard", seed: 97, exclude: [] }));
x = call("set_steps", { steps });
check("ica fitted", x.r.ica && x.r.ica.n === 15);
x = call("ica_info");
check("ica maps", x.r.maps && x.r.maps.shape[0] === 15);
console.log("    suggestions:", JSON.stringify(x.r.suggest));
const eye = Object.entries(x.r.suggest).filter(([, v]) => v === "eye").map(([k]) => +k);
check("eye component suggested", eye.length >= 1);
steps[steps.length - 1] = { ...steps[steps.length - 1], params: { ...steps[steps.length - 1].params, exclude: eye } };
x = call("set_steps", { steps });
check("exclusion applied", x.r.ica.exclude.length === eye.length);
call("window", { t0: 0, t1: 10, px: 800, mode: "ica" });

x = call("psd", { fmin: 1, fmax: 45 });
check("alpha peak near 10 Hz", Math.abs(x.r.peak_alpha - 10) < 1.5);
check("band maps", x.r.maps && x.r.maps.shape[0] === x.r.bands.length);
console.log("    metrics:", JSON.stringify(x.r.metrics), "peak alpha", x.r.peak_alpha?.toFixed(2));

x = call("epochs", { conditions: ["standard", "target"], tmin: -0.2, tmax: 0.8, baseline: [-0.2, 0], reject_uv: 150 });
console.log("    kept:", JSON.stringify(x.r.kept), "found:", JSON.stringify(x.r.found));
{
  const [nc, nch, nt] = x.r.evoked.shape;
  const ev = x.bufs[x.r.evoked.$buf];
  const times = x.bufs[x.r.times.$buf];
  const pz = x.r.names.indexOf("Pz");
  let best = -1e9, bestT = 0;
  for (let i = 0; i < nt; i++) {
    const d = ev[nch * nt + pz * nt + i] - ev[pz * nt + i];
    if (d > best) { best = d; bestT = times[i]; }
  }
  console.log(`    target-minus-standard peak at Pz: ${best.toFixed(1)} µV at ${(bestT * 1000).toFixed(0)} ms`);
  check("P300 recovered (300–480 ms, > 3 µV)", bestT > 0.3 && bestT < 0.48 && best > 3 && nc === 2);
}
x = call("evoked_maps", { condition: "target - standard", times: [0.1, 0.2, 0.38] });
check("evoked maps", x.r.maps.shape[0] === 3);
x = call("evoked_measure", { condition: "target", tmin: 0.3, tmax: 0.5, mode: "pos" });
check("measures", x.r.rows.length > 20);
x = call("tfr", { channel: "Oz", condition: "target" });
check("tfr epochs", x.r.kind === "epochs");
x = call("tfr", { channel: "Oz" });
check("tfr raw", x.r.kind === "raw");

x = call("annotate", { op: "add", onset: 12, duration: 2, description: "BAD_segment" });
check("annotation added", x.r.annotations.some((a) => a.description === "BAD_segment"));

x = call("script");
check("script has ICA", x.r.py.includes("ica.apply(raw)") && x.r.ipynb.includes("nbformat"));
for (const fmt of ["fif", "edf", "brainvision"]) {
  x = call("export", { what: "raw", format: fmt });
  if (x) console.log(`    ${x.r.filename}: ${(x.bufs[x.r.bytes.$buf].length / 1e6).toFixed(1)} MB`);
}

// load a real file from disk through the same path the browser uses
x = call("export", { what: "raw", format: "edf" });
py.FS.mkdirTree("/data");
py.FS.writeFile("/data/sample.edf", x.bufs[x.r.bytes.$buf]);
x = call("load", { path: "/data/sample.edf" });
check("EDF loads with montage", x && x.r.channels.length === 32 && !!x.r.channels[0].pos);

check("display scale suggested", x.r.typical_uv > 1 && x.r.typical_uv < 500);

x = call("setup", { types: { Fp1: "eog" }, montage: "standard_1020" });
check("channel type changed", x.r.channels.find((c) => c.name === "Fp1").type === "eog");
x = call("script");
check("setup is in the exported code", x.r.py.includes("set_channel_types") && x.r.py.includes("standard_1020"));

// BrainVision: three files, loaded through the header file
call("export", { what: "raw", format: "brainvision" });
py.runPython(`
import shutil, os
for f in os.listdir("/tmp/export"):
    shutil.copy("/tmp/export/" + f, "/data/" + f)
`);
x = call("load", { path: "/data/cleaned.vhdr" });
check("BrainVision loads", x && x.r.channels.length === 32 && x.r.annotations.length > 100);

steps.splice(0, steps.length, step("crop", { tmin: 10, tmax: 60 }), step("resample", { sfreq: 125 }));
x = call("set_steps", { steps });
check("crop + resample", Math.abs(x.r.duration - 50) < 0.1 && x.r.sfreq === 125);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED", `in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
process.exit(failed ? 1 : 0);
