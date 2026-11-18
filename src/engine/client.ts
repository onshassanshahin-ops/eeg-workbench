// Promise-based client for the engine worker.
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type StatusListener = (stage: string, progress: number) => void;

/* eslint-disable @typescript-eslint/no-explicit-any */
function decode(node: any, buffers: ArrayBufferView[]): any {
  if (Array.isArray(node)) return node.map((n) => decode(n, buffers));
  if (node && typeof node === "object") {
    if (typeof node.$buf === "number") return { data: buffers[node.$buf], shape: node.shape };
    const out: Record<string, unknown> = {};
    for (const k in node) out[k] = decode(node[k], buffers);
    return out;
  }
  return node;
}

class Engine {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ready: Promise<void> | null = null;
  onStatus: StatusListener = () => {};

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "status") return this.onStatus(m.stage, m.progress);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(decode(m.result, m.buffers));
      else p.reject(new Error(m.error));
    };
    this.worker.onerror = (ev) => {
      for (const p of this.pending.values()) p.reject(new Error(ev.message || "The engine stopped unexpectedly."));
      this.pending.clear();
    };
    this.ready = this.send("init").then(() => undefined);
    return this.ready;
  }

  private send<T>(cmd: string, args?: unknown, extra?: Record<string, unknown>, transfer: Transferable[] = []) {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ id, cmd, args, ...extra }, transfer);
    });
  }

  async call<T = any>(cmd: string, args?: unknown): Promise<T> {
    await this.start();
    return this.send<T>(cmd, args);
  }

  async loadFiles<T = any>(files: File[]): Promise<T> {
    await this.start();
    const payload = await Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })));
    return this.send<T>("load_files", undefined, { files: payload }, payload.map((p) => p.data));
  }
}

export const engine = new Engine();
