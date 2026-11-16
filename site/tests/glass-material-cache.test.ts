import assert from "node:assert/strict";
import { test } from "node:test";
import { createGlassMaterialCache, glassMaterialGeometry, type GlassMaterialCacheOptions } from "../lib/glass-material-cache";
import type { MaterialBackend } from "../vendor/glass-hq/src/webgl2/index";
import type { MapGeometry } from "../vendor/glass-hq/src/gpu/geometry";
import type { MaterialEncoder } from "../vendor/glass-hq/src/dom/map-encoder";

const circle: MapGeometry = { width: 44, height: 44, radius: "circle" };
const delay = (ms = 2) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!check()) { if (Date.now() > deadline) throw new Error("resource test timed out"); await delay(); }
}
function fixture(overrides: Partial<GlassMaterialCacheOptions> = {}, hold = false) {
  const renders: MapGeometry[] = [], pending: (() => void)[] = [], failures: Error[] = [];
  let decoded = 0, ready = 0, rendererDisposed = 0, encoderDisposed = 0;
  const renderer: MaterialBackend = {
    warmed: Promise.resolve(), dispose() { rendererDisposed++; },
    render(g) {
      renders.push(g);
      const { width, height } = glassMaterialGeometry(g, g.appearance || "light", 1);
      const result = { width, height, pixels: new Uint8Array(width * height * 8), duration: 0 };
      return hold ? new Promise(resolve => pending.push(() => resolve(result))) : Promise.resolve(result);
    },
  };
  const encoder: MaterialEncoder = {
    async encode(_pixels, width, height) { return [[`field:${width}:${height}`], [`rim:${width}:${height}`]]; },
    mode: () => "fallback", dispose() { encoderDisposed++; },
  };
  const cache = createGlassMaterialCache(renderer, {
    encoder, async decodeImage(url) { decoded++; return { src: url } as HTMLImageElement; },
    onReady() { ready++; }, onFailure(error) { failures.push(error); }, ...overrides,
  });
  return { cache, renders, pending, failures, stats: () => ({ decoded, ready, rendererDisposed, encoderDisposed }) };
}

test("rest DPR is capped at 2, explicit motion DPR wins, and keys match the effective raster", () => {
  const rest = glassMaterialGeometry(circle, "light", 3);
  const motion = glassMaterialGeometry({ ...circle, dpr: 1 }, "light", 3);
  assert.deepEqual([rest.width, rest.height, rest.geometry.dpr], [96, 96, 2]);
  assert.deepEqual([motion.width, motion.height, motion.geometry.dpr], [48, 48, 1]);
  assert.notEqual(rest.key, motion.key);
  assert.equal(rest.key, glassMaterialGeometry({ ...circle, dpr: 2 }, "light", 1).key);
  assert.notEqual(rest.key, glassMaterialGeometry(circle, "dark", 3).key);
  const large = glassMaterialGeometry({ width: 5000, height: 100, radius: 10 }, "light", 2);
  assert.ok(large.width <= 4096);
  assert.ok(large.effectiveDpr < 1);
});

test("cache retains decoded maps, deduplicates requests, and generates no maps for stable gets", async () => {
  const f = fixture();
  assert.equal(f.cache.get(circle, "light", 2), undefined);
  f.cache.get(circle, "light", 2);
  await until(() => f.cache.diagnostics().readyEntries === 1);
  const a = f.cache.get(circle, "light", 2);
  for (let i = 0; i < 10; i++) assert.equal(f.cache.get(circle, "light", 2), a);
  assert.equal(f.renders.length, 1);
  assert.equal(f.stats().decoded, 2);
  assert.equal(f.cache.diagnostics().decodedBytes, 96 * 96 * 8);
  f.cache.get({ ...circle, dpr: 1 }, "light", 2);
  await until(() => f.cache.diagnostics().readyEntries === 2);
  assert.equal(f.renders[1].dpr, 1);
  f.cache.dispose();
});

test("frame pins survive LRU pressure while unpinned resources are evicted", async () => {
  const f = fixture({ maxEntries: 2 });
  const b = { ...circle, width: 46 }, c = { ...circle, width: 48 };
  f.cache.get(circle, "light", 1); f.cache.get(b, "light", 1);
  await until(() => f.cache.diagnostics().readyEntries === 2);
  const a = f.cache.get(circle, "light", 1);
  f.cache.beginFrame(); f.cache.pin(a); f.cache.endFrame();
  f.cache.get(c, "light", 1);
  await until(() => f.cache.diagnostics().generated === 3);
  assert.equal(f.cache.get(circle, "light", 1), a);
  assert.equal(f.cache.diagnostics().entries, 2);
  assert.equal(f.cache.diagnostics().evictions, 1);
  assert.equal(f.cache.diagnostics().pinnedEntries, 1);
  f.cache.dispose();
});

test("pinned decoded resources defer work within the byte budget without triggering fallback", async () => {
  const f = fixture({ maxDecodedBytes: 48 * 48 * 8, maxTransitionBytes: 0 });
  f.cache.get(circle, "light", 1);
  await until(() => f.cache.diagnostics().readyEntries === 1);
  f.cache.beginFrame(); f.cache.pin(f.cache.get(circle, "light", 1)); f.cache.endFrame();
  f.cache.get({ ...circle, radius: 12 }, "light", 1);
  await delay(20);
  assert.equal(f.renders.length, 1);
  assert.equal(f.cache.diagnostics().queued, 1);
  assert.equal(f.failures.length, 0);
  f.cache.beginFrame(); f.cache.endFrame();
  await until(() => f.cache.diagnostics().generated === 2);
  assert.ok(f.cache.diagnostics().decodedBytes + f.cache.diagnostics().reservedBytes <= 48 * 48 * 8);
  f.cache.dispose();
});

test("visible demand overtakes prewarm and concurrent generation is bounded", async () => {
  const f = fixture({ maxPending: 1 }, true);
  f.cache.prewarm([circle, { ...circle, width: 46 }], "dark", 1);
  f.cache.get({ ...circle, width: 60 }, "light", 1);
  await until(() => f.renders.length === 1);
  assert.equal(f.renders[0].width, 60);
  assert.equal(f.cache.diagnostics().inFlight, 1);
  f.pending.shift()!();
  await until(() => f.renders.length === 2);
  assert.equal(f.cache.diagnostics().inFlight, 1);
  f.pending.shift()!();
  await until(() => f.renders.length === 3);
  f.pending.shift()!();
  await until(() => f.cache.diagnostics().inFlight === 0);
  f.cache.dispose();
});

test("dispose drops resources and suppresses late callbacks without disposing the renderer", async () => {
  const f = fixture({}, true);
  f.cache.get(circle, "light", 1);
  await until(() => f.pending.length === 1);
  f.cache.dispose(); f.pending.shift()!(); await delay(5);
  assert.deepEqual(f.stats(), { decoded: 0, ready: 0, rendererDisposed: 0, encoderDisposed: 1 });
  assert.equal(f.failures.length, 0);
  assert.equal(f.cache.diagnostics().entries, 0);
});

test("actual decode failure is reported once and is not retried on every frame", async () => {
  const f = fixture({ decodeImage: async () => { throw new Error("decode failed"); } });
  f.cache.get(circle, "light", 1);
  await until(() => f.failures.length === 1);
  f.cache.get(circle, "light", 1); await delay(10);
  assert.equal(f.renders.length, 1);
  assert.equal(f.failures[0].message, "decode failed");
  assert.equal(f.cache.diagnostics().decodedBytes, 0);
  f.cache.dispose();
});

test("encoded budget pressure does not spin encoding while active maps are pinned", async () => {
  const f = fixture({ maxEncodedBytes: 45, maxEncodedTransitionBytes: 0 });
  f.cache.get(circle, "light", 1);
  await until(() => f.cache.diagnostics().readyEntries === 1);
  f.cache.beginFrame(); f.cache.pin(f.cache.get(circle, "light", 1)); f.cache.endFrame();
  f.cache.get({ ...circle, radius: 12 }, "light", 1);
  await until(() => f.renders.length === 2 && f.cache.diagnostics().inFlight === 0);
  await delay(20);
  assert.equal(f.renders.length, 2);
  assert.equal(f.cache.diagnostics().queued, 1);
  assert.equal(f.failures.length, 0);
  f.cache.beginFrame(); f.cache.endFrame();
  await until(() => f.cache.diagnostics().generated === 2);
  assert.ok(f.cache.diagnostics().encodedBytes <= 45);
  f.cache.dispose();
});

test("default budget admits full-size 2x menus and a pinned light-to-dark transition", async () => {
  const f = fixture();
  const menu = { width: 326, height: 800, radius: 24 };
  f.cache.get(menu, "light", 2);
  await until(() => f.cache.diagnostics().readyEntries === 1);
  const light = f.cache.get(menu, "light", 2);
  f.cache.beginFrame(); f.cache.pin(light); f.cache.endFrame();
  f.cache.get(menu, "dark", 2);
  await until(() => f.cache.diagnostics().readyEntries === 2);
  const dark = f.cache.get(menu, "dark", 2);
  assert.ok(dark);
  assert.ok(f.renders.every(shape => shape.dpr === 2));
  assert.ok(f.cache.diagnostics().transitionBytes > 0);
  assert.ok(f.cache.diagnostics().decodedBytes <= 32 * 1024 * 1024);
  f.cache.beginFrame(); f.cache.pin(dark); f.cache.endFrame();
  assert.equal(f.cache.diagnostics().transitionBytes, 0);
  assert.equal(f.cache.diagnostics().readyEntries, 1);
  assert.equal(f.failures.length, 0);
  f.cache.dispose();
});

test("326x500 2x light maps never deadlock the demanded dark maps", async () => {
  const f = fixture();
  const menu = { width: 326, height: 500, radius: 24 };
  f.cache.get(menu, "light", 2);
  await until(() => f.cache.diagnostics().readyEntries === 1);
  f.cache.beginFrame(); f.cache.pin(f.cache.get(menu, "light", 2)); f.cache.endFrame();
  f.cache.get(menu, "dark", 2);
  await until(() => f.cache.diagnostics().readyEntries === 2);
  assert.ok(f.cache.get(menu, "dark", 2));
  assert.ok(f.renders.every(shape => shape.dpr === 2));
  f.cache.dispose();
});

test("prewarm cannot borrow transition headroom held by an active large menu", async () => {
  const f = fixture();
  const menu = { width: 326, height: 800, radius: 24 };
  f.cache.get(menu, "light", 2);
  await until(() => f.cache.diagnostics().readyEntries === 1);
  f.cache.beginFrame(); f.cache.pin(f.cache.get(menu, "light", 2)); f.cache.endFrame();
  f.cache.prewarm([menu], "dark", 2);
  await delay(50);
  assert.equal(f.renders.length, 1);
  f.cache.get(menu, "dark", 2);
  await until(() => f.cache.diagnostics().readyEntries === 2);
  assert.equal(f.renders.length, 2);
  f.cache.dispose();
});

test("only an oversized shape lowers DPR and impossible 1x resources fail explicitly once", async () => {
  const f = fixture({ maxDecodedBytes: 48 * 48 * 8 });
  f.cache.get(circle, "light", 2);
  await until(() => f.cache.diagnostics().readyEntries === 1);
  assert.equal(f.renders[0].dpr, 1);
  assert.equal(f.cache.get({ ...circle, dpr: 1 }, "light", 2), f.cache.get(circle, "light", 2));
  const impossible = { width: 100, height: 100, radius: 24 };
  f.cache.get(impossible, "light", 2); f.cache.get(impossible, "light", 2);
  assert.equal(f.failures.length, 1);
  assert.match(f.failures[0].message, /even at 1x/);
  assert.equal(f.cache.diagnostics().queued, 0);
  f.cache.dispose();
});


test("encoded theme transition has bounded headroom and trims after the old pin is released", async () => {
  const f = fixture({ maxEncodedBytes: 45, maxEncodedTransitionBytes: 45 });
  f.cache.get(circle, "light", 1);
  await until(() => f.cache.diagnostics().readyEntries === 1);
  f.cache.beginFrame(); f.cache.pin(f.cache.get(circle, "light", 1)); f.cache.endFrame();
  f.cache.get(circle, "dark", 1);
  await until(() => f.cache.diagnostics().readyEntries === 2);
  assert.ok(f.cache.diagnostics().encodedTransitionBytes > 0);
  f.cache.beginFrame(); f.cache.pin(f.cache.get(circle, "dark", 1)); f.cache.endFrame();
  assert.equal(f.cache.diagnostics().encodedTransitionBytes, 0);
  f.cache.dispose();
});

test("an individual encoded map above its hard steady limit fails explicitly instead of pending forever", async () => {
  const f = fixture({ maxEncodedBytes: 1 });
  f.cache.get(circle, "light", 1);
  await until(() => f.failures.length === 1);
  assert.match(f.failures[0].message, /Encoded glass material exceeds/);
  assert.equal(f.cache.diagnostics().queued, 0);
  f.cache.get(circle, "light", 1); await delay(5);
  assert.equal(f.failures.length, 1);
  f.cache.dispose();
});


test("resting endpoints follow the current display DPR even when their old plan still carries 1x", () => {
  const endpoint = { ...circle, dpr: 1, resting: true };
  const oldDisplay = glassMaterialGeometry(endpoint, "light", 1);
  const newDisplay = glassMaterialGeometry(endpoint, "light", 2);
  assert.equal(oldDisplay.width, 48);
  assert.equal(newDisplay.width, 96);
  assert.notEqual(oldDisplay.key, newDisplay.key);
  assert.equal(glassMaterialGeometry({ ...endpoint, resting: false }, "light", 2).width, 48);
  assert.equal(glassMaterialGeometry({ ...circle, dpr: 2, resting: true }, "light", 1).width, 48);
});

test("a blocked decode occupies no GPU or encode slot", async () => {
  const held: (() => void)[] = [];
  const f = fixture({ maxGpuPending: 1, maxDecodePending: 1,
    decodeImage: url => new Promise(resolve => held.push(() => resolve({ src: url } as HTMLImageElement))) });
  f.cache.get(circle, "light", 1);
  await until(() => f.cache.diagnostics().decodeActive === 1 && held.length === 2);
  f.cache.get({ ...circle, width: 60 }, "light", 1);
  await until(() => f.cache.diagnostics().decodeQueued === 1);
  assert.equal(f.renders.length, 2);
  assert.equal(f.cache.diagnostics().gpuActive, 0);
  assert.equal(f.cache.diagnostics().encodeActive, 0);
  assert.equal(f.cache.diagnostics().decodeActive, 1);
  held.splice(0).forEach(resolve => resolve());
  await until(() => held.length === 2);
  held.splice(0).forEach(resolve => resolve());
  await until(() => f.cache.diagnostics().readyEntries === 2);
  f.cache.dispose();
});

test("urgent GPU requests overtake next-segment requests, which overtake warming", async () => {
  const f = fixture({ maxGpuPending: 1 }, true);
  f.cache.prewarm([circle], "light", 1);
  f.cache.prewarm([{ ...circle, width: 50 }], "light", 1, "next");
  f.cache.get({ ...circle, width: 60 }, "light", 1, "urgent");
  await until(() => f.renders.length === 1);
  assert.equal(f.renders[0].width, 60);
  f.pending.shift()!();
  await until(() => f.renders.length === 2);
  assert.equal(f.renders[1].width, 50);
  f.pending.shift()!();
  await until(() => f.renders.length === 3);
  assert.equal(f.renders[2].width, 44);
  f.pending.shift()!();
  await until(() => f.cache.diagnostics().readyEntries === 3);
  f.cache.dispose();
});

test("urgent work overtakes queued encodes while retained pixel buffers remain bounded", async () => {
  const held: (() => void)[] = [], encoded: number[] = [];
  const encoder: MaterialEncoder = {
    encode(_pixels, width, height) { encoded.push(width); return new Promise(resolve => held.push(() => resolve([[`field:${width}:${height}`], [`rim:${width}:${height}`]]))); },
    mode: () => "worker", dispose() {},
  };
  const f = fixture({ encoder, maxGpuPending: 4, maxPixelBytes: 4 * 70 * 52 * 8 });
  f.cache.prewarm([circle, { ...circle, width: 46 }, { ...circle, width: 48 }], "light", 1);
  await until(() => encoded.length === 1 && f.cache.diagnostics().encodeQueued === 2);
  f.cache.get({ ...circle, width: 60 }, "light", 1);
  await until(() => f.cache.diagnostics().encodeQueued === 3);
  assert.ok(f.cache.diagnostics().pixelBytes <= f.cache.diagnostics().maxPixelBytes);
  held.shift()!();
  await until(() => encoded.length === 2);
  assert.equal(encoded[1], 64);
  for (let i = 0; i < 3; i++) {
    await until(() => held.length > 0); held.shift()!();
  }
  await until(() => f.cache.diagnostics().readyEntries === 4);
  assert.equal(f.cache.diagnostics().pixelBytes, 0);
  f.cache.dispose();
});

test("raw pixel admission stops GPU generation at its own byte bound", async () => {
  const held: (() => void)[] = [];
  const encoder: MaterialEncoder = {
    encode(_pixels, width, height) { return new Promise(resolve => held.push(() => resolve([[`field:${width}:${height}`], [`rim:${width}:${height}`]]))); },
    mode: () => "worker", dispose() {},
  };
  const bound = 2 * 48 * 48 * 8;
  const f = fixture({ encoder, maxPixelBytes: bound });
  for (const radius of [2, 4, 6, 8, 10]) f.cache.get({ ...circle, radius }, "light", 1);
  await until(() => held.length === 1 && f.cache.diagnostics().encodeQueued === 1);
  assert.equal(f.renders.length, 2);
  assert.equal(f.cache.diagnostics().pixelBytes, bound);
  assert.equal(f.cache.diagnostics().queued, 3);
  f.cache.dispose(); held.splice(0).forEach(resolve => resolve());
  await delay(5);
  assert.equal(f.cache.diagnostics().pixelBytes, 0);
  assert.equal(f.stats().ready, 0);
});

test("a genuinely cold empty cache starts the shipped worker only after its first GPU result", async () => {
  const { Worker: Thread } = await import("node:worker_threads");
  const { readFile } = await import("node:fs/promises");
  const { createMaterialEncoder } = await import("../vendor/glass-hq/src/dom/map-encoder");
  const source = await readFile(new URL("../vendor/glass-hq/src/dom/map-encoder.worker.js", import.meta.url), "utf8");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  let constructed = 0;
  const threads: InstanceType<typeof Thread>[] = [];
  class ColdWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { preventDefault(): void }) => void;
    onmessageerror?: () => void;
    thread: InstanceType<typeof Thread>;
    constructor() {
      constructed++;
      this.thread = new Thread(`const { parentPort } = require('node:worker_threads');
        globalThis.postMessage = message => parentPort.postMessage(message);
        parentPort.on('message', data => globalThis.onmessage({data}));\n${source}`, { eval: true });
      threads.push(this.thread);
      this.thread.on("message", data => this.onmessage?.({ data }));
      this.thread.on("error", () => this.onerror?.({ preventDefault() {} }));
    }
    postMessage(data: unknown) { this.thread.postMessage(data); }
    terminate() { void this.thread.terminate(); }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: ColdWorker });
  const events: { name: string; requestId: unknown; absoluteAt: unknown }[] = [];
  const encoder = createMaterialEncoder({ trace: (name, detail) => events.push({ name, requestId: detail?.requestId, absoluteAt: detail?.absoluteTime }) });
  const f = fixture({ encoder }, true);
  try {
    assert.equal(f.cache.diagnostics().entries, 0);
    assert.equal(f.cache.diagnostics().encodingMode, "idle");
    assert.equal(constructed, 0);
    f.cache.get(circle, "light", 1);
    await until(() => f.pending.length === 1);
    assert.equal(constructed, 0, "GPU demand alone must not eagerly spawn the encoder");
    f.pending.shift()!();
    await until(() => f.cache.diagnostics().readyEntries === 1);
    assert.equal(constructed, 1);
    assert.equal(f.cache.diagnostics().generated, 1);
    assert.ok(f.cache.get(circle, "light", 1)?.field.startsWith("data:image/png;base64,"));
    const names = events.map(event => event.name);
    for (const phase of ["encode-queued", "encode-worker-spawn", "encode-worker-ready", "encode-worker-queued", "encode-worker-start", "encode-worker-end"]) assert.ok(names.includes(phase), phase);
    assert.equal(new Set(events.map(event => event.requestId)).size, 1);
    assert.ok(events.every(event => typeof event.absoluteAt === "number" && event.absoluteAt > 1_000_000_000_000));
  } finally {
    f.cache.dispose();
    await Promise.all(threads.map(thread => thread.terminate()));
    if (descriptor) Object.defineProperty(globalThis, "Worker", descriptor); else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("urgent decode overtakes warm images waiting behind a bounded active decode", async () => {
  const held: (() => void)[] = [], started: string[] = [];
  const f = fixture({ maxDecodePending: 1,
    decodeImage: url => { started.push(url); return new Promise(resolve => held.push(() => resolve({ src: url } as HTMLImageElement))); } });
  f.cache.prewarm([circle], "light", 1);
  await until(() => started.length === 2);
  f.cache.prewarm([{ ...circle, width: 46 }, { ...circle, width: 48 }], "light", 1);
  await until(() => f.cache.diagnostics().decodeQueued === 2);
  f.cache.get({ ...circle, width: 60 }, "light", 1);
  await until(() => f.cache.diagnostics().decodeQueued === 3);
  held.splice(0).forEach(resolve => resolve());
  await until(() => started.length === 4);
  assert.equal(started[2], "field:64:48");
  f.cache.dispose(); held.splice(0).forEach(resolve => resolve());
});

test("frame-local priority lets new demand overtake an obsolete urgent request", async () => {
  const f = fixture({ maxGpuPending: 1 }, true);
  f.cache.beginFrame();
  f.cache.get(circle, "light", 1);
  f.cache.get({ ...circle, width: 46 }, "light", 1);
  f.cache.endFrame();
  await until(() => f.renders.length === 1);
  f.cache.beginFrame();
  f.cache.get({ ...circle, width: 60 }, "light", 1);
  f.cache.endFrame();
  f.pending.shift()!();
  await until(() => f.renders.length === 2);
  assert.equal(f.renders[1].width, 60);
  f.cache.dispose(); f.pending.splice(0).forEach(resolve => resolve());
});

test("repeated frame reset and promotion complete a pinned transition without rerender budget loops", async () => {
  const f = fixture({ maxDecodedBytes: 48 * 48 * 8, maxTransitionBytes: 48 * 48 * 8,
    maxEncodedBytes: 45, maxEncodedTransitionBytes: 45 });
  f.cache.get(circle, "light", 1);
  await until(() => f.cache.diagnostics().readyEntries === 1);
  const light = f.cache.get(circle, "light", 1);
  f.cache.beginFrame(); f.cache.pin(light); f.cache.endFrame();
  f.cache.prewarm([circle], "dark", 1);
  await delay(40);
  assert.equal(f.renders.length, 1);
  let dark: ReturnType<typeof f.cache.get>;
  const deadline = Date.now() + 1500;
  while (!dark) {
    if (Date.now() > deadline) throw new Error("reset/promote transition stalled");
    f.cache.beginFrame();
    dark = f.cache.get(circle, "dark", 1, "urgent");
    f.cache.pin(dark || light);
    f.cache.endFrame();
    await delay();
  }
  assert.equal(f.renders.length, 2);
  assert.equal(f.cache.diagnostics().generated, 2);
  assert.equal(f.cache.diagnostics().transitionBytes, 0);
  assert.equal(f.cache.diagnostics().encodedTransitionBytes, 0);
  assert.equal(f.cache.diagnostics().queued, 0);
  assert.equal(f.failures.length, 0);
  f.cache.dispose();
});

test("enabled real diagnostics preserve one request ID and absolute phase timestamps on a cold fallback run", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const cacheURL = new URL("../lib/glass-material-cache.ts", import.meta.url).href;
  const diagnosticsURL = new URL("../lib/glass-diagnostics.ts", import.meta.url).href;
  const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const script = `
    import assert from "node:assert/strict";
    globalThis.location = { search: "?glassDiagnostics&glassCold=1" };
    const { createGlassMaterialCache } = await import(${JSON.stringify(cacheURL)});
    const { readGlassTrace, glassColdStart } = await import(${JSON.stringify(diagnosticsURL)});
    assert.equal(glassColdStart(), true);
    const renderer = { warmed: Promise.resolve(), dispose() {}, async render(geometry, options) {
      options.trace("gpu-enqueue", {requestId: options.requestId});
      return {width:48,height:48,pixels:new Uint8Array(48*48*8),duration:0};
    }};
    let failure;
    const cache = createGlassMaterialCache(renderer, {onReady(){},onFailure(error){failure=error;},decodeImage:async()=>({})});
    assert.equal(cache.diagnostics().entries,0);
    assert.equal(cache.diagnostics().encodingMode,"idle");
    cache.get({width:44,height:44,radius:22},"light",1);
    const deadline=Date.now()+1500;
    while(!cache.diagnostics().readyEntries){if(failure)throw failure;if(Date.now()>deadline)throw Error("timeout");await new Promise(r=>setTimeout(r,2));}
    const trace=readGlassTrace();
    const events=trace.events.filter(event=>event.detail.requestId);
    assert.equal(new Set(events.map(event=>event.detail.requestId)).size,1);
    const names=events.map(event=>event.name);
    for(const name of ["material-queue","gpu-queue","gpu-enqueue","encode-queue","encode-queued","encode-fallback-start","encode-fallback-end","decode-queue","decode-start","decode-end","material-ready"])assert.ok(names.includes(name),name);
    for(const event of events)assert.equal(event.absoluteTime,trace.timeOrigin+event.at);
    assert.equal(cache.diagnostics().encodingMode,"fallback");
    cache.dispose();
  `;
  await promisify(execFile)(process.execPath, ["--import", loader, "--input-type=module", "--eval", script]);
});
