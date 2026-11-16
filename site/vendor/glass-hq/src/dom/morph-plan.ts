import { morphLocalCoordinate } from "../core/morph-path";
import type { Box, MorphEndpoints, MorphGlass, MorphPlanOptions, MorphStop } from "../core/morph-path";
import { abortPlanError, traceMorphAsync } from "../core/morph-plan-async";

export type MorphPlanTrace = (name: string, detail: Record<string, unknown>) => void;
export interface MorphPlanRequestOptions { signal?: AbortSignal; onTrace?: MorphPlanTrace }
interface WorkerLike {
  postMessage(value: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}
interface Job {
  id: number; key: string; endpoints: MorphEndpoints; glass?: MorphGlass; options: MorphPlanOptions;
  controller: AbortController; promise: Promise<MorphStop[]>;
  resolve(stops: MorphStop[]): void; reject(error: unknown): void;
  consumers: number; fallback: boolean;
}
/** Layout dimensions, around the live center: press transforms affect placement,
 * never the traced contour or material-cache key. */
export function morphLayoutBox(rect: Box, size: { width: number; height: number }): Box {
  const width = size.width || rect.width, height = size.height || rect.height;
  return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
}
export function createMorphPlanService(config: { workerFactory?: () => WorkerLike; onTrace?: MorphPlanTrace; yieldTask?: () => Promise<void> } = {}) {
  const cache = new Map<string, MorphStop[]>(), jobs = new Map<string, Job>();
  let worker: WorkerLike | undefined, unavailable = false, serial = 0;
  const trace = (name: string, detail: Record<string, unknown>) => {
    config.onTrace?.(name, detail);
    if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent("glass-plan-trace", { detail: { name, detail } }));
  };
  const finish = (job: Job, stops?: MorphStop[], error?: unknown) => {
    if (jobs.get(job.key) !== job) return;
    jobs.delete(job.key);
    if (stops) {
      cache.set(job.key, stops);
      if (cache.size > 16) cache.delete(cache.keys().next().value!);
      job.resolve(stops);
    } else job.reject(error);
  };
  const fallback = (job: Job) => {
    if (job.fallback || job.controller.signal.aborted) return;
    job.fallback = true;
    trace("plan-fallback-start", { id: job.id });
    void traceMorphAsync(job.endpoints, job.glass, job.options, { signal: job.controller.signal, yieldTask: config.yieldTask,
      onSlice: durationMs => trace("plan-fallback-slice", { id: job.id, durationMs }),
    }).then(stops => finish(job, stops), error => finish(job, undefined, error));
  };
  const failWorker = () => {
    unavailable = true; worker?.terminate(); worker = undefined;
    trace("plan-worker-failure", {});
    for (const job of jobs.values()) fallback(job);
  };
  const getWorker = () => {
    if (unavailable) return;
    if (!worker) {
      try {
        worker = config.workerFactory ? config.workerFactory() : new Worker(new URL("./morph-plan.worker.js", import.meta.url), { type: "module" });
        trace("plan-worker-created", {});
        worker.onmessage = ({ data }) => {
          const job = [...jobs.values()].find(item => item.id === data.id);
          if (!job || job.fallback) return;
          if (data.error) { trace("plan-worker-job-failure", { id: job.id, error: data.error }); fallback(job); }
          else { trace("plan-worker-complete", { id: job.id, ...data.timing }); finish(job, data.stops); }
        };
        worker.onerror = failWorker;
      } catch { failWorker(); }
    }
    return worker;
  };
  const cancel = (job: Job) => {
    job.controller.abort();
    worker?.postMessage({ id: job.id, cancel: true });
    finish(job, undefined, abortPlanError());
  };
  return {
    request(e: MorphEndpoints, glass: MorphGlass | undefined, options: MorphPlanOptions = {}, request: MorphPlanRequestOptions = {}): Promise<MorphStop[]> {
      if (request.signal?.aborted) return Promise.reject(abortPlanError());
      const origin = glass ?? e.from;
      const local = (box: Box): Box => ({ ...box, left: morphLocalCoordinate(box.left - origin.left), top: morphLocalCoordinate(box.top - origin.top) });
      const endpoints = { ...e, from: local(e.from), to: local(e.to) };
      const own = glass ? { ...glass, left: 0, top: 0 } : undefined;
      const key = JSON.stringify([endpoints, own, options]);
      // Retain raw operands alongside the exact normalized key for diagnosis.
      const identity = { key, endpoints, glass: own ?? null, options: { ...options },
        rawEndpoints: e, rawGlass: glass ?? null, positionGrid: 1 / 64 };
      const place = (stops: MorphStop[]) => stops.map(stop => ({ ...stop, shape: { ...stop.shape }, ...(stop.box ? { box: { ...stop.box, left: stop.box.left + origin.left, top: stop.box.top + origin.top } } : {}) }));
      const hit = cache.get(key);
      if (hit) { cache.delete(key); cache.set(key, hit); request.onTrace?.("plan-cache-hit", identity); trace("plan-cache-hit", identity); return Promise.resolve(place(hit)); }
      let job = jobs.get(key);
      if (!job) {
        let resolve!: Job["resolve"], reject!: Job["reject"];
        const promise = new Promise<MorphStop[]>((yes, no) => { resolve = yes; reject = no; });
        job = { id: ++serial, key, endpoints, glass: own, options, controller: new AbortController(), promise, resolve, reject, consumers: 0, fallback: false };
        jobs.set(key, job);
        trace("plan-request", { id: job.id, ...identity });
        const target = getWorker();
        if (target) { try { target.postMessage({ id: job.id, endpoints, glass: own, options }); } catch { failWorker(); } }
        else fallback(job);
      }
      const current = job;
      current.consumers++;
      return new Promise((resolve, reject) => {
        let done = false;
        const release = () => { if (done) return false; done = true; request.signal?.removeEventListener("abort", abort); current.consumers--; return true; };
        const abort = () => { if (!release()) return; reject(abortPlanError()); if (!current.consumers && jobs.get(key) === current) cancel(current); };
        request.signal?.addEventListener("abort", abort, { once: true });
        current.promise.then(stops => { if (release()) { request.onTrace?.("plan-ready", { id: current.id }); resolve(place(stops)); } }, error => { if (release()) reject(error); });
      });
    },
    cancel() { for (const job of [...jobs.values()]) cancel(job); },
    dispose() {
      this.cancel();
      const terminatedWorker = Boolean(worker);
      worker?.terminate(); worker = undefined; cache.clear();
      trace("plan-service-dispose", { terminatedWorker });
    },
  };
}
let shared: ReturnType<typeof createMorphPlanService> | undefined;
let removeSharedPagehide: (() => void) | undefined;
/** End this document owner's work explicitly. A BFCache restore or a new
 * owner may request another plan; the next request creates a fresh service. */
export function disposeMorphPlans() {
  const previous = shared;
  shared = undefined;
  removeSharedPagehide?.(); removeSharedPagehide = undefined;
  previous?.dispose();
}
function sharedService() {
  if (!shared) {
    shared = createMorphPlanService();
    if (typeof window !== "undefined") {
      const owner = window;
      owner.addEventListener?.("pagehide", disposeMorphPlans);
      removeSharedPagehide = () => owner.removeEventListener?.("pagehide", disposeMorphPlans);
    }
  }
  return shared;
}
export const requestMorphPlan = (e: MorphEndpoints, glass: MorphGlass | undefined, options: MorphPlanOptions = {}, request: MorphPlanRequestOptions = {}) =>
  sharedService().request(e, glass, options, request);
export const cancelMorphPlans = () => shared?.cancel();
