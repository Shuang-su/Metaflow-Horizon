import assert from "node:assert/strict";
import { test } from "node:test";
import { pullGeometry, pullKinematics, shouldDismiss } from "../lib/card-pull-dismiss";

test("a pulled article follows the finger while its horizontal center stays anchored", () => {
  const width = 390;
  const height = 844;
  const start = pullGeometry(0, width, height);
  const pull = pullGeometry(130, width, height);
  assert.deepEqual(start.rect, { x: 0, y: 0, width, height });
  assert.equal(pull.rect.y, 130);
  assert.equal(pull.rect.x + pull.rect.width / 2, width / 2);
  assert.ok(pull.scale < 1 && pull.radius > 0);
});

test("long pulls and intentional flicks can dismiss, but short pulls and brakes do not", () => {
  assert.equal(shouldDismiss(116, 0), true);
  assert.equal(shouldDismiss(62, .65), true);
  assert.equal(shouldDismiss(42, 1.2), true);
  assert.equal(shouldDismiss(41, 3), false);
  assert.equal(shouldDismiss(115, -.8), false);
  assert.equal(shouldDismiss(62, .65, -.02), false);
});

test("recent samples identify acceleration, braking and a hold before release", () => {
  const times = [0, 20, 40, 60, 80];
  const samples = (positions: number[]) => positions.map((distance, index) => ({ distance, time: times[index] }));
  const flick = pullKinematics(samples([0, 4, 11, 30, 62]), 82);
  assert.ok(flick.velocity > 1 && flick.acceleration > 0);
  assert.ok(shouldDismiss(62, flick.velocity, flick.acceleration));
  const brake = pullKinematics(samples([0, 22, 52, 60, 62]), 82);
  assert.ok(brake.acceleration < 0);
  assert.equal(shouldDismiss(62, brake.velocity, brake.acceleration), false);
  assert.deepEqual(pullKinematics(samples([0, 4, 11, 30, 62]), 140), { velocity: 0, acceleration: 0 });
});

test("drop tray follows reference progress and uses the circular target, not its bounding square", async () => {
  const { readLaterDropFrame } = await import("../lib/card-pull-dismiss");
  assert.equal(readLaterDropFrame(63, 420, 840, 400, 800).progress, 0);
  const revealed = readLaterDropFrame(252, 420, 840, 400, 800);
  assert.ok(Math.abs(revealed.progress - 1) < .00001);
  assert.equal(revealed.radius, 159.6);
  assert.equal(revealed.selected, true);
  assert.equal(readLaterDropFrame(252, 420, 840, 270, 690).selected, false);
  assert.equal(readLaterDropFrame(252, 420, 840, 400, 600).selected, false);
  assert.equal(readLaterDropFrame(20, 420, 840, 400, 800).selected, false);
});

test("width threshold ignores browser height changes but detects reflow", async () => {
  const { viewportWidthChanged } = await import("../lib/card-pull-dismiss");
  assert.equal(viewportWidthChanged(420, 420), false);
  assert.equal(viewportWidthChanged(420, 420.5), false);
  assert.equal(viewportWidthChanged(420, 840), true);
});


test("half-revealed tray only selects inside its visible growing radius", async () => {
  const { readLaterDropFrame } = await import("../lib/card-pull-dismiss");
  const partial = readLaterDropFrame(157.5, 420, 840, 320, 800);
  assert.ok(Math.abs(partial.progress - .5) < .00001);
  assert.ok(Math.abs(partial.visibleRadius - 79.8) < .00001);
  assert.ok(Math.hypot(420 - partial.x, 840 - partial.y) < partial.radius);
  assert.equal(partial.selected, false);
  assert.equal(readLaterDropFrame(157.5, 420, 840, 390, 800).selected, true);
  assert.equal(readLaterDropFrame(252, 420, 840, 320, 800).selected, true);
  assert.equal(readLaterDropFrame(100, 420, 840, 390, 800).selected, false);
});
