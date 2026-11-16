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
