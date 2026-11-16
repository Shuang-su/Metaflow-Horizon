import { encodeMapPixels } from "./map-encoding";

// No DOM or application state enters this serialized worker. Absolute worker
// timestamps can be compared to window events despite distinct time origins.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; pixels: Uint8Array; width: number; height: number; trace?: boolean }>) => void) | null;
  postMessage: (message: { id?: number; type?: "ready" | "trace"; name?: string; absoluteAt?: number; planes?: string[][]; error?: string }) => void;
};
const absolute = () => performance.timeOrigin + performance.now();
scope.postMessage({ type: "ready", absoluteAt: absolute() });
let queue: Promise<void> = Promise.resolve();
scope.onmessage = ({ data: { id, pixels, width, height, trace } }) => {
  if (trace) scope.postMessage({ id, type: "trace", name: "encode-worker-received", absoluteAt: absolute() });
  queue = queue.then(async () => {
    try {
      if (trace) scope.postMessage({ id, type: "trace", name: "encode-worker-start", absoluteAt: absolute() });
      const planes = await encodeMapPixels(pixels, width, height);
      if (trace) scope.postMessage({ id, type: "trace", name: "encode-worker-end", absoluteAt: absolute() });
      scope.postMessage({ id, planes });
    } catch (error) { scope.postMessage({ id, error: String(error) }); }
  });
};
