import assert from "node:assert/strict";
import { test } from "node:test";
import { ChromeVisibility, chromeRouteFrame, chromeVisibilityScale, chromeOpticalOpacity, chromeExitOffset, canSettleChromeScroll } from "../lib/reader-chrome-motion";

test("scroll chrome settles with uniform scale and reaches each endpoint in 180ms", () => {
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


test("touch release cannot hide chrome outside a phone layout or in folded layout", () => {
  assert.equal(canSettleChromeScroll(false, false, true, false), false, "desktop/tablet touch scroll");
  assert.equal(canSettleChromeScroll(true, true, true, false), false, "folded phone touch scroll");
  assert.equal(canSettleChromeScroll(false, true, true, false), false, "folded tablet");
});

test("horizontal touch movement without a real chrome scrub never schedules settle", () => {
  assert.equal(canSettleChromeScroll(true, false, false, false), false);
  assert.equal(canSettleChromeScroll(true, false, false, true), false);
  assert.equal(canSettleChromeScroll(true, false, true, true), false, "hold remains directly driven");
  assert.equal(canSettleChromeScroll(true, false, true, false), true, "actual phone scrub can settle on release");
});

test("a pending settle rechecks live layout instead of remembering touchend eligibility", () => {
  let phone = true, folded = false;
  assert.equal(canSettleChromeScroll(phone, folded, true, false), true);
  phone = false;
  assert.equal(canSettleChromeScroll(phone, folded, true, false), false);
  phone = true; folded = true;
  assert.equal(canSettleChromeScroll(phone, folded, true, false), false);
});
