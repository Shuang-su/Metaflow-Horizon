import assert from "node:assert/strict";
import { test } from "node:test";
import { ChromeVisibility, chromeRouteFrame, chromeVisibilityScale, chromeOpticalOpacity, chromeExitOffset } from "../lib/reader-chrome-motion";

test("explicit visibility changes use uniform scale and finish in 180ms", () => {
  const state = new ChromeVisibility();
  state.set(false, 0);
  assert.equal(state.sample(90), .5);
  assert.equal(chromeVisibilityScale(state.value), .98);
  assert.equal(state.sample(180), 0);
  assert.equal(chromeVisibilityScale(state.value), .96);
  assert.equal(state.moving, false);
  state.set(true, 180);
  assert.equal(state.sample(360), 1);
});

test("rapid reversals continue from the sampled current value without an endpoint jump", () => {
  const state = new ChromeVisibility();
  state.set(false, 0);
  const before = state.sample(60);
  state.set(true, 60);
  assert.equal(state.sample(60), before);
  assert.ok(state.sample(90) > before);
  const reversed = state.sample(90);
  state.set(false, 90);
  assert.equal(state.sample(90), reversed);
  assert.equal(state.sample(270), 0);
});

test("reduced motion settles immediately, including when changed mid-transition", () => {
  const state = new ChromeVisibility();
  state.set(false, 0);
  state.sample(60);
  state.set(true, 60, true);
  assert.equal(state.sample(60), 1);
  assert.equal(state.moving, false);
  state.set(false, 70, true);
  assert.equal(state.sample(70), 0);
});

test("route shell peaks at 1.2 while glyph crossfade finishes before shell settles", () => {
  assert.deepEqual(chromeRouteFrame(0), { scale: 1, glyph: 0 });
  assert.equal(chromeRouteFrame(160).scale, 1.2);
  assert.equal(chromeRouteFrame(180).glyph, 1);
  assert.ok(chromeRouteFrame(180).scale > 1);
  assert.deepEqual(chromeRouteFrame(320), { scale: 1, glyph: 1 });
  assert.deepEqual(chromeRouteFrame(900), { scale: 1, glyph: 1 });
});

test("the same q multiplies optical alpha and menu absorption without adding a second disc", () => {
  assert.equal(chromeOpticalOpacity(.5, .5), .25);
  assert.equal(chromeOpticalOpacity(0, 0), 0);
  assert.equal(chromeOpticalOpacity(1, 1), 0);
  assert.equal(chromeOpticalOpacity(1, 0), 1);
});


test("scroll displacement scrubs progress directly and reversing retraces it before release", () => {
  const state = new ChromeVisibility();
  assert.equal(state.follow(16, 10), .75);
  assert.equal(state.sample(100), .75, "holding a gesture does not start an automatic hide");
  assert.equal(state.follow(16, 120), .5);
  assert.equal(state.follow(-8, 125), .625);
  assert.equal(state.follow(-24, 140), 1);
  assert.equal(state.follow(200, 145), 0);
  assert.equal(state.follow(-200, 150), 1);
});

test("a held scroll can resume continuously from a partially settled release", () => {
  const state = new ChromeVisibility();
  state.follow(32, 0);
  state.set(false, 0);
  const releaseValue = state.sample(60);
  assert.equal(state.follow(-8, 60), releaseValue + .125);
});

test("the complete right group exits using a single shared displacement and stable y", () => {
  const viewport = 613;
  const groupLeft = 449;
  const delta = chromeExitOffset(0, "right", groupLeft, 148, viewport);
  assert.equal(delta, 180);
  for (const buttonLeft of [449, 501, 553]) assert.ok(buttonLeft + delta > viewport);
  assert.equal(chromeExitOffset(.5, "right", groupLeft, 148, viewport), delta / 2);
  assert.equal(chromeExitOffset(1, "right", groupLeft, 148, viewport), 0);
  assert.equal(chromeExitOffset(0, "left", 16, 44, viewport), -76);
});


test("scroll progress is independent of event rate and retains fractional distances", () => {
  const a = new ChromeVisibility(), b = new ChromeVisibility(), c = new ChromeVisibility();
  for (let i = 0; i < 32; i++) a.follow(.5, i * 10);
  for (let i = 0; i < 16; i++) b.follow(1, i * 300);
  c.follow(16, 100);
  assert.equal(a.value, .75);
  assert.equal(a.value, b.value);
  assert.equal(a.value, c.value);
  assert.equal(a.sample(10_000), .75, "elapsed time alone must not finish a scrub");
  for (let i = 0; i < 16; i++) a.follow(-.5, 10_000 + i * 50);
  assert.equal(a.value, .875);
  assert.equal(a.sample(60_000), .875);
});
