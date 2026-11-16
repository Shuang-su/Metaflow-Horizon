import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeMapPixels, encodeMapPixelsYielding } from "../vendor/glass-hq/src/dom/map-encoding";
import { createMaterialEncoder } from "../vendor/glass-hq/src/dom/map-encoder";

function pixels(width: number, height: number) {
  return Uint8Array.from({ length: width * height * 8 }, (_, index) => (index * 37 + (index >> 3)) % 256);
}
test("cooperative fallback preserves exactly the same lossless PNG planes and yields between batches", async () => {
  const data = pixels(48, 96);
  let yielded = 0;
  const expected = await encodeMapPixels(data, 48, 96);
  const actual = await encodeMapPixelsYielding(data, 48, 96, async () => { yielded++; });
  assert.deepEqual(actual, expected);
  assert.ok(yielded >= 12);
});

test("worker startup failure preserves input bytes and serializes fallback jobs", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: class { constructor() { throw new Error("CSP blocked worker"); } } });
  try {
    const encoder = createMaterialEncoder();
    const data = pixels(8, 8), original = data.slice();
    const expected = await encodeMapPixels(data, 8, 8);
    const order: number[] = [];
    const [first, second] = await Promise.all([
      encoder.encode(data, 8, 8).then(result => { order.push(1); return result; }),
      encoder.encode(data, 8, 8).then(result => { order.push(2); return result; }),
    ]);
    assert.deepEqual(first, expected); assert.deepEqual(second, expected);
    assert.deepEqual(order, [1, 2]); assert.deepEqual(data, original);
    assert.equal(encoder.mode(), "fallback");
    encoder.dispose();
    await assert.rejects(encoder.encode(data, 8, 8), /disposed/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "Worker", descriptor); else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("module worker request uses the Next URL pattern and returns its result without detaching pixels", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  let terminated = 0;
  class FixtureWorker {
    onmessage?: (event: { data: { id: number; planes: string[][] } }) => void;
    onerror: unknown; onmessageerror: unknown;
    constructor(url: URL, options: WorkerOptions) { assert.match(url.pathname, /map-encoder\.worker\.js$/); assert.equal(options.type, "module"); }
    postMessage(data: { id: number; pixels: Uint8Array }) {
      assert.ok(data.pixels.byteLength > 0);
      queueMicrotask(() => this.onmessage?.({ data: { id: data.id, planes: [["field"], ["rim"]] } }));
    }
    terminate() { terminated++; }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FixtureWorker });
  try {
    const encoder = createMaterialEncoder(), data = pixels(4, 4);
    assert.deepEqual(await encoder.encode(data, 4, 4), [["field"], ["rim"]]);
    assert.equal(data.byteLength, 4 * 4 * 8);
    assert.equal(encoder.mode(), "worker");
    encoder.dispose(); assert.equal(terminated, 1);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "Worker", descriptor); else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("fallback stays byte-identical and yields even without CompressionStream", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "CompressionStream");
  Object.defineProperty(globalThis, "CompressionStream", { configurable: true, value: undefined });
  try {
    const data = pixels(256, 96);
    const expected = await encodeMapPixels(data, 256, 96);
    let yielded = 0;
    const actual = await encodeMapPixelsYielding(data, 256, 96, async () => { yielded++; });
    assert.deepEqual(actual, expected);
    assert.ok(yielded > 30);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "CompressionStream", descriptor); else Reflect.deleteProperty(globalThis, "CompressionStream");
  }
});

test("the shipped self-contained worker asset executes in a separate thread and matches PNG output", async () => {
  const { Worker: Thread } = await import("node:worker_threads");
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../vendor/glass-hq/src/dom/map-encoder.worker.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import\s/m, "static asset cannot depend on unresolved TS imports");
  const worker = new Thread(`const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = message => parentPort.postMessage(message);
    parentPort.on('message', data => globalThis.onmessage({data}));\n${source}`, { eval: true });
  try {
    const data = pixels(32, 48);
    const expected = await encodeMapPixels(data, 32, 48);
    const result = await new Promise<{ id: number; planes: string[][] }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker result timeout")), 5000);
      worker.once("error", error => { clearTimeout(timer); reject(error); });
      worker.once("message", message => { clearTimeout(timer); resolve(message); });
      worker.postMessage({ id: 7, pixels: data, width: 32, height: 48 });
    });
    assert.equal(result.id, 7);
    assert.deepEqual(result.planes, expected);
  } finally { await worker.terminate(); }
});


test("the committed worker exactly matches the current TS dependency bundle without rewriting it", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const { readFile, stat } = await import("node:fs/promises");
  const artifact = new URL("../vendor/glass-hq/src/dom/map-encoder.worker.js", import.meta.url);
  const script = new URL("../vendor/glass-hq/scripts/bundle-material-worker.mjs", import.meta.url);
  const before = await readFile(artifact), metadata = await stat(artifact);
  await promisify(execFile)(process.execPath, [fileURLToPath(script), "--check"]);
  assert.deepEqual(await readFile(artifact), before);
  assert.equal((await stat(artifact)).mtimeMs, metadata.mtimeMs, "check mode must not rewrite the worker");
});
