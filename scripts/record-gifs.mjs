// Records the README animations by driving the real app in Google Chrome.
//
//   1. npm run dev            (in another terminal)
//   2. npm run gifs           (optionally: LAB_URL=http://localhost:5173/ npm run gifs -- hero ica)
//
// Output: docs/media/{hero,ica,erp,export}.gif
import gifenc from "gifenc";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import pngjs from "pngjs";

const { GIFEncoder, quantize, applyPalette } = gifenc;
const { PNG } = pngjs;
const URL = process.env.LAB_URL ?? "http://localhost:5173/";
const W = 1180;
const H = 700;
const FPS = 6;
const MAX_HOLD = 900; // ms: waiting for a computation is shortened to this
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync("docs/media", { recursive: true });
mkdirSync(".cache", { recursive: true });
const ctx = await chromium.launchPersistentContext(".cache/gif-profile", {
  channel: "chrome",
  headless: true,
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  colorScheme: "dark",
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.addInitScript(() => {
  try { localStorage.setItem("ncl-theme", "dark"); } catch { /* ignore */ }
  window.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = ".spin{animation:none!important}.stage,.step,.form,.tour,.toast{animation:none!important}";
    document.head.appendChild(style);
    const dot = document.createElement("div");
    dot.style.cssText =
      "position:fixed;z-index:99999;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;pointer-events:none;" +
      "background:rgba(255,255,255,.28);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.5);left:-50px;top:-50px;transition:transform .12s";
    document.body.appendChild(dot);
    window.addEventListener("mousemove", (e) => { dot.style.left = e.clientX + "px"; dot.style.top = e.clientY + "px"; }, true);
    window.addEventListener("mousedown", () => (dot.style.transform = "scale(.65)"), true);
    window.addEventListener("mouseup", () => (dot.style.transform = ""), true);
  });
});

const idle = () =>
  page.waitForFunction(() => document.querySelector(".status")?.textContent.trim().startsWith("Ready"), null, { timeout: 600_000 });

let pos = { x: W / 2, y: H / 2 };
async function moveTo(x, y, ms = 450) {
  const steps = Math.max(4, Math.round(ms / 30));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t * t * (3 - 2 * t);
    await page.mouse.move(pos.x + (x - pos.x) * e, pos.y + (y - pos.y) * e);
    await sleep(ms / steps);
  }
  pos = { x, y };
}
async function click(selector, opts = {}) {
  const el = typeof selector === "string" ? page.locator(selector).first() : selector;
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  await moveTo(b.x + b.width / 2, b.y + b.height / 2);
  await sleep(180);
  await page.mouse.down();
  await sleep(70);
  await page.mouse.up();
  await sleep(opts.after ?? 350);
}
async function wheel(x, y, total, ticks = 12) {
  await moveTo(x, y, 300);
  for (let i = 0; i < ticks; i++) {
    await page.mouse.wheel(0, total / ticks);
    await sleep(90);
  }
}
const text = (t) => page.getByRole("button", { name: t, exact: false }).first();

async function record(name, fn) {
  if (only.length && !only.includes(name)) return fn(false);
  const shots = [];
  let on = true;
  const loop = (async () => {
    while (on) {
      const t = Date.now();
      shots.push(await page.screenshot({ type: "png" }));
      const rest = 1000 / FPS - (Date.now() - t);
      if (rest > 0) await sleep(rest);
    }
  })();
  await fn(true);
  await sleep(900);
  on = false;
  await loop;

  // 1. merge identical frames (waiting time), capping how long any one frame is held
  let prev = null;
  let held = 0;
  const frames = [];
  for (const png of shots) {
    const { data } = PNG.sync.read(png);
    if (prev && Buffer.compare(prev, data) === 0) {
      frames[frames.length - 1].delay = Math.min(MAX_HOLD, frames[frames.length - 1].delay + 1000 / FPS);
      held++;
      continue;
    }
    frames.push({ data, delay: 1000 / FPS });
    prev = data;
  }
  frames[frames.length - 1].delay = 2200; // pause on the final frame
  writeFileSync(`docs/media/${name}-last.png`, shots[shots.length - 1]);

  // 2. encode; after the first frame, pixels that did not change are written as
  //    transparent so each frame only stores what moved (much smaller files)
  const gif = GIFEncoder();
  const T = 255; // palette slot reserved for "unchanged"
  let last = null;
  for (const f of frames) {
    const px = new Uint32Array(f.data.buffer, f.data.byteOffset, f.data.length / 4);
    const palette = quantize(f.data, last ? 255 : 256);
    const index = applyPalette(f.data, palette);
    if (last) {
      while (palette.length <= T) palette.push([0, 0, 0]);
      for (let i = 0; i < px.length; i++) if (px[i] === last[i]) index[i] = T;
    }
    gif.writeFrame(index, W, H, {
      palette,
      delay: Math.round(f.delay),
      transparent: !!last,
      transparentIndex: T,
      dispose: 1,
    });
    last = px;
  }
  gif.finish();
  const bytes = gif.bytes();
  writeFileSync(`docs/media/${name}.gif`, bytes);
  console.log(`${name}.gif  ${frames.length} frames (${held} held)  ${(bytes.length / 1e6).toFixed(1)} MB`);
}

// ---------------------------------------------------------------------------
console.log("Loading the app and the analysis engine (the first run downloads it)…");
await page.goto(URL);
await idle();
const viewer = { x: 480, y: 330 };

await record("hero", async () => {
  await sleep(900);
  await click(text("Try the demo recording"), { after: 300 });
  await page.waitForSelector(".viewer");
  await idle();
  await sleep(900);
  await wheel(viewer.x, viewer.y, 700, 8);
  await sleep(400);
  await click('[data-step="filter"]');
  await click(text("General 1–40 Hz"));
  await click('[data-tour="apply"]', { after: 200 });
  await idle();
  await sleep(700);
  await click(text("Compare with original"));
  await sleep(600);
  await wheel(viewer.x, viewer.y, 900, 9);
  await sleep(400);
});

// prepare the rest of the cleaning without recording it
async function addStep(type, before) {
  await click(`[data-step="${type}"]`);
  if (before) await before();
  await click('[data-tour="apply"]', { after: 200 });
  await idle();
}
await click(text("Compare with original"));
await addStep("notch");
await addStep("bads", async () => {
  await click(text("Find bad channels for me"));
  await page.waitForSelector(".found");
});
await addStep("interpolate");
await addStep("reference");

await record("ica", async () => {
  await click('[data-tab="components"]');
  await sleep(700);
  await click('[data-tour="run-ica"]', { after: 200 });
  await page.waitForSelector(".comp-grid", { timeout: 600_000 });
  await idle();
  await sleep(1300);
  await moveTo(330, 230, 600);
  await sleep(500);
  await click('[data-tour="remove-suggested"]', { after: 200 });
  await idle();
  await sleep(900);
  await click('[data-tab="signal"]');
  await sleep(500);
  await click(text("Compare with original"));
  await sleep(500);
  await wheel(viewer.x, viewer.y, 900, 9);
  await sleep(500);
});

await record("erp", async () => {
  await click('[data-tab="erp"]');
  await sleep(700);
  await click('[data-tour="average"]', { after: 200 });
  await page.waitForSelector(".live-map canvas", { timeout: 120_000 });
  await idle();
  await sleep(1000);
  const plot = page.locator(".erp-row canvas.plot");
  await plot.scrollIntoViewIfNeeded();
  const b = await plot.boundingBox();
  await moveTo(b.x + b.width * 0.22, b.y + b.height * 0.5, 500);
  await moveTo(b.x + b.width * 0.72, b.y + b.height * 0.45, 2600);
  await moveTo(b.x + b.width * 0.57, b.y + b.height * 0.4, 900);
  await sleep(900);
});

await record("export", async () => {
  await click('[data-tab="export"]');
  await page.waitForSelector(".code section");
  await sleep(1100);
  const code = await page.locator(".code").boundingBox();
  await wheel(code.x + code.width / 2, code.y + code.height / 2, 520, 14);
  await sleep(700);
  await moveTo(code.x + code.width - 90, code.y - 60, 600);
  await sleep(900);
});

await ctx.close();
console.log("Done.");
