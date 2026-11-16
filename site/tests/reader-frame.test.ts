import assert from "node:assert/strict";
import { test } from "node:test";
import { ReaderFrameCoordinator } from "../lib/reader-frame";

test("scroll, animation and observer requests share one ordered snapshot and paint", () => {
  let queued: FrameRequestCallback | undefined;
  let requests = 0;
  const coordinator = new ReaderFrameCoordinator(callback => { requests++; queued = callback; return requests; }, () => { queued = undefined; });
  const events: string[] = [];
  coordinator.subscribe("paint", () => { events.push("paint"); });
  coordinator.subscribe("advance", () => { events.push("cover"); coordinator.request(); }, 0);
  coordinator.subscribe("measure", () => { events.push("snapshot"); });
  coordinator.subscribe("advance", () => { events.push("controls"); }, 10);
  coordinator.request(); coordinator.request();
  assert.equal(requests, 1);
  queued!(100);
  assert.deepEqual(events, ["cover", "controls", "snapshot", "paint"]);
  assert.equal(requests, 1, "an advance-phase invalidation must not cause a second sampling pass");
  assert.equal(coordinator.inspect().frames, 1);
});

test("active animation schedules the next frame; disposed participants cannot paint", () => {
  let queued: FrameRequestCallback | undefined;
  let frames = 0, paints = 0, moving = true;
  const coordinator = new ReaderFrameCoordinator(callback => { queued = callback; return ++frames; }, () => { queued = undefined; });
  const stop = coordinator.subscribe("advance", () => moving);
  const stopPaint = coordinator.subscribe("paint", () => { paints++; });
  queued!(1);
  assert.equal(frames, 2);
  moving = false;
  stopPaint(); queued!(2);
  assert.equal(paints, 1);
  assert.equal(frames, 2);
  stop();
  assert.equal(coordinator.inspect().pending, false);
});
