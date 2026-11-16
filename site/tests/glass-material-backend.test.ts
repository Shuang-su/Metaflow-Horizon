import assert from "node:assert/strict";
import { test } from "node:test";
import { WebGL2MaterialRenderer } from "../vendor/glass-hq/src/webgl2/index";

async function withGPU(run: (fixture: { renderer: WebGL2MaterialRenderer; stats: { draws: number; held: boolean } }) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const stats = { draws: 0, held: false };
  const constants = { MAX_TEXTURE_SIZE: 1, MAX_RENDERBUFFER_SIZE: 2, FRAMEBUFFER_COMPLETE: 3, TIMEOUT_EXPIRED: 4, WAIT_FAILED: 5 };
  const methods = {
    ...constants,
    getParameter: () => 8192, getShaderParameter: () => true, getProgramParameter: () => true,
    getUniformLocation: () => ({}), checkFramebufferStatus: () => constants.FRAMEBUFFER_COMPLETE,
    isContextLost: () => false, clientWaitSync: () => stats.held ? constants.TIMEOUT_EXPIRED : 0,
    drawArrays: () => { stats.draws++; }, getBufferSubData: (_target: unknown, _offset: unknown, array: Uint8Array) => array.fill(127),
  };
  const gl = new Proxy(methods, { get(target, key) {
    if (key in target) return Reflect.get(target, key);
    if (typeof key === "string" && (key.startsWith("create") || key === "fenceSync")) return () => ({});
    return () => {};
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ getContext: () => gl, addEventListener() {}, removeEventListener() {} }) } });
  let renderer: WebGL2MaterialRenderer | undefined;
  try { renderer = new WebGL2MaterialRenderer(); await run({ renderer, stats }); }
  finally {
    renderer?.dispose();
    if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document");
  }
}

test("each backend request traces GPU enqueue, draw, fence and readback with one ID and absolute times", async () => withGPU(async ({ renderer }) => {
  const events: { name: string; id: unknown; at: number; absolute: unknown }[] = [];
  const result = await renderer.render({ width: 44, height: 44, radius: "circle", dpr: 1 }, {
    requestId: "cold-gpu", trace: (name, detail, at = 0) => events.push({ name, id: detail?.requestId, at, absolute: detail?.absoluteTime }),
  });
  assert.equal(result.pixels.length, 48 * 48 * 8);
  assert.deepEqual(events.map(event => event.name), ["gpu-enqueue", "gpu-draw-start", "gpu-draw-end", "gpu-fence-enqueue", "gpu-fence-ready", "gpu-readback-start", "gpu-readback-end"]);
  assert.ok(events.every(event => event.id === "cold-gpu" && typeof event.absolute === "number" && event.absolute > 1_000_000_000_000));
  assert.ok(events.every((event, i) => !i || event.at >= events[i - 1].at));
}));

test("backend pending metadata and concurrent atlas batches stay bounded and disposal rejects all queued work", async () => withGPU(async ({ renderer, stats }) => {
  stats.held = true;
  const requests = Array.from({ length: 64 }, () => renderer.render({ width: 44, height: 1000, radius: 22, dpr: 1 }));
  const settled = Promise.allSettled(requests);
  await new Promise(resolve => setTimeout(resolve, 12));
  assert.equal(stats.draws, 2);
  renderer.dispose();
  const results = await settled;
  assert.ok(results.every(result => result.status === "rejected"));
  assert.ok(results.some(result => result.status === "rejected" && /bounded queue/.test(String(result.reason))));
}));

test("GPU atlas batches separate demand from next and warm work", async () => withGPU(async ({ renderer, stats }) => {
  const order: string[] = [];
  const geometry = { width: 44, height: 44, radius: 22, dpr: 1 };
  const jobs = [
    ["warm", 2], ["next", 1], ["urgent", 0],
  ].map(([id, priority]) => renderer.render(geometry, { requestId: String(id), priority: Number(priority),
    trace: name => { if (name === "gpu-draw-start") order.push(String(id)); } }));
  await Promise.all(jobs);
  assert.deepEqual(order, ["urgent", "next", "warm"]);
  assert.equal(stats.draws, 3, "warm atlas cost is never merged into a demanded atlas");
}));
