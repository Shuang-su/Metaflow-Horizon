import { OpticalSource, type OpticalBox, type OpticalFrameSnapshot } from "./glass-optical-source";
import { getLayoutSize } from "../vendor/lisse-core/index.js";
import type { LensPlacement } from "../vendor/glass-hq/src/dom/morph";
import type { MapGeometry } from "../vendor/glass-hq/src/gpu/geometry";
import { shapePolygon } from "../vendor/glass-hq/src/core/shape";
import type { ShapePoint } from "../vendor/glass-hq/src/core/concentric";
import { webkit } from "../vendor/glass-hq/src/dom/engine";

export type LensKind = "chrome" | "toolbar" | "slider" | "menu";
export type GlassAppearance = NonNullable<MapGeometry["appearance"]>;
export type MaterialPlanes = { field: string; rim: string };
export type LensLayer = { placement: LensPlacement; maps: MaterialPlanes };
/** Viewport position of the host's absolute containing-block origin and its
 * positive axis-aligned CSS scale. Capture once in the measure phase. */
export type LensHostTransform = Readonly<{ left: number; top: number; scaleX: number; scaleY: number }>;
export const IDENTITY_LENS_HOST: LensHostTransform = Object.freeze({ left: 0, top: 0, scaleX: 1, scaleY: 1 });

export function measureLensHostTransform(host: HTMLElement): LensHostTransform {
  const rect = host.getBoundingClientRect();
  const style = getComputedStyle(host);
  const size = getLayoutSize(host, style);
  const scaleX = rect.width / size.width, scaleY = rect.height / size.height;
  // Absolute descendants are positioned from the padding edge, inside borders.
  const left = rect.left + (parseFloat(style.borderLeftWidth) || 0) * scaleX - host.scrollLeft * scaleX;
  const top = rect.top + (parseFloat(style.borderTopWidth) || 0) * scaleY - host.scrollTop * scaleY;
  const transform = { left, top, scaleX, scaleY };
  validateHostTransform(transform);
  return transform;
}

function validateHostTransform(host: LensHostTransform) {
  if (![host.left, host.top, host.scaleX, host.scaleY].every(Number.isFinite) || host.scaleX <= 0 || host.scaleY <= 0)
    throw new RangeError("Invalid glass host transform");
}

/** Keep the entire optical plane in viewport CSS pixels, then cancel the
 * host's scale once. The parent's transform moves material and glyphs together. */
export function lensHostPlacement(region: OpticalBox, host: LensHostTransform) {
  validateHostTransform(host);
  return { left: (region.left - host.left) / host.scaleX, top: (region.top - host.top) / host.scaleY,
    width: region.width, height: region.height, scaleX: 1 / host.scaleX, scaleY: 1 / host.scaleY };
}

const namespace = "http://www.w3.org/2000/svg";
const reach = 26;
// The original rim shader shades up to about one CSS pixel outside d=0.
const rimReach = 1.5;
let serial = 0;
const outlines = new Map<string, ShapePoint[]>();
const clipPaths = new Map<string, string>();
const outlineIds = new WeakMap<ShapePoint[], number>();
let outlineSerial = 0;

/** Exactly the padded region consumed by paint, shared with the read phase. */
export function lensOpticalRegion(a: LensPlacement, b: LensPlacement): OpticalBox {
  const left = Math.min(a.left, b.left), top = Math.min(a.top, b.top);
  const right = Math.max(a.left + a.width, b.left + b.width), bottom = Math.max(a.top + a.height, b.top + b.height);
  return { left: left - reach, top: top - reach, width: right - left + reach * 2, height: bottom - top + reach * 2 };
}

function localClipKey(item: LensPlacement, region: OpticalBox) {
  const outline = item.shape.outline;
  if (outline && !outlineIds.has(outline)) outlineIds.set(outline, ++outlineSerial);
  // Prepared outlines are immutable. Absolute screen translation is excluded;
  // subpixel rounding only absorbs floating-point subtraction noise.
  return [item.left - region.left, item.top - region.top, item.width, item.height].map(value => value.toFixed(6)).join("|") +
    `|${item.shape.width}|${item.shape.height}|${item.shape.radius}|${outline ? outlineIds.get(outline) : "rounded"}`;
}

function placementOutline(item: LensPlacement, region: OpticalBox): ShapePoint[] {
  if (![item.left, item.top, item.width, item.height, item.shape.width, item.shape.height].every(Number.isFinite)
      || item.width <= 0 || item.height <= 0 || item.shape.width <= 0 || item.shape.height <= 0) {
    throw new RangeError("Invalid glass clip geometry");
  }
  const shape = item.shape;
  const key = `${shape.width}|${shape.height}|${shape.radius}`;
  let points = shape.outline || outlines.get(key);
  if (!points) {
    points = shapePolygon(shape.width, shape.height, shape.radius);
    if (outlines.size >= 80) outlines.delete(outlines.keys().next().value!);
    outlines.set(key, points);
  }
  if (points.length < 3 || points.some(point => !point.every(Number.isFinite))) throw new RangeError("Invalid glass clip outline");
  const local = points.map(([x, y]): ShapePoint => [
    item.left - region.left + x * item.width / shape.width,
    item.top - region.top + y * item.height / shape.height,
  ]);
  // Same winding makes overlapping blend contours a union under nonzero fill.
  const area = local.reduce((sum, point, index) => {
    const next = local[(index + 1) % local.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0);
  if (area < 0) local.reverse();
  // Close duplicates are omitted before offsetting; an outward parallel edge
  // keeps the shader's antialias/side rim without opening the sample rectangle.
  const clean = local.filter((point, index) => {
    const previous = local[(index + local.length - 1) % local.length];
    return Math.hypot(point[0] - previous[0], point[1] - previous[1]) > .00001;
  });
  if (clean.length < 3) throw new RangeError("Degenerate glass clip outline");
  return clean.map((point, index): ShapePoint => {
    const before = clean[(index + clean.length - 1) % clean.length], after = clean[(index + 1) % clean.length];
    const previousLength = Math.hypot(point[0] - before[0], point[1] - before[1]);
    const nextLength = Math.hypot(after[0] - point[0], after[1] - point[1]);
    const a = [(point[1] - before[1]) / previousLength, (before[0] - point[0]) / previousLength];
    const b = [(after[1] - point[1]) / nextLength, (point[0] - after[0]) / nextLength];
    const factor = Math.min(rimReach / Math.max(.05, 1 + a[0] * b[0] + a[1] * b[1]), rimReach * 2);
    return [point[0] + (a[0] + b[0]) * factor, point[1] + (a[1] + b[1]) * factor];
  });
}

/** The outer HTML clip is independent of the SVG filter's field/alpha.
 * Connecting closed, same-winding loops with a retraced bridge preserves the
 * union, including a traced Gooey neck and a narrow original-rim allowance,
 * without exposing their bounding box. */
export function lensClipOutline(a: LensPlacement, b: LensPlacement, mix: number, region: OpticalBox): ShapePoint[] {
  if (![region.left, region.top, region.width, region.height, mix].every(Number.isFinite) || region.width <= 0 || region.height <= 0) {
    throw new RangeError("Invalid glass clip region");
  }
  const placements = mix <= 0 || a === b ? [a] : mix >= 1 ? [b] : [a, b];
  const loops = placements.map(item => placementOutline(item, region));
  const first = loops[0][0];
  return loops.flatMap(loop => [...loop, loop[0], first]);
}
export function lensClipPath(a: LensPlacement, b: LensPlacement, mix: number, region: OpticalBox) {
  if (![region.left, region.top, region.width, region.height, mix].every(Number.isFinite) || region.width <= 0 || region.height <= 0) {
    throw new RangeError("Invalid glass clip region");
  }
  const placements = mix <= 0 || a === b ? [a] : mix >= 1 ? [b] : [a, b];
  const key = placements.map(item => localClipKey(item, region)).join(";");
  const cached = clipPaths.get(key);
  if (cached !== undefined) return cached;
  const points = lensClipOutline(a, b, mix, region);
  const path = `polygon(nonzero, ${points.map(([x, y]) => `${x.toFixed(3)}px ${y.toFixed(3)}px`).join(",")})`;
  if (clipPaths.size >= 160) clipPaths.delete(clipPaths.keys().next().value!);
  clipPaths.set(key, path);
  return path;
}

function svg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>) {
  const element = document.createElementNS(namespace, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function attribute(node: Element, name: string, value: string | number) {
  const next = String(value);
  if (node.getAttribute(name) !== next) node.setAttribute(name, next);
}

/** Both prepared shapes feed the same filter. Blending the fields before
 * displacement keeps the outline, light and background in a single paint. */
export function createGlassLens(host: HTMLElement, kind: LensKind, onFailure: () => void = () => {}, profile?: "more") {
  const id = `reader-glass-${++serial}`;
  const strip = document.createElement("div");
  strip.className = "glass-optical-strip";
  strip.dataset.glassLens = kind;
  if (profile) strip.dataset.glassProfile = profile;
  strip.style.visibility = "hidden";
  const plane = document.createElement("div");
  plane.className = "glass-optical-plane";
  // HTML remains in the HTML rendering tree. In particular, positioned and
  // filtered source replicas must never cross a foreignObject paint boundary.
  const svgHost = svg("svg", { width: 0, height: 0, "aria-hidden": "true" });
  svgHost.classList.add("glass-optical-definitions");
  strip.append(plane);
  plane.style.filter = `url("#${id}")`;
  let broken = false, disposed = false;
  const resourceError = () => {
    if (broken || disposed) return;
    broken = true;
    delete strip.dataset.glassPrepared;
    strip.style.visibility = "hidden";
    onFailure();
  };
  const filter = svg("filter", { id, x: 0, y: 0, width: 1, height: 1,
    filterUnits: "objectBoundingBox", primitiveUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB" });

  function pair(name: "field" | "rim") {
    const a = svg("feImage", { result: name + "A", preserveAspectRatio: "none" });
    const b = svg("feImage", { result: name + "B", preserveAspectRatio: "none" });
    const blend = svg("feComposite", { in: name + "A", in2: name + "B", operator: "arithmetic", k1: 0, k2: 1, k3: 0, k4: 0, result: name });
    a.addEventListener("error", resourceError);
    b.addEventListener("error", resourceError);
    filter.append(a, b, blend);
    return { a, b, blend };
  }
  const field = pair("field");
  const rim = pair("rim");
  // Optical preblur softens the background's small text; it does not blur the
  // DPR-aware rim or change Glass-HQ's field/contour sampling.
  const blur = kind === "slider" ? .35 : kind === "menu" ? 6 : kind === "toolbar" ? 1.8 : 1.35;
  const refraction = kind === "slider" ? 10 : kind === "menu" ? 22 : kind === "toolbar" ? 26 : 32;
  const displacement = svg("feDisplacementMap", { in: "soft", in2: "field", scale: refraction,
    xChannelSelector: "R", yChannelSelector: "G", result: "refracted" });
  const merge = svg("feMerge", {});
  filter.append(
    svg("feGaussianBlur", { in: "SourceGraphic", stdDeviation: blur, result: "soft" }),
    displacement,
    svg("feComposite", { in: "refracted", in2: "field", operator: "in", result: "inside" }),
  );
  merge.append(svg("feMergeNode", { in: "inside" }));
  if (kind !== "slider") {
    // Fill, refraction and rim share the same field coverage and opacity.
    // Ready controls must not add a second DOM-painted disc or capsule.
    filter.append(svg("feFlood", { class: `glass-${kind}-tint${profile === "more" ? " glass-more-tint" : ""}`, result: "tint" }),
      svg("feComposite", { in: "tint", in2: "field", operator: "in", result: "tinted" }));
    merge.append(svg("feMergeNode", { in: "tinted" }));
  }
  // Retain the original highlight shape and sharpness, but avoid turning the
  // long capsule's upper/lower reflections into a bright wire outline.
  const rimGain = kind === "toolbar" ? .8 : kind === "menu" ? .85 : 1;
  const rimLight = svg("feComponentTransfer", { in: "rim", result: "rimLight" });
  rimLight.append(svg("feFuncA", { type: "linear", slope: rimGain }));
  filter.append(rimLight);
  merge.append(svg("feMergeNode", { in: "rimLight" }));
  filter.append(merge);
  const defs = svg("defs", {});
  defs.append(filter);
  svgHost.append(defs);
  host.append(svgHost, strip);
  const source = new OpticalSource(plane);
  let lastBox = "";
  let mapA: MaterialPlanes | undefined;
  let mapB: MaterialPlanes | undefined;

  function position(bounds: OpticalBox, hostTransform: LensHostTransform) {
    const placement = lensHostPlacement(bounds, hostTransform);
    const { left, top, scaleX, scaleY } = placement;
    const key = `${left}|${top}|${bounds.width}|${bounds.height}|${scaleX}|${scaleY}`;
    if (key !== lastBox) {
      lastBox = key;
      const values = { left: `${left}px`, top: `${top}px`, width: `${bounds.width}px`, height: `${bounds.height}px`,
        transformOrigin: "0 0", transform: `scale(${scaleX}, ${scaleY})` };
      for (const [key, value] of Object.entries(values)) {
        const property = key as keyof typeof values;
        if (strip.style[property] !== value) strip.style[property] = value;
      }
    }
    return bounds;
  }

  function place(node: SVGFEImageElement, url: string, item: LensPlacement, region: OpticalBox) {
    attribute(node, "href", url);
    attribute(node, "x", item.left - region.left - 2);
    attribute(node, "y", item.top - region.top - 2);
    attribute(node, "width", item.width + 4);
    attribute(node, "height", item.height + 4);
  }

  return {
    source,
    hide() { if (strip.style.visibility !== "hidden") strip.style.visibility = "hidden"; },
    paint(a: LensLayer, b: LensLayer, mix: number, roots: HTMLElement[], opacity: number, refresh: boolean, glow: number, snapshot?: OpticalFrameSnapshot, hostTransform: LensHostTransform = IDENTITY_LENS_HOST) {
      if (broken || disposed) throw new Error("Glass lens is unavailable");
      if (![mix, opacity, glow].every(Number.isFinite) || !a.maps.field || !a.maps.rim || !b.maps.field || !b.maps.rim) {
        throw new Error("Glass lens resources are unavailable");
      }
      const region = lensOpticalRegion(a.placement, b.placement);
      const clip = lensClipPath(a.placement, b.placement, mix, region);
      // A paint may never fall back to measuring live source DOM. Empty roots
      // still permit a material-only lens (and do not require any layout read).
      if (!snapshot && roots.length) throw new Error("Glass paint requires a measured source snapshot");
      const frame = snapshot || { roots: [], plans: [{ region, nodes: [] }] };
      position(region, hostTransform);
      if (strip.style.clipPath !== clip) strip.style.clipPath = clip;
      for (const [key, pair] of [["field", field], ["rim", rim]] as const) {
        place(pair.a, a.maps[key], a.placement, region);
        place(pair.b, b.maps[key], b.placement, region);
        attribute(pair.blend, "k2", (1 - mix).toFixed(4));
        attribute(pair.blend, "k3", mix.toFixed(4));
      }
      attribute(displacement, "scale", (refraction + 4 * glow).toFixed(2));
      // WebKit caches the decoded feImage inputs under the reference filter ID.
      if (webkit && (mapA !== a.maps || mapB !== b.maps)) {
        filter.id = `reader-glass-${++serial}`;
        plane.style.filter = `url("#${filter.id}")`;
      }
      mapA = a.maps;
      mapB = b.maps;
      // These are resource and binding checks, not a claim about browser pixels.
      // The independent outer contour remains in force even if SVG paint fails.
      if (!filter.isConnected || !plane.isConnected || !strip.style.clipPath ||
          !plane.style.filter.includes(filter.id)) throw new Error("Glass lens binding is unavailable");
      const pieces = source.update(roots, region, refresh, frame);
      if (strip.dataset.glassPrepared !== "resources-and-binding") strip.dataset.glassPrepared = "resources-and-binding";
      const alpha = opacity.toFixed(3);
      if (strip.style.opacity !== alpha) strip.style.opacity = alpha;
      if (strip.style.visibility !== "visible") strip.style.visibility = "visible";
      return pieces;
    },
    dispose() {
      disposed = true;
      for (const pair of [field, rim]) for (const node of [pair.a, pair.b]) node.removeEventListener("error", resourceError);
      source.clear(); svgHost.remove(); strip.remove();
    },
  };
}
