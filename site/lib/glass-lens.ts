import { OpticalSource, type OpticalBox } from "./glass-optical-source";
import type { LensPlacement } from "../vendor/glass-hq/src/dom/morph";
import type { MapGeometry } from "../vendor/glass-hq/src/gpu/geometry";
import { shapePolygon } from "../vendor/glass-hq/src/core/shape";
import type { ShapePoint } from "../vendor/glass-hq/src/core/concentric";
import { webkit } from "../vendor/glass-hq/src/dom/engine";

export type LensKind = "chrome" | "toolbar" | "slider" | "menu";
export type GlassAppearance = NonNullable<MapGeometry["appearance"]>;
export type MaterialPlanes = { field: string; rim: string };
export type LensLayer = { placement: LensPlacement; maps: MaterialPlanes };

const namespace = "http://www.w3.org/2000/svg";
const reach = 26;
// The original rim shader shades up to about one CSS pixel outside d=0.
const rimReach = 1.5;
let serial = 0;
const outlines = new Map<string, ShapePoint[]>();

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
  const points = lensClipOutline(a, b, mix, region);
  return `polygon(nonzero, ${points.map(([x, y]) => `${x.toFixed(3)}px ${y.toFixed(3)}px`).join(",")})`;
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
export function createGlassLens(host: HTMLElement, kind: LensKind, onFailure: () => void = () => {}) {
  const id = `reader-glass-${++serial}`;
  const strip = document.createElement("div");
  strip.className = "glass-optical-strip";
  strip.dataset.glassLens = kind;
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
  const blur = kind === "slider" ? .35 : kind === "menu" ? 6 : kind === "toolbar" ? 1.2 : .95;
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
    filter.append(svg("feFlood", { class: `glass-${kind}-tint`, result: "tint" }),
      svg("feComposite", { in: "tint", in2: "field", operator: "in", result: "tinted" }));
    merge.append(svg("feMergeNode", { in: "tinted" }));
  }
  merge.append(svg("feMergeNode", { in: "rim" }));
  filter.append(merge);
  const defs = svg("defs", {});
  defs.append(filter);
  svgHost.append(defs);
  host.append(svgHost, strip);
  const source = new OpticalSource(plane);
  let lastBox = "";
  let mapA: MaterialPlanes | undefined;
  let mapB: MaterialPlanes | undefined;

  function position(box: OpticalBox) {
    const bounds = { left: box.left - reach, top: box.top - reach, width: box.width + reach * 2, height: box.height + reach * 2 };
    const parent = kind === "slider" ? host.getBoundingClientRect() : null;
    const left = bounds.left - (parent?.left || 0), top = bounds.top - (parent?.top || 0);
    const key = `${left}|${top}|${bounds.width}|${bounds.height}`;
    if (key !== lastBox) {
      lastBox = key;
      Object.assign(strip.style, { left: `${left}px`, top: `${top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
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
    hide() { strip.style.visibility = "hidden"; },
    paint(a: LensLayer, b: LensLayer, mix: number, roots: HTMLElement[], opacity: number, refresh: boolean, glow: number) {
      const left = Math.min(a.placement.left, b.placement.left);
      const top = Math.min(a.placement.top, b.placement.top);
      const right = Math.max(a.placement.left + a.placement.width, b.placement.left + b.placement.width);
      const bottom = Math.max(a.placement.top + a.placement.height, b.placement.top + b.placement.height);
      if (broken || disposed) throw new Error("Glass lens is unavailable");
      if (![mix, opacity, glow].every(Number.isFinite) || !a.maps.field || !a.maps.rim || !b.maps.field || !b.maps.rim) {
        throw new Error("Glass lens resources are unavailable");
      }
      const region = position({ left, top, width: right - left, height: bottom - top });
      const clip = lensClipPath(a.placement, b.placement, mix, region);
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
      const pieces = source.update(roots, region, refresh);
      strip.dataset.glassPrepared = "resources-and-binding";
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
