import type { GlassAppearance, MaterialPlanes } from "./glass-lens";
import { mapScale, type MapGeometry } from "../vendor/glass-hq/src/gpu/geometry";
import type { MaterialBackend } from "../vendor/glass-hq/src/webgl2/index";
import { createMaterialEncoder, type MaterialEncoder } from "../vendor/glass-hq/src/dom/map-encoder";

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
  /** Injectable resource boundaries for deterministic tests; production uses Image and a module Worker. */
  encoder?: MaterialEncoder;
  decodeImage?: (url: string) => Promise<HTMLImageElement>;
};
type Entry = {
  key: string; geometry: MapGeometry; appearance: GlassAppearance;
  state: "queued" | "running" | "ready" | "failed";
  priority: number; used: number; bytes: number; encodedBytes: number; encodedNeed: number; fresh?: boolean;
  maps?: MaterialPlanes; images?: HTMLImageElement[];
};
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
  const encoder = options.encoder ?? createMaterialEncoder();
  const decode = options.decodeImage ?? (async (url: string) => {
    const image = new Image(); image.src = url; await image.decode(); return image;
  });
  const maxEntries = Math.max(1, options.maxEntries ?? 80);
  const maxDecodedBytes = Math.max(1, options.maxDecodedBytes ?? 16 * MiB);
  const maxTransitionBytes = Math.max(0, options.maxTransitionBytes ?? 16 * MiB);
  const maxEncodedBytes = Math.max(1, options.maxEncodedBytes ?? 16 * MiB);
  const maxEncodedTransitionBytes = Math.max(0, options.maxEncodedTransitionBytes ?? maxTransitionBytes);
  const maxPending = Math.max(1, options.maxPending ?? 4);
  const entries = new Map<string, Entry>();
  const denied = new Set<string>();
  const byMaps = new WeakMap<MaterialPlanes, Entry>();
  let pinned = new Set<Entry>(), nextPinned = new Set<Entry>(), frameOpen = false;
  let disposed = false, clock = 0, inFlight = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, scheduledPriority = 2;
  const counts = { hits: 0, misses: 0, generated: 0, evictions: 0, budgetDeferred: 0, untrackedPins: 0,
    renderMs: 0, encodeMs: 0, decodeMs: 0, failures: 0 };
  const protectedEntry = (entry: Entry) => pinned.has(entry) || nextPinned.has(entry) || Boolean(entry.fresh);
  const decodedBytes = () => [...entries.values()].reduce((sum, entry) => sum + (entry.state === "ready" ? entry.bytes : 0), 0);
  const reservedBytes = () => [...entries.values()].reduce((sum, entry) => sum + (entry.state === "running" ? entry.bytes : 0), 0);
  const encodedBytes = () => [...entries.values()].reduce((sum, entry) => sum + entry.encodedBytes, 0);
  function evict(entry: Entry) {
    if (entry.state === "running" || protectedEntry(entry)) return false;
    entries.delete(entry.key); entry.images = undefined; entry.encodedBytes = 0;
    counts.evictions++;
    return true;
  }
  function victim(priority: number, except?: Entry) {
    return [...entries.values()].filter(entry => entry !== except && entry.state !== "running" && !protectedEntry(entry) && (priority === 0 || entry.priority === 1 || entry.state === "failed"))
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
  function schedule(priority = 0) {
    if (disposed || ![...entries.values()].some(entry => entry.state === "queued") ||
        (timer !== undefined && scheduledPriority <= priority)) return;
    if (timer !== undefined) clearTimeout(timer);
    scheduledPriority = priority;
    timer = setTimeout(() => { timer = undefined; scheduledPriority = 2; pump(); }, priority ? 32 : 0);
  }
  async function produce(entry: Entry) {
    entry.state = "running"; inFlight++;
    try {
      let start = performance.now();
      const pixels = await renderer.render(entry.geometry);
      counts.renderMs += performance.now() - start;
      if (disposed) return;
      // The backend contract matches mapScale; reject a corrupt result before
      // allocating/decoding an unexpectedly large or incomplete resource.
      if (pixels.width * pixels.height * 2 * 4 !== entry.bytes || pixels.pixels.byteLength < entry.bytes) {
        throw new Error("Glass material readback dimensions do not match its geometry");
      }
      start = performance.now();
      const planes = await encoder.encode(pixels.pixels, pixels.width, pixels.height);
      counts.encodeMs += performance.now() - start;
      if (disposed) return;
      const field = planes[0]?.[0], rim = planes[1]?.[0];
      if (!field || !rim) throw new Error("Glass material encoder did not return both planes");
      entry.encodedNeed = (field.length + rim.length) * 2;
      if (entry.encodedNeed > maxEncodedBytes) {
        throw new Error(`Encoded glass material exceeds its ${maxEncodedBytes}-byte steady budget`);
      }
      if (!roomEncoded(entry.encodedNeed, entry)) {
        // Remember the actual requirement so a blocked job does not repeatedly
        // render/encode while active maps still occupy the budget.
        entry.state = "queued";
        entry.encodedBytes = 0; counts.budgetDeferred++; return;
      }
      entry.encodedBytes = entry.encodedNeed;
      start = performance.now();
      const images = await Promise.all([field, rim].map(decode));
      counts.decodeMs += performance.now() - start;
      if (disposed) return;
      if (images.some(image => typeof image.naturalWidth === "number" &&
          (image.naturalWidth !== pixels.width || image.naturalHeight !== pixels.height))) {
        throw new Error("Decoded glass map dimensions do not match its readback");
      }
      entry.images = images;
      entry.maps = { field, rim };
      entry.state = "ready";
      entry.fresh = true; // Deliver to the next paint before speculative work can evict it.
      entry.used = ++clock;
      byMaps.set(entry.maps, entry);
      counts.generated++;
      options.onReady();
    } catch (error) {
      if (!disposed) {
        entry.state = "failed"; entry.images = undefined; entry.encodedBytes = 0;
        counts.failures++;
        options.onFailure(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      inFlight--;
      if (!disposed) schedule();
    }
  }
  function pump() {
    if (disposed) return;
    const queued = [...entries.values()].filter(entry => entry.state === "queued")
      .sort((a, b) => a.priority - b.priority || a.used - b.used);
    for (const entry of queued) {
      if (inFlight >= maxPending) break;
      if (!room(entry.bytes, entry) || !roomEncoded(entry.encodedNeed, entry)) { counts.budgetDeferred++; continue; }
      void produce(entry);
    }
  }
  function request(shape: GlassMaterialGeometry, appearance: GlassAppearance, staticDpr: number, priority: number) {
    if (disposed) return;
    let resolved: ReturnType<typeof glassMaterialGeometry>;
    try { resolved = glassMaterialGeometry(shape, appearance, staticDpr); }
    catch (error) { options.onFailure(error instanceof Error ? error : new Error(String(error))); return; }
    const originalKey = resolved.key;
    if (denied.has(originalKey)) return;
    while (resolved.bytes > maxDecodedBytes && resolved.geometry.dpr > 1) {
      resolved = glassMaterialGeometry({ ...shape, resting: false, dpr: Math.max(1, resolved.geometry.dpr - .5) }, appearance, staticDpr);
    }
    if (resolved.bytes > maxDecodedBytes) {
      if (denied.size >= maxEntries) denied.delete(denied.values().next().value!);
      denied.add(originalKey); counts.failures++;
      options.onFailure(new Error(`Glass material exceeds its ${maxDecodedBytes}-byte steady budget even at 1x`));
      return;
    }
    const existing = entries.get(resolved.key);
    if (existing) {
      counts.hits++; existing.used = ++clock;
      if (priority < existing.priority) { existing.priority = priority; if (existing.state === "queued") schedule(priority); }
      return existing.state === "ready" ? existing.maps : undefined;
    }
    counts.misses++;
    while (entries.size >= maxEntries) {
      const candidate = victim(priority);
      if (!candidate || !evict(candidate)) { counts.budgetDeferred++; return; }
    }
    entries.set(resolved.key, { key: resolved.key, geometry: resolved.geometry, appearance, state: "queued", priority,
      used: ++clock, bytes: resolved.bytes, encodedBytes: 0, encodedNeed: 0 });
    schedule(priority);
  }
  return {
    get: (shape: GlassMaterialGeometry, appearance: GlassAppearance, staticDpr = deviceDpr()): MaterialPlanes | undefined => request(shape, appearance, staticDpr, 0),
    beginFrame() { frameOpen = true; nextPinned = new Set(); },
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
    prewarm(shapes: readonly GlassMaterialGeometry[], appearance: GlassAppearance, dpr = deviceDpr()) {
      for (const shape of shapes) request(shape, appearance, dpr, 1);
    },
    diagnostics() {
      const all = [...entries.values()];
      return { ...counts, queued: all.filter(entry => entry.state === "queued").length, inFlight,
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
      for (const entry of entries.values()) entry.images = undefined;
      entries.clear(); denied.clear(); pinned.clear(); nextPinned.clear();
    },
  };
}
