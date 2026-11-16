import assert from "node:assert/strict";
import { test } from "node:test";
import { ChromeVisibility, chromeVisibilityScale } from "../lib/reader-chrome-motion";
import { paintReaderToolbarMotion, clearReaderToolbarMotion } from "../lib/reader-toolbar-motion";

function fixture() {
  const values = new Map<string, string>();
  let writes = 0;
  const motion = { inert: false, style: {
    getPropertyValue: (key: string) => values.get(key) || "",
    setProperty: (key: string, value: string) => { writes++; values.set(key, value); },
    removeProperty: (key: string) => values.delete(key),
  } };
  const root = { querySelectorAll: (selector: string) => {
    assert.equal(selector, "[data-reader-toolbar-motion]"); return [motion];
  } } as unknown as ParentNode;
  return { root, motion, values, writes: () => writes };
}

test("toolbar and header share the same paused and reversed scroll progress", () => {
  const f = fixture(), visibility = new ChromeVisibility();
  const paint = (now: number) => { const q = visibility.sample(now); paintReaderToolbarMotion(f.root, q, chromeVisibilityScale(q)); return q; };
  visibility.follow(32, 0);
  assert.equal(paint(0), .5);
  assert.equal(f.values.get("--reader-chrome-q"), "0.5");
  assert.equal(f.values.get("--reader-toolbar-exit"), "0.5");
  assert.equal(f.values.get("--reader-toolbar-scale"), "0.98");
  const written = f.writes(); paint(10_000);
  assert.equal(f.writes(), written, "a held gesture does not restart an independent animation");
  visibility.follow(-8, 10_001); paint(10_001);
  assert.equal(f.values.get("--reader-chrome-q"), "0.625");
  assert.equal(f.values.get("--reader-toolbar-exit"), "0.375");
  visibility.follow(-24, 10_002); paint(10_002);
  assert.equal(f.values.get("--reader-toolbar-exit"), "0");
  assert.equal(f.motion.inert, false);
});

test("the fully hidden toolbar cannot receive input and a protected reveal restores its entire group", () => {
  const f = fixture(), visibility = new ChromeVisibility();
  visibility.follow(64, 0);
  paintReaderToolbarMotion(f.root, visibility.value, chromeVisibilityScale(visibility.value));
  assert.equal(f.motion.inert, true);
  // ReadingExperience uses this same reveal for a menu, dialog or focus entry.
  visibility.set(true, 100);
  const halfway = visibility.sample(190);
  paintReaderToolbarMotion(f.root, halfway, chromeVisibilityScale(halfway));
  assert.equal(halfway, .5);
  assert.equal(f.motion.inert, false);
  const complete = visibility.sample(280);
  paintReaderToolbarMotion(f.root, complete, chromeVisibilityScale(complete));
  assert.equal(f.values.get("--reader-chrome-q"), "1");
  assert.equal(f.values.get("--reader-toolbar-exit"), "0");
  assert.equal(f.values.get("--reader-toolbar-scale"), "1");
});

test("route/reduced-motion reset and disposal leave no stale hidden interaction state", () => {
  const f = fixture(), visibility = new ChromeVisibility();
  visibility.follow(64, 0);
  paintReaderToolbarMotion(f.root, visibility.value, chromeVisibilityScale(visibility.value));
  visibility.set(true, 1, true);
  paintReaderToolbarMotion(f.root, visibility.value, chromeVisibilityScale(visibility.value));
  assert.equal(f.motion.inert, false);
  visibility.follow(64, 2);
  paintReaderToolbarMotion(f.root, visibility.value, chromeVisibilityScale(visibility.value));
  clearReaderToolbarMotion(f.root);
  assert.equal(f.motion.inert, false);
  assert.equal(f.values.size, 0);
});
