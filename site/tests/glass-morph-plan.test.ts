import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { planMorph, type MorphEndpoints, type MorphGlass } from "../vendor/glass-hq/src/core/morph-path";
import { traceMorphAsync } from "../vendor/glass-hq/src/core/morph-plan-async";
import { createMorphPlanService, morphLayoutBox, requestMorphPlan, disposeMorphPlans } from "../vendor/glass-hq/src/dom/morph-plan";
const endpoints: MorphEndpoints = { from: { left: 0, top: 0, width: 44, height: 44 }, fromRadius: "circle", to: { left: -196, top: 56, width: 284, height: 360 }, toRadius: 24, along: "y" };
const glass: MorphGlass = { ...endpoints.from, radius: "circle", layoutWidth: 44, layoutHeight: 44 };
const options = { neck: 36, stops: 7, dpr: 1, restDpr: 2 };
const normalized = (value: unknown) => JSON.parse(JSON.stringify(value));
class BundledWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  messages = 0;
  timers = 0;
  onPostedTask?: () => void;
  replies: { timing?: Record<string, number | string>; aborted?: boolean }[] = [];
  scope: { onmessage?: (event: { data: unknown }) => void };
  constructor() {
    const owner = this;
    class ObservedChannel extends MessageChannel {
      constructor() {
        super();
        const post = this.port2.postMessage.bind(this.port2);
        this.port2.postMessage = (message: unknown) => { post(message); owner.onPostedTask?.(); };
      }
    }
    this.scope = { MessageChannel: ObservedChannel, setTimeout: (...args: Parameters<typeof setTimeout>) => { this.timers++; return setTimeout(...args); }, performance, DOMException, AbortController, postMessage: (data: unknown) => { this.replies.push(data as typeof this.replies[number]); if (!this.terminated) this.onmessage?.({ data } as MessageEvent); } } as typeof this.scope;
    runInNewContext(readFileSync(new URL("../vendor/glass-hq/src/dom/morph-plan.worker.js", import.meta.url), "utf8"), this.scope);
  }
  postMessage(data: unknown) { this.messages++; this.scope.onmessage?.({ data }); }
  terminate() { this.terminated = true; }
}
test("original f49abcc contour fixture remains byte-identical", () => {
  const bytes = JSON.stringify(planMorph(endpoints, glass, options));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "dc8a7fc5bd8a2cbe7992a5f41ad4f7975fd47969452c02f4b2bf5251acc820eb");
});
test("bundled Worker preserves original synchronous stops and outlines exactly", async () => {
  const worker = new BundledWorker();
  const service = createMorphPlanService({ workerFactory: () => worker });
  try {
    assert.deepEqual(normalized(await service.request(endpoints, glass, options)), normalized(planMorph(endpoints, glass, options)));
    assert.equal(worker.timers, 0, "Worker uses posted tasks rather than clamped nested timers");
    const timing = worker.replies[0].timing!;
    assert.equal(timing.scheduler, "message-channel");
    assert.ok(Number(timing.slices) > 1);
    assert.ok(Number(timing.workerReceivedAt) <= Number(timing.workerStartedAt));
    assert.ok(Number(timing.workerStartedAt) <= Number(timing.workerCompletedAt));
    assert.ok(Number(timing.workerReceivedAt) >= performance.timeOrigin);
    assert.ok(Math.abs(Number(timing.workerCompletedAt) - Number(timing.workerReceivedAt) - Number(timing.durationMs)) < .001);
    assert.ok(Number(timing.computeMs) <= Number(timing.durationMs));
  } finally { service.dispose(); }
});
test("posted-task Worker observes cancellation between slices", async () => {
  const worker = new BundledWorker();
  const reply = new Promise<{ aborted?: boolean; timing: { slices: number } }>(resolve => { worker.onmessage = event => resolve(event.data); });
  let tasks = 0;
  worker.onPostedTask = () => { if (++tasks === 3) worker.postMessage({ id: 77, cancel: true }); };
  worker.postMessage({ id: 77, endpoints, glass, options });
  const result = await reply;
  assert.equal(result.aborted, true);
  assert.ok(result.timing.slices > 0, "cancels an already-started trace");
  assert.equal(worker.timers, 0);
  worker.terminate();
});
test("fallback yields repeatedly, defers first trace, and preserves contours", async () => {
  let yields = 0, slices = 0;
  const task = traceMorphAsync(endpoints, glass, options, { budgetMs: 0, yieldTask: async () => { yields++; }, onSlice: () => slices++ });
  assert.equal(slices, 0);
  const result = await task;
  assert.ok(yields > 20);
  assert.deepEqual(normalized(result), normalized(planMorph(endpoints, glass, options)));
});
test("fallback responds to cancellation between bounded work slices", async () => {
  const controller = new AbortController(); let yields = 0;
  await assert.rejects(traceMorphAsync(endpoints, glass, options, { budgetMs: 0, signal: controller.signal, yieldTask: async () => { if (++yields === 3) controller.abort(); } }), { name: "AbortError" });
  assert.equal(yields, 3);
});
test("Worker startup and runtime failure use cooperative fallback", async () => {
  for (const runtime of [false, true]) {
    let yields = 0;
    const service = createMorphPlanService({ workerFactory: () => {
      if (!runtime) throw new Error("blocked");
      const worker = { onmessage: null, onerror: null as ((e: ErrorEvent) => void) | null, terminate() {}, postMessage() { queueMicrotask(() => worker.onerror?.({} as ErrorEvent)); } };
      return worker;
    }, yieldTask: async () => { yields++; } });
    try { assert.deepEqual(normalized(await service.request(endpoints, glass, options)), normalized(planMorph(endpoints, glass, options))); assert.ok(yields > 1); }
    finally { service.dispose(); }
  }
});
test("cancelling one coalesced subscriber preserves the other; global cancel rejects pending", async () => {
  const worker = new BundledWorker(); const service = createMorphPlanService({ workerFactory: () => worker });
  const controller = new AbortController();
  const one = service.request(endpoints, glass, options, { signal: controller.signal });
  const two = service.request(endpoints, glass, options);
  controller.abort();
  await assert.rejects(one, { name: "AbortError" });
  assert.deepEqual(normalized(await two), normalized(planMorph(endpoints, glass, options)));
  const pending = service.request({ ...endpoints, to: { ...endpoints.to, height: 361 } }, glass, options);
  service.cancel(); await assert.rejects(pending, { name: "AbortError" }); service.dispose();
});
test("press layout normalization and common translation reuse the same plan", async () => {
  const worker = new BundledWorker(); const service = createMorphPlanService({ workerFactory: () => worker });
  try {
    await service.request(endpoints, glass, options);
    const source = morphLayoutBox({ left: 102.2, top: 52.2, width: 39.6, height: 39.6 }, { width: 44, height: 44 });
    assert.deepEqual(source, { left: 100, top: 50, width: 44, height: 44 });
    const shifted = await service.request({ ...endpoints, from: source, to: { ...endpoints.to, left: endpoints.to.left + 100, top: endpoints.to.top + 50 } }, { ...glass, ...source }, options);
    assert.equal(worker.messages, 1);
    assert.equal(shifted[0].box?.left, 100);
  } finally { service.dispose(); }
});
test("generated geometry worker matches its complete TS source bundle", () => {
  execFileSync(process.execPath, ["vendor/glass-hq/scripts/bundle-morph-worker.mjs", "--check"], { cwd: new URL("..", import.meta.url) });
});

test("motion starts with two maps, holds a complete frame, reverses and ignores a cancelled late plan", async () => {
  const { attachGeometryMotion } = await import("../vendor/glass-hq/src/dom/morph");
  const observers: (() => void)[] = [];
  type LifecycleListener = { listener: (event: PageTransitionEvent) => void; capture: boolean };
  const lifecycle = new Map<string, Set<LifecycleListener>>();
  const lifecycleEvent = async (name: string) => {
    const listeners = [...(lifecycle.get(name) ?? [])].sort((a, b) => Number(b.capture) - Number(a.capture));
    for (const { listener } of listeners) {
      listener({ persisted: true } as PageTransitionEvent);
      // Native dispatch may run a microtask checkpoint between listeners.
      // Drain the rejection -> consumer promise -> animator catch chain.
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
  };
  class ElementFixture {
    isConnected = true; dataset: Record<string, string> = {}; attrs = new Set<string>(); values = new Map<string, string>();
    style = { setProperty: (k: string, v: string) => this.values.set(k, v), removeProperty: (k: string) => this.values.delete(k) };
    classList = { contains: (name: string) => name === "lg-surface" }; parentElement = null;
    constructor(public box: { left: number; top: number; width: number; height: number }) {}
    getBoundingClientRect() { return this.box; }
    getAttribute(name: string) { return name === "data-lg-container-radius" ? "circle" : null; }
    hasAttribute(name: string) { return this.attrs.has(name); }
    dispatchEvent() { return true; }
    animate() { return { pause() {}, play() {}, finish() {}, cancel() {} }; }
  }
  const replacements = { HTMLElement: ElementFixture, devicePixelRatio: 2, Worker: BundledWorker,
    window: { getComputedStyle: (node: ElementFixture) => ({ width: `${node.box.width}px`, height: `${node.box.height}px`, boxSizing: "border-box" }),
      addEventListener: (name: string, listener: (event: PageTransitionEvent) => void, capture = false) => { if (!lifecycle.has(name)) lifecycle.set(name, new Set()); lifecycle.get(name)!.add({ listener, capture }); },
      removeEventListener: (name: string, listener: (event: PageTransitionEvent) => void, capture = false) => {
        for (const item of lifecycle.get(name) ?? []) if (item.listener === listener && item.capture === capture) lifecycle.get(name)!.delete(item);
      },
    },
    document: { dispatchEvent() { return true; } },
    MutationObserver: class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} },
  };
  const descriptors = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, value });
  try {
    const source = new ElementFixture(endpoints.from), panel = new ElementFixture(endpoints.to);
    const ready = new Set<unknown>();
    const motion = attachGeometryMotion(panel as unknown as HTMLElement, { from: () => source as unknown as Element, morph: "detach", radius: 24, neck: 36, motion: () => "full", prepared: shape => ready.has(shape) });
    let time = performance.now();
    motion.frame(time += 16);
    assert.equal(motion.positioning(), true, "one placed measurement does not start a plan");
    motion.frame(time += 16);
    assert.equal(motion.positioning(), false, "two equal placed measurements start immediately");
    assert.equal(motion.pending(), true);
    for (let i = 0; i < 1000 && !motion.waypoints().length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const shapes = motion.waypoints(); assert.ok(shapes.length > 2);
    ready.add(shapes[0]); ready.add(shapes[1]);
    motion.frame(time += 16); assert.equal(motion.pending(), false);
    for (let i = 0; i < 20; i++) motion.frame(time += 16);
    const held = motion.geometry(); assert.ok(held?.draw);
    const content = panel.values.get("--lg-morph");
    motion.frame(time += 16); assert.equal(motion.geometry(), held); assert.equal(panel.values.get("--lg-morph"), content);
    panel.attrs.add("data-ending-style"); observers[0]();
    motion.frame(time += 16);
    assert.ok((motion.geometry()?.width ?? 0) <= held.width + 0.1);
    panel.attrs.delete("data-ending-style"); observers[0]();
    shapes.forEach(shape => ready.add(shape));
    for (let i = 0; i < 100; i++) motion.frame(time += 16);
    assert.equal(motion.pending(), false);
    motion.dispose();
    const other = new ElementFixture({ ...endpoints.to, height: 379 });
    const cancelled = attachGeometryMotion(other as unknown as HTMLElement, { from: () => source as unknown as Element, morph: "detach", radius: 24, neck: 36, motion: () => "full", prepared: () => true });
    for (let i = 0; i < 4; i++) cancelled.frame(time += 16);
    other.attrs.add("data-ending-style"); observers[1]();
    for (let i = 0; i < 20; i++) { cancelled.frame(time += 16); await new Promise(resolve => setTimeout(resolve, 1)); }
    assert.equal(cancelled.waypoints().length, 0); assert.equal(cancelled.geometry(), undefined);
    cancelled.dispose();
    // A completed plan whose first maps are still absent has no visible
    // outline to retract; cancellation must not wait for those maps.
    const unmapped = new ElementFixture(endpoints.to);
    const waiting = attachGeometryMotion(unmapped as unknown as HTMLElement, { from: () => source as unknown as Element, morph: "detach", radius: 24, neck: 36, motion: () => "full", prepared: () => false });
    for (let i = 0; i < 4; i++) waiting.frame(time += 16);
    await Promise.resolve(); await Promise.resolve();
    assert.ok(waiting.waypoints().length > 0);
    waiting.frame(time += 16);
    assert.equal(waiting.pending(), true, "resolved geometry still waits for its first map pair");
    assert.equal(waiting.geometry(), undefined);
    assert.equal(waiting.opacity(), 0, "no full-sized resting map may flash before the first complete frame");
    unmapped.attrs.add("data-ending-style"); observers[2]();
    waiting.frame(time += 16);
    assert.equal(waiting.pending(), false); assert.equal(waiting.opacity(), 0);
    waiting.dispose();
    const frozenPanel = new ElementFixture({ ...endpoints.to, height: 381 });
    const frozen = attachGeometryMotion(frozenPanel as unknown as HTMLElement, { from: () => source as unknown as Element, morph: "detach", radius: 24, neck: 36, motion: () => "full", prepared: () => true });
    for (let i = 0; i < 4; i++) frozen.frame(time += 16);
    assert.equal(frozen.pending(), true);
    const registered = [...lifecycle.get("pagehide")!];
    assert.equal(registered[0].capture, false, "shared prewarm service registered its disposer first");
    assert.equal(registered[1].capture, true, "later animator suspends in capture before service disposal");
    await lifecycleEvent("pagehide");
    await Promise.resolve(); await Promise.resolve();
    assert.equal(frozen.opacity(), 0);
    await lifecycleEvent("pageshow");
    for (let i = 0; i < 1000 && !frozen.waypoints().length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(frozen.waypoints().length > 0, "persisted pageshow replans the interrupted existing menu");
    frozen.frame(time += 16);
    assert.equal(frozen.pending(), false, "restored React opening phase no longer waits forever");
    for (let i = 0; i < 100; i++) frozen.frame(time += 16);
    assert.equal(frozen.opacity(), 1);
    assert.equal(lifecycle.has("visibilitychange"), false, "ordinary tab visibility does not dispose the service");
    frozen.dispose();
    const relocatingPanel = new ElementFixture({ ...endpoints.to });
    relocatingPanel.attrs.add("data-starting-style");
    const relocating = attachGeometryMotion(relocatingPanel as unknown as HTMLElement, { from: () => source as unknown as Element, morph: "detach", radius: 24, neck: 36, motion: () => "full", prepared: () => true });
    for (let i = 0; i < 12; i++) relocating.frame(time += 16);
    assert.equal(relocating.positioning(), true, "starting-style blocks even beyond the fallback frame count");
    relocatingPanel.attrs.delete("data-starting-style");
    relocating.frame(time += 16);
    assert.equal(relocating.positioning(), true, "first placed sample after starting-style counts as one");
    relocatingPanel.box.top += 2;
    relocating.frame(time += 16);
    assert.equal(relocating.positioning(), true, "changed layout resets the count to one");
    relocating.frame(time += 16);
    assert.equal(relocating.positioning(), false, "the matching sample after change starts the plan");
    relocating.dispose();
    const movingPanel = new ElementFixture({ ...endpoints.to });
    const moving = attachGeometryMotion(movingPanel as unknown as HTMLElement, { from: () => source as unknown as Element, morph: "detach", radius: 24, neck: 36, motion: () => "full", prepared: () => true });
    for (let i = 0; i < 8; i++) { movingPanel.box.top += 2; moving.frame(time += 16); }
    assert.equal(moving.positioning(), true);
    movingPanel.box.top += 2; moving.frame(time += 16);
    assert.equal(moving.positioning(), false, "existing greater-than-eight-frame fallback remains bounded");
    moving.dispose();
    assert.equal(lifecycle.get("pageshow")?.size, 0);
    assert.equal([...lifecycle.get("pagehide")!].filter(item => item.capture).length, 0, "dispose removes the capture listener with matching options");
    disposeMorphPlans();
  } finally {
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});


test("1/64 relative placement grid reuses recorded press pairs and retains real layout moves", async () => {
  const events: { name: string; detail: Record<string, unknown> }[] = [];
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    terminate() {},
    postMessage(data: unknown) { const { id, cancel } = data as { id: number; cancel?: boolean }; if (!cancel) queueMicrotask(() => worker.onmessage?.({ data: { id, stops: [] } } as MessageEvent)); },
  };
  const service = createMorphPlanService({ workerFactory: () => worker, onTrace: (name, detail) => events.push({ name, detail }) });
  try {
    await service.request(endpoints, glass, options);
    await service.request(endpoints, glass, options);
    const request = events.find(event => event.name === "plan-request")!.detail;
    const hit = events.find(event => event.name === "plan-cache-hit")!.detail;
    assert.equal(request.key, JSON.stringify([endpoints, glass, options]));
    assert.equal(hit.key, request.key);
    assert.deepEqual(hit.endpoints, endpoints); assert.deepEqual(hit.glass, glass); assert.deepEqual(hit.options, options);
    await service.request({ ...endpoints, to: { ...endpoints.to, left: endpoints.to.left + 1 / 64 } }, glass, options);
    const requests = events.filter(event => event.name === "plan-request");
    assert.equal(requests.length, 2);
    assert.notEqual(requests[1].detail.key, request.key, "a full layout grid step retains its own plan");
    for (const [first, again] of [[52.00015625, 52.00015816], [51.99234184, 52.00015625]]) {
      const before = events.filter(event => event.name === "plan-request").length;
      await service.request({ ...endpoints, to: { ...endpoints.to, top: first } }, glass, options);
      const afterFirst = events.filter(event => event.name === "plan-request").length;
      await service.request({ ...endpoints, to: { ...endpoints.to, top: again } }, glass, options);
      assert.equal(events.filter(event => event.name === "plan-request").length, afterFirst);
      assert.ok(afterFirst <= before + 1);
      const reused = events.filter(event => event.name === "plan-cache-hit").at(-1)!.detail;
      assert.equal((reused.endpoints as MorphEndpoints).to.top, 52);
      assert.equal((reused.rawEndpoints as MorphEndpoints).to.top, again);
      assert.equal((reused.endpoints as MorphEndpoints).to.width, endpoints.to.width);
    }
  } finally { service.dispose(); }
});

test("pagehide disposes shared Worker/cache and restored pages lazily recreate; owner cleanup cancels pending", async () => {
  disposeMorphPlans();
  const descriptors = new Map(["window", "Worker"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const listeners = new Map<string, () => void>();
  const workers: LifetimeWorker[] = [];
  let complete = true;
  class LifetimeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(data: unknown) {
      const { id, cancel } = data as { id: number; cancel?: boolean };
      if (complete && !cancel) queueMicrotask(() => this.onmessage?.({ data: { id, stops: [] } } as MessageEvent));
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  } });
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: LifetimeWorker });
  try {
    await requestMorphPlan(endpoints, glass, options);
    await requestMorphPlan(endpoints, glass, options);
    assert.equal(workers.length, 1); assert.ok(listeners.has("pagehide"));
    listeners.get("pagehide")!();
    assert.equal(workers[0].terminated, true); assert.equal(listeners.size, 0);
    // No eager pageshow Worker: a subsequent owner/request starts one lazily.
    complete = false;
    const pending = requestMorphPlan(endpoints, glass, options);
    assert.equal(workers.length, 2, "pagehide also dropped the old completed cache");
    disposeMorphPlans();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(workers[1].terminated, true); assert.equal(listeners.size, 0);
    complete = true;
    await requestMorphPlan(endpoints, glass, options);
    assert.equal(workers.length, 3);
  } finally {
    disposeMorphPlans();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
