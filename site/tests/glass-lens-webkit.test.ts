import assert from "node:assert/strict";
import { test } from "node:test";

// Capture the engine branch at module initialization. This only verifies our
// reference invalidation protocol; it is not a Safari compositor/pixel test.
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { vendor: "Apple Computer, Inc.", userAgent: "AppleWebKit/605.1.15" } });
const { createGlassLens } = await import("../lib/glass-lens");
if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
else Reflect.deleteProperty(globalThis, "navigator");

class Fixture {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: Fixture[] = [];
  attrs = new Map<string, string>();
  classList = { add() {} };
  isConnected = true;
  className = "";
  constructor(readonly name: string) {}
  get id() { return this.attrs.get("id") || ""; }
  set id(value: string) { this.attrs.set("id", value); }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  append(...nodes: Fixture[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Fixture[]) { this.children = nodes; }
  addEventListener() {}
  removeEventListener() {}
  remove() {}
}
const flatten = (node: Fixture): Fixture[] => [node, ...node.children.flatMap(flatten)];

test("WebKit gets a fresh filter ID only when material inputs change, with the HTML reference rebound", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: (name: string) => new Fixture(name),
    createElementNS: (_: string, name: string) => new Fixture(name),
  } });
  try {
    const host = new Fixture("host");
    const lens = createGlassLens(host as unknown as HTMLElement, "chrome");
    const placement = { left: 20, top: 10, width: 44, height: 44, shape: { width: 44, height: 44, radius: "circle" as const } };
    const a = { placement, maps: { field: "data:field-a", rim: "data:rim-a" } };
    const filter = flatten(host).find(node => node.name === "filter")!;
    const plane = flatten(host).find(node => node.className === "glass-optical-plane")!;
    const initial = filter.id;
    lens.paint(a, a, 0, [], 1, false, 0);
    const decoded = filter.id;
    assert.notEqual(decoded, initial);
    assert.equal(plane.style.filter, `url("#${decoded}")`);
    const moved = { ...a, placement: { ...placement, left: 36, width: 52.8, height: 52.8 } };
    lens.paint(moved, moved, 0, [], .5, false, 0);
    assert.equal(filter.id, decoded);
    const b = { placement, maps: { field: "data:field-b", rim: "data:rim-b" } };
    lens.paint(a, b, .5, [], 1, false, 0);
    assert.notEqual(filter.id, decoded);
    assert.equal(plane.style.filter, `url("#${filter.id}")`);
    lens.dispose();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
