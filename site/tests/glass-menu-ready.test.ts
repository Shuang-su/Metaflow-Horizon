import assert from "node:assert/strict";
import { test } from "node:test";
import { glassMenuContainsContent } from "../lib/glass-menu-ready";

test("a menu becomes interactive on its first complete frame even if spring overshoot skips endpoint equality", () => {
  const target = { left: 263, top: 56, width: 326, height: 622.938 };
  assert.equal(glassMenuContainsContent({ left: 267.19, top: 56.1, width: 321.81, height: 620 }, target), false);
  assert.equal(glassMenuContainsContent({ left: 261.786, top: 55.6, width: 327.214, height: 624 }, target), true);
  assert.equal(glassMenuContainsContent(target, target), true);
});

test("a large shape displaced away from the menu does not expose incomplete content", () => {
  const target = { left: 263, top: 56, width: 326, height: 622.938 };
  assert.equal(glassMenuContainsContent({ ...target, left: 270, width: 340 }, target), false);
  assert.equal(glassMenuContainsContent({ ...target, top: 60, height: 630 }, target), false);
  assert.equal(glassMenuContainsContent({ ...target, height: 500 }, target), false);
});
