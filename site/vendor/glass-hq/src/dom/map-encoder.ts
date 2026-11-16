import { encodeMapPixelsYielding } from "./map-encoding";

export interface MaterialEncoder {
  encode(pixels: Uint8Array, width: number, height: number): Promise<string[][]>;
  mode(): "idle" | "worker" | "fallback";
  dispose(): void;
}

/** Adapted from Guangcai a24ffb03: Next-compatible module worker, with a
 * serialized cooperative fallback. Input pixels stay available after a worker
 * failure; postMessage deliberately does not transfer/detach their buffer. */
export function createMaterialEncoder(): MaterialEncoder {
  let worker: Worker | undefined;
  let unavailable = false, disposed = false, sequence = 0;
  let state: ReturnType<MaterialEncoder["mode"]> = "idle";
  let fallbackQueue: Promise<unknown> = Promise.resolve();
  const pending = new Map<number, { resolve: (planes: string[][]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  function failWorker() {
    unavailable = true;
    worker?.terminate(); worker = undefined;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Material encoder worker unavailable"));
    }
    pending.clear();
  }
  function getWorker() {
    if (disposed || unavailable || typeof Worker === "undefined") return;
    if (worker) return worker;
    try {
      worker = new Worker(new URL("./map-encoder.worker.js", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }: MessageEvent<{ id: number; planes?: string[][]; error?: string }>) => {
        const request = pending.get(data.id);
        if (!request) return;
        clearTimeout(request.timer); pending.delete(data.id);
        if (data.error || !data.planes) request.reject(new Error(data.error || "Invalid encoded maps"));
        else request.resolve(data.planes);
      };
      worker.onerror = event => { event.preventDefault(); failWorker(); };
      worker.onmessageerror = failWorker;
      return worker;
    } catch { failWorker(); return; }
  }
  return {
    async encode(pixels, width, height) {
      if (disposed) throw new Error("Material encoder disposed");
      const target = getWorker();
      if (target) {
        state = "worker";
        try {
          return await new Promise<string[][]>((resolve, reject) => {
            const id = ++sequence;
            const timer = setTimeout(failWorker, 10_000);
            pending.set(id, { resolve, reject, timer });
            try { target.postMessage({ id, pixels, width, height }); }
            catch { failWorker(); }
          });
        } catch { if (disposed) throw new Error("Material encoder disposed"); }
      }
      state = "fallback";
      const job = fallbackQueue.catch(() => {}).then(async () => {
        if (disposed) throw new Error("Material encoder disposed");
        return encodeMapPixelsYielding(pixels, width, height, () => {
          if (disposed) return Promise.reject(new Error("Material encoder disposed"));
          return new Promise<void>(resolve => setTimeout(resolve, 0));
        });
      });
      fallbackQueue = job;
      return job;
    },
    mode: () => state,
    dispose() { disposed = true; failWorker(); },
  };
}
