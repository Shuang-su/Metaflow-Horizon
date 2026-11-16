import { encodeMapPixelsYielding } from "./map-encoding";
import type { MaterialRequestOptions, MaterialTrace } from "../webgl2/index";

export interface MaterialEncoder {
  encode(pixels: Uint8Array, width: number, height: number, options?: MaterialRequestOptions): Promise<string[][]>;
  mode(): "idle" | "worker" | "fallback";
  dispose(): void;
}
type Job = { id: number; pixels: Uint8Array; width: number; height: number; options: MaterialRequestOptions;
  resolve: (planes: string[][]) => void; reject: (error: Error) => void };
type WorkerMessage = { id?: number; type?: "ready" | "trace"; name?: string; absoluteAt?: number; planes?: string[][]; error?: string };

/** Lazy cold start, one active encoding operation, and bounded retained input.
 * A failed worker leaves the original buffer intact for cooperative fallback. */
export function createMaterialEncoder(options: { maxPending?: number; maxPixelBytes?: number; trace?: MaterialTrace } = {}): MaterialEncoder {
  let worker: Worker | undefined;
  let unavailable = false, disposed = false, sequence = 0, active: Job | undefined;
  let state: ReturnType<MaterialEncoder["mode"]> = "idle";
  const queue: Job[] = [];
  const maxPending = Math.max(1, options.maxPending ?? 4), maxPixelBytes = Math.max(1, options.maxPixelBytes ?? 16 * 1024 * 1024);
  let pending: { job: Job; resolve: (planes: string[][]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  const emit = (job: Job | undefined, name: string, absoluteAt = performance.timeOrigin + performance.now()) => {
    const trace = job?.options.trace ?? options.trace;
    trace?.(name, { requestId: job?.options.requestId ?? `material-encode-${job?.id ?? 0}`, absoluteTime: absoluteAt }, absoluteAt - performance.timeOrigin);
  };
  function failWorker() {
    unavailable = true; worker?.terminate(); worker = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error("Material encoder worker unavailable")); pending = undefined; }
  }
  function getWorker(job: Job) {
    if (disposed || unavailable || typeof Worker === "undefined") return;
    if (worker) return worker;
    try {
      emit(job, "encode-worker-spawn");
      worker = new Worker(new URL("./map-encoder.worker.js", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
        if (data.type === "ready") { emit(pending?.job ?? job, "encode-worker-ready", data.absoluteAt); return; }
        const request = pending;
        if (!request || data.id !== request.job.id) return;
        if (data.type === "trace") { emit(request.job, data.name || "encode-worker-trace", data.absoluteAt); return; }
        clearTimeout(request.timer); pending = undefined;
        if (data.error || !data.planes) request.reject(new Error(data.error || "Invalid encoded maps"));
        else request.resolve(data.planes);
      };
      worker.onerror = event => { event.preventDefault(); failWorker(); };
      worker.onmessageerror = failWorker;
      return worker;
    } catch { failWorker(); return; }
  }
  async function run(job: Job) {
    try {
      const target = getWorker(job);
      if (target) {
        state = "worker";
        try {
          const result = await new Promise<string[][]>((resolve, reject) => {
            pending = { job, resolve, reject, timer: setTimeout(failWorker, 10_000) };
            try {
              emit(job, "encode-worker-queued");
              target.postMessage({ id: job.id, pixels: job.pixels, width: job.width, height: job.height, trace: Boolean(job.options.trace ?? options.trace) });
            } catch { failWorker(); }
          });
          if (!disposed) job.resolve(result);
          return;
        } catch { if (disposed) throw new Error("Material encoder disposed"); }
      }
      state = "fallback"; emit(job, "encode-fallback-start");
      const result = await encodeMapPixelsYielding(job.pixels, job.width, job.height, () => {
        if (disposed) return Promise.reject(new Error("Material encoder disposed"));
        return new Promise<void>(resolve => setTimeout(resolve, 0));
      });
      emit(job, "encode-fallback-end");
      if (!disposed) job.resolve(result);
    } catch (error) { job.reject(error instanceof Error ? error : new Error(String(error))); }
    finally { active = undefined; if (!disposed) pump(); }
  }
  function pump() {
    if (disposed || active || !queue.length) return;
    queue.sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0) || a.id - b.id);
    active = queue.shift()!; void run(active);
  }
  return {
    encode(pixels, width, height, requestOptions = {}) {
      if (disposed) return Promise.reject(new Error("Material encoder disposed"));
      const retained = queue.reduce((sum, job) => sum + job.pixels.byteLength, active?.pixels.byteLength ?? 0);
      if (queue.length + Number(Boolean(active)) >= maxPending || retained + pixels.byteLength > maxPixelBytes) {
        return Promise.reject(new Error("Material encoder bounded queue is full"));
      }
      return new Promise<string[][]>((resolve, reject) => {
        const job = { id: ++sequence, pixels, width, height, options: requestOptions, resolve, reject };
        queue.push(job); emit(job, "encode-queued"); queueMicrotask(pump);
      });
    },
    mode: () => state,
    dispose() {
      if (disposed) return;
      disposed = true; failWorker();
      active?.reject(new Error("Material encoder disposed"));
      for (const job of queue.splice(0)) job.reject(new Error("Material encoder disposed"));
    },
  };
}
