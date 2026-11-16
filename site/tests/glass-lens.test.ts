import assert from "node:assert/strict";
import { test } from "node:test";
import { createGlassLens, lensClipOutline, lensClipPath, lensOpticalRegion, lensHostPlacement, measureLensHostTransform } from "../lib/glass-lens";
import type { LensPlacement } from "../vendor/glass-hq/src/dom/morph";

function inside(points: number[][], x: number, y: number) {
  let winding = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const cross = (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]);
    if (a[1] <= y && b[1] > y && cross > 0) winding++;
    if (a[1] > y && b[1] <= y && cross < 0) winding--;
  }
  return winding !== 0;
}
const circle: LensPlacement = { left: 100, top: 10, width: 44, height: 44, shape: { width: 44, height: 44, radius: "circle" } };
const region = { left: 74, top: -16, width: 96, height: 96 };

test("a 44px optical circle clips the padded sample independently of filter alpha", () => {
  const outline = lensClipOutline(circle, circle, 0, region);
  assert.equal(inside(outline, 48, 48), true);
  for (const point of [[1, 1], [26, 26], [69, 27], [90, 48], [48, 90]]) {
    assert.equal(inside(outline, ...point as [number, number]), false);
  }
  assert.match(lensClipPath(circle, circle, 0, region), /^polygon\(nonzero,/);
});

test("scaled and translated lenses retain the same circular coverage", () => {
  const item = { ...circle, left: 120, top: 20, width: 52.8, height: 52.8 };
  const outline = lensClipOutline(item, item, 0, { left: 94, top: -6, width: 104.8, height: 104.8 });
  assert.equal(inside(outline, 52.4, 52.4), true);
  assert.equal(inside(outline, 27, 27), false);
  assert.ok(Math.abs(Math.max(...outline.map(p => p[0])) - 80.3) < .01);
  assert.equal(inside(outline, 79.6, 52.4), true, "the original shader's outside rim survives the safety clip");
  assert.equal(inside(outline, 82, 52.4), false, "the safety allowance is bounded");
});

test("Gooey contour crossfade uses a true union without filling the bridge or bounding rectangle", () => {
  const a: LensPlacement = { ...circle, left: 0, top: 0 };
  const b: LensPlacement = { ...circle, left: 60, top: 0,
    shape: { width: 44, height: 44, radius: 0, outline: [[0, 0], [0, 44], [44, 44], [44, 0]] } };
  const box = { left: 0, top: 0, width: 104, height: 44 };
  const blend = lensClipOutline(a, b, .5, box);
  assert.equal(inside(blend, 22, 22), true);
  assert.equal(inside(blend, 82, 22), true, "opposite input winding is normalized");
  assert.equal(inside(blend, 50, 22), false, "the retraced connector has no area");
  assert.equal(inside(lensClipOutline(a, b, 0, box), 82, 22), false);
  assert.equal(inside(lensClipOutline(a, b, 1, box), 22, 22), false);
});

test("a traced concave neck stays concave instead of becoming a rectangular fallback", () => {
  const neck: LensPlacement = { left: 0, top: 0, width: 80, height: 60, shape: { width: 80, height: 60, radius: 0,
    outline: [[0,0],[20,0],[20,20],[60,20],[60,0],[80,0],[80,60],[60,60],[60,40],[20,40],[20,60],[0,60]] } };
  const outline = lensClipOutline(neck, neck, 0, { left: 0, top: 0, width: 80, height: 60 });
  assert.equal(inside(outline, 40, 30), true);
  assert.equal(inside(outline, 40, 10), false);
  assert.equal(inside(outline, 40, 50), false);
});

class ElementFixture {
  children: ElementFixture[] = [];
  parent: ElementFixture | null = null;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<() => void>>();
  className = "";
  classList = { add: (name: string) => { this.className += ` ${name}`; } };
  constructor(readonly name: string, readonly root = false) {}
  get id() { return this.attributes.get("id") || ""; }
  set id(value: string) { this.attributes.set("id", value); }
  get isConnected(): boolean { return this.root || Boolean(this.parent?.isConnected); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  append(...nodes: ElementFixture[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: ElementFixture[]) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string) { this.listeners.get(type)?.forEach(listener => listener()); }
}
function walk(node: ElementFixture): ElementFixture[] { return [node, ...node.children.flatMap(walk)]; }
function withLensDOM(run: (host: ElementFixture) => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: (name: string) => new ElementFixture(name),
    createElementNS: (_: string, name: string) => new ElementFixture(name),
  } });
  try { run(new ElementFixture("host", true)); }
  finally { if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document"); }
}
const layer = { placement: circle, maps: { field: "data:field", rim: "data:rim" } };

test("HTML lens binds its filter and external contour before exposing source replicas", () => withLensDOM(host => {
  const lens = createGlassLens(host as unknown as HTMLElement, "chrome");
  assert.equal(walk(host).some(node => node.name === "foreignObject"), false);
  const strip = walk(host).find(node => node.className === "glass-optical-strip")!;
  assert.equal(strip.style.visibility, "hidden");
  assert.equal(lens.paint(layer, layer, 0, [], .5, false, 0), 0);
  const plane = strip.children[0];
  assert.equal(plane.name, "div");
  assert.match(plane.style.filter, /url\("#reader-glass-/);
  assert.match(strip.style.clipPath, /^polygon\(nonzero,/);
  assert.equal(strip.style.opacity, "0.500");
  assert.equal(strip.dataset.glassPrepared, "resources-and-binding");
  assert.equal(strip.style.visibility, "visible");
  lens.dispose();
  assert.equal(host.children.length, 0);
}));

test("an SVG map resource error event hides the lens and invokes failure exactly once", () => withLensDOM(host => {
  let failed = 0;
  const lens = createGlassLens(host as unknown as HTMLElement, "toolbar", () => failed++);
  lens.paint(layer, layer, 0, [], 1, false, 0);
  const strip = walk(host).find(node => node.className === "glass-optical-strip")!;
  const images = walk(host).filter(node => node.name === "feImage");
  images[0].emit("error"); images[1].emit("error");
  assert.equal(failed, 1);
  assert.equal(strip.style.visibility, "hidden");
  assert.equal(strip.dataset.glassPrepared, undefined);
  assert.throws(() => lens.paint(layer, layer, 0, [], 1, false, 0), /unavailable/);
  lens.dispose();
  images[0].emit("error");
  assert.equal(failed, 1);
}));

test("invalid geometry cannot be declared prepared or reveal a padded rectangle", () => withLensDOM(host => {
  const lens = createGlassLens(host as unknown as HTMLElement, "chrome");
  const invalid = { ...layer, placement: { ...circle, width: Number.NaN } };
  assert.throws(() => lens.paint(invalid, invalid, 0, [], 1, false, 0), /Invalid glass/);
  const strip = walk(host).find(node => node.className === "glass-optical-strip")!;
  assert.equal(strip.style.visibility, "hidden");
  assert.equal(strip.dataset.glassPrepared, undefined);
  lens.dispose();
}));


test("shared collection region is exactly the padded placement union", () => {
  assert.deepEqual(lensOpticalRegion(circle, circle), region);
  assert.deepEqual(lensOpticalRegion(circle, { ...circle, left: 180, top: 30 }), { left: 74, top: -16, width: 176, height: 116 });
});

test("a pure translation reuses the local polygon without revisiting its prepared outline", () => {
  let pointReads = 0;
  const outline = new Proxy<[number, number][]>([[0, 0], [40, 0], [40, 40], [0, 40]], {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) pointReads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const a: LensPlacement = { left: 10.1, top: 20.2, width: 40, height: 40, shape: { width: 40, height: 40, radius: 0, outline } };
  const first = lensClipPath(a, a, 0, lensOpticalRegion(a, a));
  assert.ok(pointReads > 0);
  pointReads = 0;
  const translated = { ...a, left: a.left + .3, top: a.top + 72.1 };
  assert.equal(lensClipPath(translated, translated, 0, lensOpticalRegion(translated, translated)), first);
  assert.equal(pointReads, 0);
  const scaled = { ...translated, width: 41 };
  assert.notEqual(lensClipPath(scaled, scaled, 0, lensOpticalRegion(scaled, scaled)), first);
  assert.ok(pointReads > 0);
});

test("viewport regions map to a nonzero, nonuniformly scaled host without scaling the source snapshot twice", () => {
  const host = { left: 34.25, top: 610.5, scaleX: .8, scaleY: 1.25 };
  const viewport = { left: 50.25, top: 635.5, width: 320, height: 90 };
  const local = lensHostPlacement(viewport, host);
  assert.deepEqual(local, { left: 20, top: 20, width: 320, height: 90, scaleX: 1.25, scaleY: .8 });
  for (const [x, y] of [[0, 0], [26, 26], [320, 90]]) {
    assert.equal(host.left + host.scaleX * (local.left + x * local.scaleX), viewport.left + x);
    assert.equal(host.top + host.scaleY * (local.top + y * local.scaleY), viewport.top + y);
  }
  assert.throws(() => lensHostPlacement(viewport, { ...host, scaleX: 0 }), /Invalid glass host/);
});

test("host measurement preserves fractional border-box size, border origin and scroll offset", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({
    width: "300.5px", height: "60.25px", boxSizing: "border-box", borderLeftWidth: "2px", borderTopWidth: "3px",
  }) });
  try {
    const host = { getBoundingClientRect: () => ({ left: 20.5, top: 630.25, width: 240.4, height: 75.3125 }),
      scrollLeft: 4, scrollTop: 5 } as unknown as HTMLElement;
    const result = measureLensHostTransform(host);
    assert.ok(Math.abs(result.scaleX - .8) < 1e-12);
    assert.equal(result.scaleY, 1.25);
    assert.ok(Math.abs(result.left - 18.9) < 1e-12);
    assert.equal(result.top, 627.75);
  } finally {
    if (original) Object.defineProperty(globalThis, "getComputedStyle", original);
    else Reflect.deleteProperty(globalThis, "getComputedStyle");
  }
});

test("toolbar and slider paint consume captured host coordinates without reading any live layout", () => withLensDOM(host => {
  Object.assign(host, { getBoundingClientRect() { throw new Error("paint read live host layout"); } });
  for (const kind of ["toolbar", "slider"] as const) {
    const lens = createGlassLens(host as unknown as HTMLElement, kind);
    const transform = { left: 30, top: 10, scaleX: .5, scaleY: 2 };
    lens.paint(layer, layer, 0, [], 1, false, 0, { roots: [], plans: [{ region, nodes: [] }] }, transform);
    const strip = walk(host).find(node => node.className === "glass-optical-strip")!;
    assert.equal(strip.style.left, "88px");
    assert.equal(strip.style.top, "-13px");
    assert.equal(strip.style.width, "96px");
    assert.equal(strip.style.height, "96px");
    assert.equal(strip.style.transform, "scale(2, 0.5)");
    assert.equal(strip.style.transformOrigin, "0 0");
    assert.match(strip.style.clipPath, /^polygon\(nonzero,/);
    assert.equal(strip.style.visibility, "visible");
    assert.throws(() => lens.paint(layer, layer, 0, [host as unknown as HTMLElement], 1, false, 0), /measured source snapshot/);
    lens.dispose();
  }
}));

test("a scaled local lens retains its outer clip and hides on filter resource failure", () => withLensDOM(host => {
  let failed = 0;
  const lens = createGlassLens(host as unknown as HTMLElement, "toolbar", () => failed++);
  lens.paint(layer, layer, 0, [], 1, false, 0, undefined, { left: 18, top: 600, scaleX: .9, scaleY: .9 });
  const strip = walk(host).find(node => node.className === "glass-optical-strip")!;
  const clip = strip.style.clipPath;
  walk(host).find(node => node.name === "feImage")!.emit("error");
  assert.equal(strip.style.visibility, "hidden");
  assert.equal(strip.style.clipPath, clip);
  assert.equal(failed, 1);
  lens.dispose();
}));
