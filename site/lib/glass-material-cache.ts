import { traceGlass, glassDiagnosticsEnabled } from "./glass-diagnostics";
import type { GlassAppearance, MaterialPlanes } from "./glass-lens";
import { mapScale, type MapGeometry } from "../vendor/glass-hq/src/gpu/geometry";
import type { MaterialBackend } from "../vendor/glass-hq/src/webgl2/index";
import { createMaterialEncoder, type MaterialEncoder } from "../vendor/glass-hq/src/dom/map-encoder";

export type GlassMaterialPriority = "urgent" | "next" | "warm";
const priorityValue = (priority: GlassMaterialPriority) => priority === "urgent" ? 0 : priority === "next" ? 1 : 2;
let requestSerial = 0;
export type GlassMaterialGeometry = MapGeometry & { resting?: boolean };

export type GlassMaterialCacheOptions = {
  onReady: () => void;
  onFailure: (error: Error) => void;
  maxEntries?: number;
  maxDecodedBytes?: number;
  maxTransitionBytes?: number;
  maxEncodedBytes?: number;
  maxEncodedTransitionBytes?: number;
  maxPending?: number;
  maxGpuPending?: number;
  maxEncodePending?: number;
  maxDecodePending?: number;
  maxPixelBytes?: number;
  /** Injectable resource boundaries for deterministic tests; production uses Image and a module Worker. */
  encoder?: MaterialEncoder;
  decodeImage?: (url: string) => Promise<HTMLImageElement>;
};
type Entry = {
  id: string; key: string; geometry: MapGeometry; appearance: GlassAppearance;
  state: "queued" | "gpu" | "encode-queued" | "encoding" | "decode-queued" | "decoding" | "ready" | "failed";
  pixels?: Uint8Array; width?: number; height?: number;
  priority: number; used: number; bytes: number; encodedBytes: number; encodedNeed: number; fresh?: boolean;
  maps?: MaterialPlanes; images?: HTMLImageElement[];
};
const activeEntry = (entry: Entry) => !["queued", "ready", "failed"].includes(entry.state);
const MiB = 1024 * 1024;
const deviceDpr = () => typeof devicePixelRatio === "number" && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;

/** Preserve explicit low-resolution motion waypoints and high-resolution rest
 * endpoints. The effective raster ratio, rather than a global constant, keys maps. */
export function glassMaterialGeometry(shape: GlassMaterialGeometry, appearance: GlassAppearance, staticDpr = deviceDpr()) {
  if (![shape.width, shape.height].every(Number.isFinite) || shape.width <= 0 || shape.height <= 0) {
    throw new RangeError("Glass material dimensions must be positive and finite");
  }
  const requested = shape.resting === true ? staticDpr : shape.dpr ?? staticDpr;
  const dpr = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 1, 2));
  const geometry = { ...shape, appearance, dpr };
  const effectiveDpr = mapScale(geometry);
  const width = Math.ceil((shape.width + 4) * effectiveDpr), height = Math.ceil((shape.height + 4) * effectiveDpr);
  return {
    geometry, width, height, effectiveDpr,
    key: JSON.stringify([shape.width, shape.height, shape.radius, effectiveDpr, appearance, shape.outline]),
    bytes: width * height * 2 * 4,
  };
}

/** Owns encoded/decoded resources, not the supplied renderer. Pin every map
 * actually drawn (including both crossfade maps) between beginFrame/endFrame.
 * Prior-frame pins remain protected until the current frame has finished. */
export function createGlassMaterialCache(renderer: MaterialBackend, options: GlassMaterialCacheOptions) {
  const encoder = options.encoder ?? createMaterialEncoder({ maxPending: Math.max(1, options.maxEncodePending ?? 1),
    maxPixelBytes: options.maxPixelBytes ?? options.maxDecodedBytes ?? 16 * MiB });
  const decode = options.decodeImage ?? (async (url: string) => {
    const image = new Image(); image.src = url; await image.decode(); return image;
  });
  const maxEntries = Math.max(1, options.maxEntries ?? 80);
  const maxDecodedBytes = Math.max(1, options.maxDecodedBytes ?? 16 * MiB);
  const maxTransitionBytes = Math.max(0, options.maxTransitionBytes ?? 16 * MiB);
  const maxEncodedBytes = Math.max(1, options.maxEncodedBytes ?? 16 * MiB);
  const maxEncodedTransitionBytes = Math.max(0, options.maxEncodedTransitionBytes ?? maxTransitionBytes);
  const maxGpu = Math.max(1, options.maxGpuPending ?? options.maxPending ?? 4);
  const maxEncode = Math.max(1, options.maxEncodePending ?? 1);
  const maxDecode = Math.max(1, options.maxDecodePending ?? 2);
  const maxPixelBytes = Math.max(1, options.maxPixelBytes ?? maxDecodedBytes);
  const entries = new Map<string, Entry>();
  const denied = new Set<string>();
  const byMaps = new WeakMap<MaterialPlanes, Entry>();
  let pinned = new Set<Entry>(), nextPinned = new Set<Entry>(), frameOpen = false;
  let disposed = false, clock = 0, gpuActive = 0, encodeActive = 0, decodeActive = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, scheduledPriority = 3;
  const counts = { hits: 0, misses: 0, generated: 0, evictions: 0, budgetDeferred: 0, untrackedPins: 0,
    renderMs: 0, encodeMs: 0, decodeMs: 0, failures: 0 };
  const protectedEntry = (entry: Entry) => pinned.has(entry) || nextPinned.has(entry) || Boolean(entry.fresh);
  const decodedBytes = () => [...entries.values()].reduce((sum, entry) => sum + (entry.state === "ready" ? entry.bytes : 0), 0);
  const reservedBytes = () => [...entries.values()].reduce((sum, entry) => sum + (activeEntry(entry) ? entry.bytes : 0), 0);
  const encodedBytes = () => [...entries.values()].reduce((sum, entry) => sum + entry.encodedBytes, 0);
  function evict(entry: Entry) {
    if (activeEntry(entry) || protectedEntry(entry)) return false;
    entries.delete(entry.key); entry.images = undefined; entry.encodedBytes = 0;
    counts.evictions++;
    return true;
  }
  function victim(priority: number, except?: Entry) {
    return [...entries.values()].filter(entry => entry !== except && !activeEntry(entry) && !protectedEntry(entry) && (priority <= entry.priority || priority === 0 || entry.state === "failed"))
      .sort((a, b) => (a.state === "failed" ? -1 : b.state === "failed" ? 1 : a.used - b.used))[0];
  }
  function room(bytes: number, except: Entry) {
    const limit = maxDecodedBytes + (except.priority === 0 ? maxTransitionBytes : 0);
    while (decodedBytes() + reservedBytes() + bytes > limit) {
      const entry = [...entries.values()].filter(candidate => candidate !== except && candidate.state === "ready" && !protectedEntry(candidate))
        .sort((a, b) => a.used - b.used)[0];
      if (!entry) return false;
      evict(entry);
    }
    return true;
  }
  function roomEncoded(bytes: number, except: Entry) {
    const limit = maxEncodedBytes + (except.priority === 0 ? maxEncodedTransitionBytes : 0);
    while (encodedBytes() - except.encodedBytes + bytes > limit) {
      const entry = [...entries.values()].filter(candidate => candidate !== except && candidate.state === "ready" && !protectedEntry(candidate))
        .sort((a, b) => a.used - b.used)[0];
      if (!entry) return false;
      evict(entry);
    }
    return true;
  }
  const pixelBytes = () => [...entries.values()].reduce((sum, entry) => sum +
    (["gpu", "encode-queued", "encoding"].includes(entry.state) ? entry.bytes : 0), 0);
  const emit = (entry: Entry, name: string, detail: Record<string, unknown> = {}, at = performance.now()) => {
    if (glassDiagnosticsEnabled()) traceGlass(name, { requestId: entry.id, priority: entry.priority, absoluteTime: performance.timeOrigin + at, ...detail }, at);
  };
  const requestOptions = (entry: Entry) => ({ requestId: entry.id, priority: entry.priority,
    ...(glassDiagnosticsEnabled() ? { trace: (name: string, detail: Record<string, unknown> = {}, at = performance.now()) => emit(entry, name, detail, at) } : {}) });
  function schedule(priority = 0) {
    if (disposed || ![...entries.values()].some(entry => ["queued", "encode-queued", "decode-queued"].includes(entry.state)) ||
        (timer !== undefined && scheduledPriority <= priority)) return;
    if (timer !== undefined) clearTimeout(timer);
    scheduledPriority = priority;
    timer = setTimeout(() => { timer = undefined; scheduledPriority = 3; pump(); }, priority === 2 ? 32 : 0);
  }
  function fail(entry: Entry, error: unknown) {
    if (disposed) return;
    entry.state = "failed"; entry.images = undefined; entry.pixels = undefined; entry.maps = undefined; entry.encodedBytes = 0;
    counts.failures++; emit(entry, "material-failed", { error: String(error) });
    options.onFailure(error instanceof Error ? error : new Error(String(error)));
  }
  async function render(entry: Entry) {
    entry.state = "gpu"; gpuActive++;
    const start = performance.now();
    emit(entry, "gpu-queue");
    try {
      const pixels = await renderer.render(entry.geometry, requestOptions(entry));
      counts.renderMs += performance.now() - start;
      if (disposed) return;
      if (pixels.width * pixels.height * 2 * 4 !== entry.bytes || pixels.pixels.byteLength !== entry.bytes) {
        throw new Error("Glass material readback dimensions do not match its geometry");
      }
      entry.pixels = pixels.pixels; entry.width = pixels.width; entry.height = pixels.height;
      entry.state = "encode-queued"; emit(entry, "encode-queue");
    } catch (error) { fail(entry, error); }
    finally { gpuActive--; if (!disposed) schedule(); }
  }
  async function encode(entry: Entry) {
    entry.state = "encoding"; encodeActive++;
    const start = performance.now();
    try {
      const planes = await encoder.encode(entry.pixels!, entry.width!, entry.height!, requestOptions(entry));
      counts.encodeMs += performance.now() - start;
      entry.pixels = undefined;
      if (disposed) return;
      const field = planes[0]?.[0], rim = planes[1]?.[0];
      if (!field || !rim) throw new Error("Glass material encoder did not return both planes");
      entry.encodedNeed = (field.length + rim.length) * 2;
      if (entry.encodedNeed > maxEncodedBytes) throw new Error(`Encoded glass material exceeds its ${maxEncodedBytes}-byte steady budget`);
      if (!roomEncoded(entry.encodedNeed, entry)) {
        entry.state = "queued"; entry.encodedBytes = 0; counts.budgetDeferred++;
        emit(entry, "material-budget-deferred", { stage: "encoded", bytes: entry.encodedNeed });
        return;
      }
      entry.encodedBytes = entry.encodedNeed; entry.maps = { field, rim };
      entry.state = "decode-queued"; emit(entry, "decode-queue");
    } catch (error) { fail(entry, error); }
    finally { entry.pixels = undefined; encodeActive--; if (!disposed) schedule(); }
  }
  async function decodeEntry(entry: Entry) {
    entry.state = "decoding"; decodeActive++;
    const start = performance.now(); emit(entry, "decode-start");
    try {
      const results = await Promise.allSettled([entry.maps!.field, entry.maps!.rim].map(decode));
      const rejected = results.find(result => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      const images = results.map(result => (result as PromiseFulfilledResult<HTMLImageElement>).value);
      counts.decodeMs += performance.now() - start;
      if (disposed) return;
      if (images.some(image => typeof image.naturalWidth === "number" &&
          (image.naturalWidth !== entry.width || image.naturalHeight !== entry.height))) throw new Error("Decoded glass map dimensions do not match its readback");
      entry.images = images; entry.state = "ready"; entry.fresh = true; entry.used = ++clock;
      byMaps.set(entry.maps!, entry); counts.generated++; emit(entry, "material-ready"); options.onReady();
    } catch (error) { fail(entry, error); }
    finally { emit(entry, "decode-end", { duration: performance.now() - start, state: disposed ? "cancelled" : entry.state }); decodeActive--; if (!disposed) schedule(); }
  }
  function pump() {
    if (disposed) return;
    const queued = [...entries.values()].sort((a, b) => a.priority - b.priority || a.used - b.used);
    for (const entry of queued) {
      if (entry.state === "decode-queued" && decodeActive < maxDecode) void decodeEntry(entry);
      else if (entry.state === "encode-queued" && encodeActive < maxEncode) void encode(entry);
      else if (entry.state === "queued" && gpuActive < maxGpu) {
        if (pixelBytes() + entry.bytes > maxPixelBytes || !room(entry.bytes, entry) || !roomEncoded(entry.encodedNeed, entry)) {
          counts.budgetDeferred++; continue;
        }
        void render(entry);
      }
    }
  }
  function request(shape: GlassMaterialGeometry, appearance: GlassAppearance, staticDpr: number, priority: number) {
    if (disposed) return;
    let resolved: ReturnType<typeof glassMaterialGeometry>;
    try { resolved = glassMaterialGeometry(shape, appearance, staticDpr); }
    catch (error) { options.onFailure(error instanceof Error ? error : new Error(String(error))); return; }
    const originalKey = resolved.key;
    if (denied.has(originalKey)) return;
    while (resolved.bytes > Math.min(maxDecodedBytes, maxPixelBytes) && resolved.geometry.dpr > 1) {
      resolved = glassMaterialGeometry({ ...shape, resting: false, dpr: Math.max(1, resolved.geometry.dpr - .5) }, appearance, staticDpr);
    }
    if (resolved.bytes > Math.min(maxDecodedBytes, maxPixelBytes)) {
      if (denied.size >= maxEntries) denied.delete(denied.values().next().value!);
      denied.add(originalKey); counts.failures++;
      options.onFailure(new Error(`Glass material exceeds its ${maxDecodedBytes}-byte steady budget even at 1x`));
      return;
    }
    const existing = entries.get(resolved.key);
    if (existing) {
      counts.hits++; existing.used = ++clock;
      if (priority < existing.priority) { existing.priority = priority; emit(existing, "material-priority"); schedule(priority); }
      return existing.state === "ready" ? existing.maps : undefined;
    }
    counts.misses++;
    while (entries.size >= maxEntries) {
      const candidate = victim(priority);
      if (!candidate || !evict(candidate)) { counts.budgetDeferred++; return; }
    }
    const entry: Entry = { id: `glass-material-${++requestSerial}`, key: resolved.key, geometry: resolved.geometry, appearance, state: "queued", priority,
      used: ++clock, bytes: resolved.bytes, encodedBytes: 0, encodedNeed: 0 };
    entries.set(resolved.key, entry);
    emit(entry, "material-queue", { width: resolved.width, height: resolved.height, bytes: entry.bytes });
    schedule(priority);
  }
  return {
    get: (shape: GlassMaterialGeometry, appearance: GlassAppearance, staticDpr = deviceDpr(), priority: GlassMaterialPriority = "urgent"): MaterialPlanes | undefined => request(shape, appearance, staticDpr, priorityValue(priority)),
    beginFrame() {
      frameOpen = true; nextPinned = new Set();
      // Demand is frame-local. A departed waypoint must not remain urgent and
      // outrank the two maps actually requested by the next paint.
      for (const entry of entries.values()) if (["queued", "encode-queued", "decode-queued"].includes(entry.state)) entry.priority = 2;
    },
    pin(maps: MaterialPlanes | undefined) {
      if (!maps || disposed) return;
      const entry = byMaps.get(maps);
      if (!entry || entries.get(entry.key) !== entry) { counts.untrackedPins++; return; }
      (frameOpen ? nextPinned : pinned).add(entry); entry.used = ++clock;
    },
    endFrame() {
      if (frameOpen) { pinned = nextPinned; nextPinned = new Set(); frameOpen = false; }
      for (const entry of entries.values()) entry.fresh = false;
      // Transition headroom is temporary: release old light/dark or morph maps
      // as soon as the new frame stops pinning them.
      while (decodedBytes() + reservedBytes() > maxDecodedBytes || encodedBytes() > maxEncodedBytes) {
        const entry = [...entries.values()].filter(candidate => candidate.state === "ready" && !protectedEntry(candidate))
          .sort((a, b) => a.used - b.used)[0];
        if (!entry) break;
        evict(entry);
      }
      schedule();
    },
    prewarm(shapes: readonly GlassMaterialGeometry[], appearance: GlassAppearance, dpr = deviceDpr(), priority: GlassMaterialPriority = "warm") {
      for (const shape of shapes) request(shape, appearance, dpr, priorityValue(priority));
    },
    diagnostics() {
      const all = [...entries.values()];
      return { ...counts, queued: all.filter(entry => entry.state === "queued").length, inFlight: gpuActive + encodeActive + decodeActive,
        gpuActive, encodeActive, decodeActive, encodeQueued: all.filter(entry => entry.state === "encode-queued").length,
        decodeQueued: all.filter(entry => entry.state === "decode-queued").length, pixelBytes: pixelBytes(), maxPixelBytes,
        maxGpuPending: maxGpu, maxEncodePending: maxEncode, maxDecodePending: maxDecode,
        readyEntries: all.filter(entry => entry.state === "ready").length, entries: entries.size,
        decodedBytes: decodedBytes(), reservedBytes: reservedBytes(), encodedBytes: encodedBytes(),
        transitionBytes: Math.max(0, decodedBytes() + reservedBytes() - maxDecodedBytes), maxDecodedBytes, maxTransitionBytes,
        encodedTransitionBytes: Math.max(0, encodedBytes() - maxEncodedBytes), maxEncodedBytes, maxEncodedTransitionBytes,
        pinnedEntries: new Set([...pinned, ...nextPinned]).size, encodingMode: encoder.mode() };
    },
    dispose() {
      if (disposed) return;
      disposed = true; if (timer !== undefined) clearTimeout(timer);
      encoder.dispose();
      for (const entry of entries.values()) { emit(entry, "material-cancel"); entry.images = undefined; entry.pixels = undefined; entry.maps = undefined; }
      entries.clear(); denied.clear(); pinned.clear(); nextPinned.clear();
    },
  };
}
