import assert from "node:assert/strict";
import { test } from "node:test";
import { intersectsOpticalBox, opticalChildClip, OpticalSource } from "../lib/glass-optical-source";

test("a lens samples only boxes intersecting its padded optical region", () => {
  const strip = { left: 70, top: 0, width: 100, height: 104 };
  assert.equal(intersectsOpticalBox({ left: 12, top: -60, width: 320, height: 130 }, strip), true);
  assert.equal(intersectsOpticalBox({ left: 12, top: 104, width: 320, height: 130 }, strip), false);
  assert.equal(intersectsOpticalBox({ left: 0, top: 20, width: 70, height: 24 }, strip), false);
  assert.equal(intersectsOpticalBox({ left: 90, top: 20, width: 0, height: 24 }, strip), false);
});

test("a translated Swiper track preserves a visible later slide as an optical source", () => {
  const lens = { left: 300, top: 0, width: 96, height: 96 };
  const carousel = { left: 16, top: -80, width: 445, height: 445 };
  const track = { left: -429, top: -80, width: 445, height: 445 };
  const activeCover = { left: 16, top: -80, width: 445, height: 309 };
  const viewportClip = opticalChildClip(lens, carousel, "hidden", "hidden");
  assert.equal(intersectsOpticalBox(track, viewportClip), false);
  const trackClip = opticalChildClip(viewportClip, track, "visible", "visible");
  assert.deepEqual(trackClip, lens);
  assert.equal(intersectsOpticalBox(activeCover, trackClip), true);
});

test("clipping ancestors exclude offscreen slides and preserve each overflow axis", () => {
  const lens = { left: 420, top: 0, width: 96, height: 96 };
  const carousel = { left: 16, top: -80, width: 445, height: 445 };
  const clip = opticalChildClip(lens, carousel, "hidden", "hidden");
  assert.deepEqual(clip, { left: 420, top: 0, width: 41, height: 96 });
  assert.equal(intersectsOpticalBox({ left: 461, top: -80, width: 445, height: 309 }, clip), false);
  assert.deepEqual(opticalChildClip(lens, carousel, "visible", "clip"), lens);
  assert.equal(opticalChildClip(lens, { left: -445, top: 0, width: 445, height: 445 }, "hidden", "hidden").width, 0);
});

test("an offscreen article branch is pruned before inspecting its descendants or styles", () => {
  let measurements = 0;
  const descendant = {
    getBoundingClientRect() { throw new Error("An offscreen article descendant must not be measured"); },
  };
  const section = {
    matches: () => false,
    children: Array.from({ length: 1000 }, () => descendant),
    getBoundingClientRect() {
      measurements++;
      return { left: 16, top: 1200, width: 445, height: 20000 };
    },
  } as unknown as HTMLElement;
  const source = new OpticalSource({ replaceChildren() {} } as unknown as HTMLElement);
  // This runs without browser style globals: early pruning needs only the
  // section's box, even when it contains a large daily's remaining content.
  assert.equal(source.update([section], { left: 300, top: 0, width: 96, height: 96 }), 0);
  assert.equal(measurements, 1);
});

// A small DOM fixture exercises the actual replica tree without a browser or
// image decoder. Rendering and live frame continuity are checked separately.
function fixtureStyle(values: Record<string, string> = {}) {
  const data: Record<string, string> = {
    boxSizing: "border-box", width: "100px", height: "100px", display: "block", visibility: "visible",
    opacity: "1", filter: "none", clipPath: "none", backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none", overflowX: "visible", overflowY: "visible", ...values,
  };
  const key = (property: string) => property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return Object.assign(data, {
    getPropertyValue(property: string) { return data[key(property)] || ""; },
    setProperty(property: string, value: string) { data[key(property)] = value; },
  }) as unknown as CSSStyleDeclaration;
}

class FixtureElement {
  readonly nodeType = 1;
  readonly tagName = "DIV";
  readonly textContent = "";
  style = fixtureStyle();
  computed: CSSStyleDeclaration;
  children: FixtureElement[] = [];
  parent: FixtureElement | null = null;
  constructor(readonly box = { left: 0, top: 0, width: 100, height: 100 }, values: Record<string, string> = {}) {
    this.computed = fixtureStyle({ width: `${box.width}px`, height: `${box.height}px`, ...values });
  }
  get childNodes() { return this.children; }
  get offsetWidth() { return parseFloat(this.computed.width); }
  get offsetHeight() { return parseFloat(this.computed.height); }
  getBoundingClientRect() {
    return { ...this.box, right: this.box.left + this.box.width, bottom: this.box.top + this.box.height };
  }
  matches() { return false; }
  querySelector() { return this.children[0] || null; }
  append(...nodes: FixtureElement[]) {
    for (const node of nodes) {
      if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node);
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: FixtureElement[]) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
}

function withOpticalDOM(run: () => void) {
  class FixtureImage extends FixtureElement {}
  const replacements = {
    HTMLElement: FixtureElement, HTMLImageElement: FixtureImage, Node: { TEXT_NODE: 3 },
    document: { createElement: () => new FixtureElement() },
    getComputedStyle: (node: FixtureElement) => node.computed,
  };
  const original = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, value });
    run();
  } finally {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const asElement = (node: FixtureElement) => node as unknown as HTMLElement;
const region = { left: 0, top: 0, width: 100, height: 100 };

test("overlapping source pieces receive their ancestor opacity and blur as one group", () => withOpticalDOM(() => {
  const source = new FixtureElement(region, { opacity: ".62", filter: "blur(5px)" });
  source.append(new FixtureElement(region, { backgroundColor: "red" }), new FixtureElement(region, { backgroundColor: "blue" }));
  const layer = new FixtureElement();
  const optics = new OpticalSource(asElement(layer));
  assert.equal(optics.update([asElement(source)], region), 2);
  assert.equal(layer.children.length, 1);
  const group = layer.children[0];
  assert.equal(group.style.opacity, ".62");
  assert.equal(group.style.filter, "blur(5px)");
  assert.equal(group.children.length, 2);
  for (const piece of group.children) {
    assert.equal(piece.style.opacity, "1");
    assert.equal(piece.style.filter, "none");
  }
}));

test("nested effect groups retain current card inset calc and rounded clipping in local coordinates", () => withOpticalDOM(() => {
  const clip = "inset(10px calc(100% - 260px) calc(100% - 190px) 20px round 24px)";
  const source = new FixtureElement({ left: 100, top: 40, width: 200, height: 160 },
    { width: "400px", height: "320px", clipPath: clip });
  const inner = new FixtureElement({ left: 110, top: 50, width: 100, height: 80 },
    { width: "200px", height: "160px", opacity: ".5", filter: "blur(2px)" });
  inner.append(new FixtureElement({ left: 115, top: 60, width: 20, height: 10 },
    { width: "40px", height: "20px", backgroundColor: "red" }));
  source.append(inner);
  const layer = new FixtureElement();
  const optics = new OpticalSource(asElement(layer));
  assert.equal(optics.update([asElement(source)], { left: 100, top: 40, width: 100, height: 100 }), 1);
  const outer = layer.children[0], nested = outer.children[0], piece = nested.children[0];
  assert.equal(outer.style.clipPath, clip);
  assert.equal(outer.style.width, "400px");
  assert.equal(outer.style.height, "320px");
  assert.equal(outer.style.transform, "translate(0px, 0px) scale(0.5, 0.5)");
  assert.equal(nested.style.transform, "translate(20px, 20px) scale(1, 1)");
  assert.equal(piece.style.transform, "translate(10px, 20px) scale(1, 1)");
}));

test("finished theme effects return cached pieces to a clear stable plane without a refresh", () => withOpticalDOM(() => {
  const source = new FixtureElement(region, { opacity: ".62", filter: "blur(5px)" });
  source.append(new FixtureElement(region, { backgroundColor: "red" }));
  const layer = new FixtureElement();
  const optics = new OpticalSource(asElement(layer));
  optics.update([asElement(source)], region);
  const piece = layer.children[0].children[0];
  source.computed.opacity = "1";
  source.computed.filter = "none";
  optics.update([asElement(source)], region);
  assert.deepEqual(layer.children, [piece]);
  assert.equal(piece.style.opacity, "1");
  assert.equal(piece.style.filter, "none");
  optics.update([asElement(source)], region);
  assert.deepEqual(layer.children, [piece]);
  optics.clear();
  assert.equal(layer.children.length, 0);
}));

test("effect groups preserve the 96-piece sampling boundary", () => withOpticalDOM(() => {
  const source = new FixtureElement(region, { opacity: ".5" });
  source.append(...Array.from({ length: 120 }, () => new FixtureElement(region, { backgroundColor: "red" })));
  const layer = new FixtureElement();
  const optics = new OpticalSource(asElement(layer));
  assert.equal(optics.update([asElement(source)], region), 96);
  assert.equal(layer.children[0].children.length, 96);
}));
