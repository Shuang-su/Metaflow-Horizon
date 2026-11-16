import assert from "node:assert/strict";
import { test } from "node:test";
import { focusReadingTarget } from "../lib/reading-focus";

function target(interactive: boolean) {
  const node = new EventTarget();
  const attrs = new Map<string, string>();
  let focused = false;
  Object.assign(node, {
    isConnected: true, dataset: {},
    matches: () => interactive,
    hasAttribute: (name: string) => attrs.has(name),
    removeAttribute: (name: string) => attrs.delete(name),
    focus: () => { focused = true; },
  });
  Object.defineProperty(node, "tabIndex", { set(value: number) { attrs.set("tabindex", String(value)); } });
  return { node: node as unknown as HTMLElement, attrs, focused: () => focused };
}

test("pointer return preserves an anchor's navigation focus without a sticky visual selection", () => {
  const f = target(true);
  focusReadingTarget(f.node, true);
  assert.equal(f.focused(), true);
  assert.equal(f.node.dataset.readerFocusTarget, "");
  assert.equal(f.attrs.has("tabindex"), false, "the link stays in normal keyboard order");
  f.node.dispatchEvent(new Event("keydown"));
  assert.equal(f.node.dataset.readerFocusTarget, undefined, "keyboard use immediately restores its focus indication");
});

test("keyboard return keeps the ordinary indicator, and quiet focus is cleared on blur", () => {
  const f = target(true);
  focusReadingTarget(f.node);
  assert.equal(f.node.dataset.readerFocusTarget, undefined);
  focusReadingTarget(f.node, true);
  f.node.dispatchEvent(new Event("blur"));
  assert.equal(f.node.dataset.readerFocusTarget, undefined);
});

test("heading navigation remains focusable only for the lifetime of its announced focus", () => {
  const f = target(false);
  focusReadingTarget(f.node);
  assert.equal(f.attrs.get("tabindex"), "-1");
  assert.equal(f.focused(), true);
  f.node.dispatchEvent(new Event("blur"));
  assert.equal(f.attrs.has("tabindex"), false);
});
