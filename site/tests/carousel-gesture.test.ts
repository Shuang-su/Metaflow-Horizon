import assert from "node:assert/strict";
import { test } from "node:test";
import { carouselAxis, carouselSnap, isCarouselEdge } from "../lib/carousel-gesture";

test("carousel leaves the first and last 24px of the viewport to system touch gestures", () => {
  assert.equal(isCarouselEdge(20, 495), true);
  assert.equal(isCarouselEdge(475, 495), true);
  assert.equal(isCarouselEdge(24, 495), false);
  assert.equal(isCarouselEdge(471, 495), false);
});

test("carousel waits for intent and preserves vertical and diagonal scroll", () => {
  assert.equal(carouselAxis(5, 3), null);
  assert.equal(carouselAxis(17, 8), "horizontal");
  assert.equal(carouselAxis(16, 15), "vertical");
});

test("carousel advances one slide for displacement or a deliberate flick", () => {
  assert.equal(carouselSnap(-120, 400), 1);
  assert.equal(carouselSnap(120, 400), -1);
  assert.equal(carouselSnap(-36, 400, -.6), 1);
  assert.equal(carouselSnap(-36, 400, .6), 0);
  assert.equal(carouselSnap(-15, 400, -2), 0);
});
