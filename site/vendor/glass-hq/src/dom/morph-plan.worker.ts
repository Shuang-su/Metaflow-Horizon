import { traceMorphAsync } from "../core/morph-plan-async";
import type { MorphEndpoints, MorphGlass, MorphPlanOptions } from "../core/morph-path";
const jobs = new Map<number, AbortController>();
// Posted tasks yield to cancel messages without the nested setTimeout clamp.
// Close idle ports so the worker owns no unnecessary live scheduler resources.
let channel: MessageChannel | undefined;
const continuations: (() => void)[] = [];
function yieldWorkerTask(): Promise<void> {
  return new Promise(resolve => {
    if (!channel) {
      channel = new MessageChannel();
      channel.port1.onmessage = () => continuations.shift()?.();
    }
    continuations.push(resolve);
    channel.port2.postMessage(null);
  });
}
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; cancel?: boolean; endpoints: MorphEndpoints; glass?: MorphGlass; options: MorphPlanOptions }>) => void) | null;
  postMessage(value: unknown): void;
};
scope.onmessage = ({ data }) => {
  if (data.cancel) { jobs.get(data.id)?.abort(); return; }
  const controller = new AbortController();
  jobs.set(data.id, controller);
  const received = performance.now();
  let started: number | undefined;
  let slices = 0, maxSliceMs = 0, computeMs = 0;
  const timing = () => {
    const completed = performance.now();
    return {
      durationMs: completed - received, slices, maxSliceMs, computeMs,
      workerReceivedAt: performance.timeOrigin + received,
      workerStartedAt: performance.timeOrigin + (started ?? received),
      workerCompletedAt: performance.timeOrigin + completed,
      workerTimeOrigin: performance.timeOrigin,
      scheduler: "message-channel",
    };
  };
  void traceMorphAsync(data.endpoints, data.glass, data.options, {
    signal: controller.signal,
    yieldTask: async () => { await yieldWorkerTask(); started ??= performance.now(); },
    onSlice(ms) { slices++; computeMs += ms; maxSliceMs = Math.max(maxSliceMs, ms); },
  }).then(stops => scope.postMessage({ id: data.id, stops, timing: timing() }),
    error => scope.postMessage({ id: data.id, error: String(error), aborted: controller.signal.aborted, timing: timing() }))
    .finally(() => {
      jobs.delete(data.id);
      if (!jobs.size && !continuations.length) { channel?.port1.close(); channel?.port2.close(); channel = undefined; }
    });
};
