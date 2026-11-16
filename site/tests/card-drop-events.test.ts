import assert from "node:assert/strict";
import { test } from "node:test";
import { attachPullDismiss, type DropFrame } from "../lib/card-pull-dismiss";

class Surface extends EventTarget {
  dataset: Record<string, string> = {};
  style = { setProperty() {}, removeProperty() {} };
  closest(selector: string) { return selector === ".article-shell" ? this : null; }
  getBoundingClientRect() { return { top: 0 }; }
}
function harness(saveResult = true) {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  };
  const viewport = Object.assign(new EventTarget(), { height: 840, offsetTop: 0, scale: 1 });
  const win = Object.assign(new EventTarget(), { visualViewport: viewport });
  const doc = Object.assign(new EventTarget(), { querySelector: () => null });
  const media = (query: string) => Object.assign(new EventTarget(), { matches: !query.includes("reduced-motion") });
  const frames = new Map<number, FrameRequestCallback>();
  let frame = 0, saves = 0, failures = 0, invalidations = 0, returns = 0;
  let painted: DropFrame | null = null;
  install("Element", Surface); install("window", win); install("document", doc);
  install("visualViewport", viewport); install("innerWidth", 420); install("innerHeight", 840);
  install("scrollY", 0); install("matchMedia", media);
  install("screen", { orientation: Object.assign(new EventTarget(), { angle: 0 }) });
  install("getSelection", () => ({ isCollapsed: true }));
  install("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frame, callback); return frame; });
  install("cancelAnimationFrame", (id: number) => frames.delete(id));
  const surface = new Surface();
  const controller = attachPullDismiss(surface as unknown as HTMLElement, {
    eligible: () => true, show() {}, commit() {}, swipe: () => { returns++; }, invalidate: () => { invalidations++; },
    drop: { paint: value => { painted = value; }, save: () => { saves++; return saveResult; }, failure: () => { failures++; } },
  });
  const touch = (x: number, y: number) => ({ identifier: 1, clientX: x, clientY: y });
  return {
    event(type: string, x: number, y: number, count = 1) {
      const event = new Event(type, { cancelable: true });
      Object.assign(event, { touches: type === "touchend" ? [] : Array.from({ length: count }, () => touch(x, y)), changedTouches: [touch(x, y)] });
      surface.dispatchEvent(event);
    },
    flush() { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(performance.now())); },
    resize(width: number, height: number) { Object.defineProperty(globalThis, "innerWidth", { value: width, configurable: true }); viewport.height = height; win.dispatchEvent(new Event("resize")); viewport.dispatchEvent(new Event("resize")); },
    stats: () => ({ saves, failures, invalidations, returns, painted, pulling: surface.dataset.cardPulling }),
    dispose() {
      controller.dispose();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("release coordinates decide saving even when no final move event was delivered", () => {
  const h = harness();
  try {
    h.event("touchstart", 80, 620);
    h.event("touchmove", 270, 620); h.flush();
    assert.equal(h.stats().painted?.selected, false);
    h.event("touchend", 400, 800);
    assert.equal(h.stats().saves, 1);
    h.event("touchend", 400, 800);
    assert.equal(h.stats().saves, 1);
  } finally { h.dispose(); }
});
test("leaving the tray before touchend cancels selection and saving", () => {
  const h = harness();
  try {
    h.event("touchstart", 80, 740);
    h.event("touchmove", 390, 780); h.flush();
    assert.equal(h.stats().painted?.selected, true);
    h.event("touchend", 390, 550);
    assert.equal(h.stats().saves, 0);
  } finally { h.dispose(); }
});
test("a failed save reports failure and never starts a source return", () => {
  const h = harness(false);
  try {
    h.event("touchstart", 80, 740); h.event("touchmove", 390, 780); h.flush();
    h.event("touchend", 390, 780);
    assert.equal(h.stats().saves, 1);
    assert.equal(h.stats().failures, 1);
    assert.equal(h.stats().returns, 0);
  } finally { h.dispose(); }
});
test("Safari height changes preserve the pull; width changes invalidate it", () => {
  const h = harness();
  try {
    h.event("touchstart", 80, 620); h.event("touchmove", 300, 620); h.flush();
    h.resize(420, 770);
    assert.equal(h.stats().pulling, "right");
    assert.equal(h.stats().invalidations, 0);
    h.resize(770, 420);
    assert.equal(h.stats().pulling, undefined);
    assert.equal(h.stats().invalidations, 1);
    h.event("touchend", 400, 800);
    assert.equal(h.stats().saves, 0);
  } finally { h.dispose(); }
});
test("system-edge starts and a second finger never save", () => {
  const h = harness();
  try {
    h.event("touchstart", 10, 740); h.event("touchmove", 390, 780); h.event("touchend", 390, 780);
    assert.equal(h.stats().saves, 0);
    h.event("touchstart", 80, 740); h.event("touchmove", 390, 780, 2); h.event("touchend", 390, 780);
    assert.equal(h.stats().saves, 0);
  } finally { h.dispose(); }
});


test("touchend inside full tray radius but outside the half-expanded visible tray does not save", () => {
  const h = harness();
  try {
    h.event("touchstart", 150.5, 800);
    h.event("touchmove", 300, 800); h.flush();
    // Final distance = 320 - 150.5 - 12 = 157.5; visible radius = 79.8.
    // This endpoint is inside R=159.6 but 107.7px from the tray corner.
    h.event("touchend", 320, 800);
    assert.equal(h.stats().saves, 0);
  } finally { h.dispose(); }
});
