import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpticalFrame, intersectsOpticalBox, opticalChildClip, OpticalSource } from "../lib/glass-optical-source";

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
function fixtureStyle(values: Record<string, string> = {}, onWrite: () => void = () => {}) {
  const data: Record<string, string> = {
    boxSizing: "border-box", width: "100px", height: "100px", display: "block", visibility: "visible",
    opacity: "1", filter: "none", clipPath: "none", backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none", overflowX: "visible", overflowY: "visible", ...values,
  };
  const key = (property: string) => property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return Object.assign(data, {
    getPropertyValue(property: string) { return data[key(property)] || ""; },
    setProperty(property: string, value: string) { onWrite(); data[key(property)] = value; },
  }) as unknown as CSSStyleDeclaration;
}

class FixtureElement {
  readonly nodeType = 1;
  readonly tagName = "DIV";
  get textContent(): string { return this.children.map(child => child.textContent).join(""); }
  measurements = 0;
  styleReads = 0;
  styleWrites = 0;
  style = fixtureStyle({}, () => this.styleWrites++);
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
    this.measurements++;
    return { ...this.box, right: this.box.left + this.box.width, bottom: this.box.top + this.box.height };
  }
  matches() { return false; }
  querySelector(): FixtureElement | null { return this.children[0] || null; }
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
    document: { createElement: () => new FixtureElement(), createTextNode: (text: string) => ({ nodeType: 3, textContent: text, parent: null }) },
    getComputedStyle: (node: FixtureElement) => { node.styleReads++; return node.computed; },
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

test("a stable cover wrapper masks its moving blurred child once in wrapper coordinates", () => withOpticalDOM(() => {
  const mask = "linear-gradient(black 42%, transparent 100%)";
  const wrapper = new FixtureElement(region, { maskImage: mask, WebkitMaskImage: mask, maskSize: "100% 100%", maskPosition: "0% 0%", maskRepeat: "no-repeat" });
  const image = new FixtureElement({ left: 0, top: 12, width: 100, height: 100 }, { backgroundColor: "red", filter: "blur(6px)" });
  wrapper.append(image);
  const layer = new FixtureElement();
  const optics = new OpticalSource(asElement(layer));
  assert.equal(optics.update([asElement(wrapper)], region), 1);
  const maskGroup = layer.children[0], blurGroup = maskGroup.children[0], piece = blurGroup.children[0];
  assert.equal(maskGroup.style.getPropertyValue("mask-image"), mask);
  assert.equal(maskGroup.style.getPropertyValue("-webkit-mask-image"), mask);
  assert.equal(maskGroup.style.getPropertyValue("mask-size"), "100% 100%");
  assert.equal(maskGroup.style.getPropertyValue("mask-repeat"), "no-repeat");
  assert.equal(blurGroup.style.transform, "translate(0px, 12px) scale(1, 1)");
  assert.equal(blurGroup.style.filter, "blur(6px)");
  assert.equal(piece.style.maskImage, "none");
  wrapper.computed.maskImage = "none";
  wrapper.computed.setProperty("-webkit-mask-image", "none");
  optics.update([asElement(wrapper)], region);
  assert.equal(layer.children[0], blurGroup, "a removed ancestor mask does not leave a stale masked replica");
}));


test("one frame shares source measurements and frozen styles across overlapping lenses", () => withOpticalDOM(() => {
  const wrapper = new FixtureElement(region, { opacity: ".6", maskImage: "linear-gradient(black, transparent)" });
  const piece = new FixtureElement(region, { backgroundColor: "red" });
  wrapper.append(piece);
  const roots = [asElement(wrapper)];
  const second = { left: 40, top: 0, width: 60, height: 100 };
  const snapshot = createOpticalFrame(roots, [region, second]);
  assert.equal(wrapper.measurements, 1); assert.equal(piece.measurements, 1);
  assert.equal(wrapper.styleReads, 1); assert.equal(piece.styleReads, 1);
  piece.computed.backgroundColor = "blue";
  wrapper.computed.opacity = ".9";
  wrapper.getBoundingClientRect = piece.getBoundingClientRect = () => { throw new Error("paint must not measure a source"); };
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => { throw new Error("paint must not read live styles"); } });
  const a = new FixtureElement(), b = new FixtureElement();
  assert.equal(new OpticalSource(asElement(a)).update(roots, region, false, snapshot), 1);
  assert.equal(new OpticalSource(asElement(b)).update(roots, second, true, snapshot), 1);
  for (const layer of [a, b]) {
    assert.equal(layer.children[0].style.opacity, ".6");
    assert.equal(layer.children[0].children[0].style.backgroundColor, "red");
  }
}));

test("inline descendants are captured once and no source style reads follow replica writes", () => withOpticalDOM(() => {
  const text = { nodeType: 3, textContent: "Captured text", parent: null } as unknown as FixtureElement;
  const span = new FixtureElement(region, { color: "red" });
  span.append(text);
  const paragraph = new FixtureElement();
  paragraph.matches = (selector?: string) => selector === "p, h1, h2, h3, h4, h5, h6, pre, figcaption, dt, dd, blockquote, td, th, li";
  paragraph.querySelector = () => null;
  paragraph.append(span);
  const roots = [asElement(paragraph)];
  const second = { left: 20, top: 0, width: 80, height: 100 };
  const snapshot = createOpticalFrame(roots, [region, second]);
  assert.equal(paragraph.styleReads, 1); assert.equal(span.styleReads, 1);
  span.computed.color = "blue";
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => { throw new Error("no post-collection reads"); } });
  for (const box of [region, second]) {
    const layer = new FixtureElement();
    const optics = new OpticalSource(asElement(layer));
    assert.equal(optics.update(roots, box, true, snapshot), 1);
    assert.equal(optics.visibleTextCount, 1);
    assert.equal(layer.children[0].children[0].style.color, "red");
    assert.equal(layer.children[0].textContent, "Captured text");
  }
}));

test("separated lens regions retain independent 96-piece limits without sampling their gap", () => withOpticalDOM(() => {
  const a = new FixtureElement(region), bBox = { left: 200, top: 0, width: 100, height: 100 };
  const b = new FixtureElement(bBox);
  a.append(...Array.from({ length: 120 }, () => new FixtureElement(region, { backgroundColor: "red" })));
  b.append(...Array.from({ length: 120 }, () => new FixtureElement(bBox, { backgroundColor: "blue" })));
  const gap = new FixtureElement({ left: 110, top: 0, width: 80, height: 100 });
  gap.append(new FixtureElement());
  gap.children[0].getBoundingClientRect = () => { throw new Error("the gap is outside both regions"); };
  const roots = [a, gap, b].map(asElement);
  const snapshot = createOpticalFrame(roots, [region, bBox]);
  assert.equal(gap.measurements, 1); assert.equal(gap.styleReads, 0);
  for (const box of [region, bBox]) {
    const layer = new FixtureElement();
    assert.equal(new OpticalSource(asElement(layer)).update(roots, box, false, snapshot), 96);
    assert.equal(layer.children.length, 96);
  }
}));

test("unchanged masks and piece styles are not written again for a reused snapshot", () => withOpticalDOM(() => {
  const wrapper = new FixtureElement(region, { maskImage: "linear-gradient(black, transparent)", maskRepeat: "no-repeat" });
  wrapper.append(new FixtureElement(region, { backgroundColor: "red" }));
  const roots = [asElement(wrapper)], snapshot = createOpticalFrame(roots, [region]);
  const layer = new FixtureElement(), source = new OpticalSource(asElement(layer));
  source.update(roots, region, false, snapshot);
  const group = layer.children[0], piece = group.children[0];
  const writes = [group.styleWrites, piece.styleWrites];
  source.update(roots, region, false, snapshot);
  assert.deepEqual([group.styleWrites, piece.styleWrites], writes);
}));

test("a snapshot cannot silently remeasure an uncollected region", () => withOpticalDOM(() => {
  const source = new OpticalSource(asElement(new FixtureElement()));
  const snapshot = createOpticalFrame([], [region]);
  assert.throws(() => source.update([], { ...region, left: 10 }, false, snapshot), /does not cover/);
}));
