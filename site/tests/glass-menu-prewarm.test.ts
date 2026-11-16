import assert from "node:assert/strict";
import { test } from "node:test";
import { predictGlassMenuShapes, installGlassMenuPrewarm, READER_GLASS_PREWARM, READER_GLASS_MOTION_REST, isGlassMenuSourceAtRest, canFinishGlassMenuWithoutMotion } from "../lib/glass-menu-prewarm";
import { openingAxis, planMorph, type Box } from "../vendor/glass-hq/src/core/morph-path";

class FixtureElement {
  id = "";
  isConnected = true;
  hidden = false;
  pressed = false;
  custom: Record<string, string> = { "--reader-chrome-q": "1", "--reader-chrome-scale": "1", "--reader-chrome-x": "0px" };
  translate = "none";
  closest() { return this.hidden ? this : null; }
  matches() { return this.pressed; }
  constructor(readonly box: Box, readonly layout = { width: box.width, height: box.height }) {}
  get offsetWidth() { return Math.round(this.layout.width); }
  get offsetHeight() { return Math.round(this.layout.height); }
  getBoundingClientRect() { return { ...this.box, right: this.box.left + this.box.width, bottom: this.box.top + this.box.height }; }
}
const element = (node: FixtureElement) => node as unknown as HTMLElement;
async function withDOM(run: (fixture: {
  events: Event[]; flush: () => Promise<void>; install: typeof installGlassMenuPrewarm; resize: () => void; reflow: () => void; rest: () => void;
  listeners: Map<string, () => void>; observers: { disconnected: boolean }[];
}) => void | Promise<void>) {
  const events: Event[] = [], frames = new Map<number, FrameRequestCallback>(), listeners = new Map<string, () => void>();
  const fontListeners = new Map<string, () => void>(), documentListeners = new Map<string, () => void>();
  const observers: { callback: () => void; disconnected: boolean }[] = [];
  const inFlight: Promise<unknown>[] = [];
  let serial = 0;
  const replacements = {
    devicePixelRatio: 2,
    window: {
      innerWidth: 1200, innerHeight: 1000,
      getComputedStyle: (node: FixtureElement) => ({ width: `${node.layout.width}px`, height: `${node.layout.height}px`, boxSizing: "border-box",
        display: "block", visibility: "visible", opacity: "1", translate: node.translate,
        getPropertyValue: (name: string) => node.custom[name] || "" }),
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    },
    document: {
      dispatchEvent: (event: Event) => { if (event.type === READER_GLASS_PREWARM) events.push(event); documentListeners.get(event.type)?.(); return true; },
      addEventListener: (type: string, listener: () => void) => documentListeners.set(type, listener),
      removeEventListener: (type: string) => documentListeners.delete(type),
      fonts: { addEventListener: (type: string, listener: () => void) => fontListeners.set(type, listener), removeEventListener: (type: string) => fontListeners.delete(type) },
    },
    ResizeObserver: class {
      state: { callback: () => void; disconnected: boolean };
      constructor(callback: () => void) { this.state = { callback, disconnected: false }; observers.push(this.state); }
      observe() {}
      disconnect() { this.state.disconnected = true; }
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++serial, callback); return serial; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  };
  const descriptors = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, value });
    await run({ events, listeners, observers,
      install(source, panel, options = {}) {
        return installGlassMenuPrewarm(source, panel, { ...options, predict: options.predict ?? ((...args) => {
          const task = predictGlassMenuShapes(...args); inFlight.push(task); return task;
        }) });
      },
      async flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); await Promise.allSettled(inFlight.splice(0)); await Promise.resolve(); },
      resize() { listeners.get("resize")?.(); },
      rest() { documentListeners.get(READER_GLASS_MOTION_REST)?.(); },
      reflow() { observers.filter(observer => !observer.disconnected).forEach(observer => observer.callback()); },
    });
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}
function pair() {
  return {
    source: new FixtureElement({ left: 449, top: 6, width: 44, height: 44 }),
    panel: new FixtureElement({ left: 188.25, top: 58, width: 304.75, height: 213.375 }),
  };
}

test("hidden layout prediction matches the native detach/neck plan and exact fractional endpoint", () => withDOM(async () => {
  const { source, panel } = pair();
  const actual = await predictGlassMenuShapes(element(source), element(panel), { webkit: true, dpr: 3 });
  const expected = planMorph({ from: source.box, fromRadius: "circle", to: panel.box, toRadius: 24,
    along: openingAxis(source.box, panel.box) },
    { ...source.box, radius: "circle", layoutWidth: 44, layoutHeight: 44 },
    { dpr: 1, restDpr: 2, neck: 36, stops: 7 }).map(stop => stop.shape);
  assert.deepEqual(actual, expected);
  assert.equal(actual.at(-1)?.width, 304.75);
  assert.equal(actual.at(-1)?.height, 213.375);
  assert.ok(actual.some(shape => shape.outline), "prewarm includes the actual Gooey union maps");
  assert.ok(actual.filter(shape => !shape.resting).every(shape => shape.dpr === 1));
  assert.equal(actual.at(-1)?.dpr, 2);
}));

test("other engines use fourteen stops and zero-sized prediction never publishes bogus geometry", () => withDOM(async () => {
  const { source, panel } = pair();
  const webkit = await predictGlassMenuShapes(element(source), element(panel), { webkit: true, dpr: 1 });
  const other = await predictGlassMenuShapes(element(source), element(panel), { webkit: false, dpr: 1 });
  assert.ok(other.length >= webkit.length);
  panel.layout.height = 0;
  assert.deepEqual(await predictGlassMenuShapes(element(source), element(panel)), []);
}));

test("prediction emits once per actual layout change, never subscribes to scroll, and cleans up", () => withDOM(async ({ events, flush, resize, reflow, listeners, observers, install }) => {
  const { source, panel } = pair();
  const cleanup = install(element(source), element(panel));
  assert.equal(events.length, 0);
  await flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, READER_GLASS_PREWARM);
  assert.ok((events[0] as CustomEvent).detail.shapes.length > 0);
  assert.equal(listeners.has("scroll"), false);
  resize(); reflow(); await flush();
  assert.equal(events.length, 1, "duplicate observer/resize callbacks reuse the same prediction");
  source.box.left += 100; source.box.top += 50; panel.box.left += 100; panel.box.top += 50;
  resize(); await flush();
  assert.equal(events.length, 1, "common viewport movement does not generate new local maps");
  panel.box.height = panel.layout.height = 248.5;
  reflow(); await flush();
  assert.equal(events.length, 2);
  assert.equal((events[1] as CustomEvent).detail.shapes.at(-1).height, 248.5);
  cleanup(); resize(); reflow(); await flush();
  assert.equal(events.length, 2);
  assert.ok(observers.every(observer => observer.disconnected));
  assert.equal(listeners.size, 0);
}));


test("transformed source waits for a motion-rest event without needing a resize", () => withDOM(async ({ events, flush, rest, install }) => {
  const { source, panel } = pair();
  source.box.width = source.box.height = 52.8;
  source.custom["--reader-chrome-scale"] = "1.2";
  const cleanup = install(element(source), element(panel));
  await flush();
  assert.equal(events.length, 0);
  assert.deepEqual(await predictGlassMenuShapes(element(source), element(panel)), []);
  source.box.width = source.box.height = 44;
  source.custom["--reader-chrome-scale"] = "1";
  rest(); await flush();
  assert.equal(events.length, 1);
  assert.deepEqual((events[0] as CustomEvent).detail.shapes, await predictGlassMenuShapes(element(source), element(panel)));
  rest(); await flush();
  assert.equal(events.length, 1, "another rest signal does not retrace the same plan");
  cleanup(); rest(); await flush();
  assert.equal(events.length, 1);
}));

test("hidden, scroll-partial, pressed and translated sources are not eligible for rest prediction", () => withDOM(async () => {
  const { source } = pair();
  assert.equal(isGlassMenuSourceAtRest(element(source)), true);
  source.custom["--reader-chrome-q"] = ".9";
  assert.equal(isGlassMenuSourceAtRest(element(source)), false);
  source.custom["--reader-chrome-q"] = "1"; source.pressed = true;
  assert.equal(isGlassMenuSourceAtRest(element(source)), false);
  source.pressed = false; source.translate = "2px 0px";
  assert.equal(isGlassMenuSourceAtRest(element(source)), false);
  source.translate = "none"; source.hidden = true;
  assert.equal(isGlassMenuSourceAtRest(element(source)), false);
  source.hidden = false; source.box.width = 46;
  assert.equal(isGlassMenuSourceAtRest(element(source)), false);
}));


test("motion's px-valued horizontal offset admits 0px and rejects displacement or invalid units", () => withDOM(async ({ events, flush, rest, install }) => {
  const { source, panel } = pair();
  source.custom["--reader-chrome-x"] = "12px";
  assert.equal(isGlassMenuSourceAtRest(element(source)), false);
  const cleanup = install(element(source), element(panel));
  await flush();
  assert.equal(events.length, 0);
  source.custom["--reader-chrome-x"] = "0px";
  assert.equal(isGlassMenuSourceAtRest(element(source)), true);
  rest(); await flush();
  assert.equal(events.length, 1, "actual motion output can publish the warm path");
  for (const value of ["-12px", "0%", "0garbage", "NaNpx"]) {
    source.custom["--reader-chrome-x"] = value;
    assert.equal(isGlassMenuSourceAtRest(element(source)), false, value);
  }
  cleanup();
}));


test("q=1 cannot announce a settled source while route breathing still changes its geometry", () => withDOM(async () => {
  const { source } = pair();
  let motionRest = false, emitted = 0;
  const measure = (keepMoving: boolean) => {
    const atRest = !keepMoving && isGlassMenuSourceAtRest(element(source));
    if (atRest && !motionRest) emitted++;
    motionRest = atRest;
  };
  source.custom["--reader-chrome-q"] = "1";
  source.custom["--reader-chrome-scale"] = "1.2";
  source.box.width = source.box.height = 52.8;
  measure(false); // The route advance can move while the optical-local flag is false.
  assert.equal(emitted, 0);
  source.custom["--reader-chrome-scale"] = "1";
  source.box.width = source.box.height = 44;
  measure(true);
  assert.equal(emitted, 0, "other optical motion still prevents a rest notification");
  measure(false); measure(false);
  assert.equal(emitted, 1, "actual stable geometry emits exactly one new rest edge");
}));

test("obsolete predictions are aborted and late results cannot publish after reflow or disposal", () => withDOM(async ({ events, flush, reflow, install }) => {
  const { source, panel } = pair();
  const jobs: { signal?: AbortSignal; resolve: (shapes: readonly import("../vendor/glass-hq/src/core/morph-path").MorphGeometry[]) => void }[] = [];
  const cleanup = install(element(source), element(panel), { predict: (_source, _panel, options) => new Promise(resolve => jobs.push({ signal: options?.signal, resolve })) });
  await flush(); assert.equal(jobs.length, 1);
  panel.box.height = panel.layout.height = 248.5;
  reflow();
  assert.equal(jobs[0].signal?.aborted, true, "resize invalidates before the next frame");
  jobs[0].resolve([{ width: 1, height: 1, radius: 0 }]);
  await flush(); assert.equal(events.length, 0); assert.equal(jobs.length, 2);
  jobs[1].resolve([{ width: 304.75, height: 248.5, radius: 24 }]);
  await Promise.resolve();
  assert.equal(events.length, 1);
  panel.box.height = panel.layout.height = 251;
  reflow(); await flush(); assert.equal(jobs.length, 3);
  cleanup(); assert.equal(jobs[2].signal?.aborted, true);
  jobs[2].resolve([{ width: 304.75, height: 251, radius: 24 }]);
  await Promise.resolve(); assert.equal(events.length, 1);
}));

test("cold mode installs no prediction work or observers", () => withDOM(async ({ events, flush, observers, listeners, install }) => {
  const { source, panel } = pair(); let called = false;
  const cleanup = install(element(source), element(panel), { cold: () => true, predict: async () => { called = true; return []; } });
  await flush();
  assert.equal(called, false); assert.equal(events.length, 0); assert.equal(observers.length, 0); assert.equal(listeners.size, 0);
  cleanup();
}));

test("motion timeout cannot expose content or finish a return while geometry/material is pending", () => {
  const attributes = new Set<string>();
  const panel = { hasAttribute: (name: string) => attributes.has(name) };
  assert.equal(canFinishGlassMenuWithoutMotion(panel), true, "no-animation fallback can finish");
  for (const name of ["data-glass-morph", "data-glass-pending", "data-starting-style"]) {
    attributes.add(name); assert.equal(canFinishGlassMenuWithoutMotion(panel), false, name); attributes.delete(name);
  }
  attributes.add("data-ending-style");
  assert.equal(canFinishGlassMenuWithoutMotion(panel), true, "non-animated fallback can close");
  attributes.add("data-glass-morph");
  assert.equal(canFinishGlassMenuWithoutMotion(panel), false, "active return keeps its completion event");
});


test("More become prediction matches native neck-zero plan, with source-specific event identity", () => withDOM(async ({ events, install, flush }) => {
  const { source, panel } = pair(); source.id = "header-menu-trigger";
  panel.box.height = panel.layout.height = 700;
  for (const engine of [true, false]) {
    const actual = await predictGlassMenuShapes(element(source), element(panel), { morph: "become", webkit: engine, dpr: 2 });
    const expected = planMorph({ from: source.box, fromRadius: "circle", to: panel.box, toRadius: 24,
      along: openingAxis(source.box, panel.box) }, undefined, { dpr: 1, restDpr: 2, neck: 0, stops: engine ? 5 : 10 }).map(stop => stop.shape);
    assert.deepEqual(actual, expected);
    assert.equal(actual.length, engine ? 5 : 10);
    assert.ok(actual.every(shape => !shape.outline), "become has no detached union contour to trace");
    assert.equal(actual[0].dpr, 2); assert.equal(actual.at(-1)?.dpr, 2);
  }
  const cleanup = install(element(source), element(panel), { morph: "become" });
  await flush();
  assert.equal(events.length, 1);
  assert.equal((events[0] as CustomEvent).detail.sourceId, "header-menu-trigger");
  assert.ok((events[0] as CustomEvent).detail.shapes.every((shape: { outline?: unknown }) => !shape.outline));
  cleanup();
}));
