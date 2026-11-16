import { encodeMapPixels } from "./map-encoding";

// Worker-owned serialization returns each useful map without waiting for the
// rest of a batch. No live DOM, shader or application state enters this worker.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; pixels: Uint8Array; width: number; height: number }>) => void) | null;
  postMessage: (message: { id: number; planes?: string[][]; error?: string }) => void;
};
let queue: Promise<void> = Promise.resolve();
scope.onmessage = ({ data: { id, pixels, width, height } }) => {
  queue = queue.then(async () => {
    try { scope.postMessage({ id, planes: await encodeMapPixels(pixels, width, height) }); }
    catch (error) { scope.postMessage({ id, error: String(error) }); }
  });
};
