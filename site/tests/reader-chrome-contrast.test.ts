import assert from "node:assert/strict";
import { test } from "node:test";
import { coverGlyphTone, coverMaskAlpha, sampleCoverBrightness } from "../lib/reader-chrome-contrast";

test("cream covers choose dark ink while dark covers choose white regardless of theme", () => {
  assert.equal(coverGlyphTone(.84), "dark");
  assert.equal(coverGlyphTone(.12), "light");
});
test("hysteresis keeps glyph colour stable at a moving brightness boundary", () => {
  assert.equal(coverGlyphTone(.52, "light"), "light");
  assert.equal(coverGlyphTone(.58, "light"), "dark");
  assert.equal(coverGlyphTone(.44, "dark"), "dark");
  assert.equal(coverGlyphTone(.38, "dark"), "light");
});
test("local sampling selects the actual button region rather than the whole cover average", () => {
  const pixels = new Uint8ClampedArray(32 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const at = (y * 32 + x) * 4;
    pixels.fill(x < 16 ? 20 : 240, at, at + 3); pixels[at + 3] = 255;
  }
  assert.equal(coverGlyphTone(sampleCoverBrightness(pixels, .2, .5, .04, .04)!), "light");
  assert.equal(coverGlyphTone(sampleCoverBrightness(pixels, .8, .5, .04, .04)!), "dark");
  assert.equal(sampleCoverBrightness(new Uint8ClampedArray(32 * 32 * 4), .5, .5, .1, .1), null);
});
test("cover mask alpha follows the existing cover fade instead of retaining raw bright-image ink", () => {
  assert.equal(coverMaskAlpha(.2), 1);
  assert.equal(coverMaskAlpha(.61), .88);
  assert.ok(Math.abs(coverMaskAlpha(.83) - .28) < .00001);
  assert.equal(coverMaskAlpha(1), 0);
});
