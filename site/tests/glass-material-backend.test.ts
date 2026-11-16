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
  assert.deepEqual(events.map(event => event.name), ["gpu-enqueue", "gpu-draw-start", "gpu-draw-end", "gpu-fence-enqueue", "gpu-fence-ready", "gpu-readback-start",
    "gpu-atlas-allocation-start", "gpu-atlas-allocation-end", "gpu-get-buffer-sub-data-start", "gpu-get-buffer-sub-data-end",
    "gpu-band-unpack-start", "gpu-band-unpack-end", "gpu-readback-end"]);
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


test("batch readback phases keep each request ID and distinguish shared atlas work from its own band", async () => withGPU(async ({ renderer }) => {
  await renderer.warmed;
  const events: { name: string; detail: Record<string, unknown>; at: number }[] = [];
  const trace = (name: string, detail: Record<string, unknown> = {}, at = 0) => events.push({ name, detail, at });
  const shapes = [{ width: 159 - 4, height: 194 - 4, radius: 24, dpr: 1 }, { width: 174 - 4, height: 205 - 4, radius: 24, dpr: 1 }];
  const results = await Promise.all(shapes.map((shape, i) => renderer.render(shape, { requestId: `band-${i}`, trace })));
  for (const [i, result] of results.entries()) {
    const mine = events.filter(event => event.detail.requestId === `band-${i}`);
    const allocation = mine.find(event => event.name === "gpu-atlas-allocation-end")!;
    assert.equal(allocation.detail.bytes, 174 * (194 + 205) * 2 * 4);
    const unpack = mine.find(event => event.name === "gpu-band-unpack-end")!;
    assert.equal(unpack.detail.band, i);
    assert.equal(unpack.detail.bytes, result.pixels.byteLength);
    assert.equal(unpack.detail.includesAllocation, true);
    assert.ok(mine.find(event => event.name === "gpu-get-buffer-sub-data-end")!.at <= unpack.at);
  }
  const shared = events.filter(event => event.name === "gpu-get-buffer-sub-data-start");
  assert.equal(shared[0].at, shared[1].at, "both requests share one synchronous PBO readback");
}));

test("disabled readback diagnostics add no timing reads to the production render path", async () => withGPU(async ({ renderer }) => {
  await renderer.warmed;
  const original = Object.getOwnPropertyDescriptor(globalThis, "performance");
  let reads = 0;
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { timeOrigin: 0, now: () => ++reads } });
  try {
    await renderer.render({ width: 44, height: 44, radius: 22, dpr: 1 });
    // Existing request start, fence deadline and result duration only.
    assert.equal(reads, 3);
  } finally {
    if (original) Object.defineProperty(globalThis, "performance", original); else Reflect.deleteProperty(globalThis, "performance");
  }
}));
