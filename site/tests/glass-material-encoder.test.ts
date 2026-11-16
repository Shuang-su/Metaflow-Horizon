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
      worker.on("message", message => { if (message.id === 7 && message.planes) { clearTimeout(timer); resolve(message); } });
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

test("encoder starts no worker until cold demand and bounds/priority-orders its retained requests", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  let constructed = 0;
  const sent: { id: number; width: number; finish: () => void }[] = [];
  class FixtureWorker {
    onmessage?: (event: { data: { id?: number; type?: "ready"; absoluteAt?: number; planes?: string[][] } }) => void;
    onerror: unknown; onmessageerror: unknown;
    constructor() { constructed++; queueMicrotask(() => this.onmessage?.({ data: { type: "ready", absoluteAt: performance.timeOrigin + performance.now() } })); }
    postMessage(data: { id: number; width: number }) { sent.push({ ...data, finish: () => this.onmessage?.({ data: { id: data.id, planes: [["field"], ["rim"]] } }) }); }
    terminate() {}
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FixtureWorker });
  try {
    const trace: { name: string; requestId: unknown; absolute: unknown }[] = [];
    const encoder = createMaterialEncoder({ maxPending: 3, maxPixelBytes: 3 * 4 * 4 * 8,
      trace: (name, detail) => trace.push({ name, requestId: detail?.requestId, absolute: detail?.absoluteTime }) });
    assert.equal(encoder.mode(), "idle"); assert.equal(constructed, 0);
    const first = encoder.encode(pixels(4, 4), 4, 4, { requestId: "cold", priority: 2 });
    await new Promise<void>(resolve => queueMicrotask(resolve));
    assert.equal(constructed, 1);
    const warm = encoder.encode(pixels(4, 4), 5, 4, { requestId: "warm", priority: 2 });
    const urgent = encoder.encode(pixels(4, 4), 6, 4, { requestId: "urgent", priority: 0 });
    await assert.rejects(encoder.encode(pixels(4, 4), 7, 4), /bounded queue/);
    sent[0].finish(); await first;
    await new Promise<void>(resolve => queueMicrotask(resolve));
    assert.equal(sent[1].width, 6);
    sent[1].finish(); await urgent;
    await new Promise<void>(resolve => queueMicrotask(resolve));
    assert.equal(sent[2].width, 5);
    sent[2].finish(); await warm;
    assert.ok(trace.some(event => event.name === "encode-worker-spawn" && event.requestId === "cold"));
    assert.ok(trace.some(event => event.name === "encode-worker-ready" && event.requestId === "cold"));
    assert.ok(trace.every(event => typeof event.absolute === "number" && event.absolute > 1_000_000_000_000));
    encoder.dispose();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "Worker", descriptor); else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("dispose rejects both active worker demand and queued encodes", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: class { postMessage() {} terminate() {} } });
  try {
    const encoder = createMaterialEncoder();
    const active = encoder.encode(pixels(4, 4), 4, 4);
    await new Promise<void>(resolve => queueMicrotask(resolve));
    const queued = encoder.encode(pixels(4, 4), 4, 4);
    const rejected = Promise.all([assert.rejects(active, /disposed/), assert.rejects(queued, /disposed/)]);
    encoder.dispose(); await rejected;
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "Worker", descriptor); else Reflect.deleteProperty(globalThis, "Worker");
  }
});
