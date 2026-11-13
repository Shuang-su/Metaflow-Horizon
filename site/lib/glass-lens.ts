import { OpticalSource, type OpticalBox } from "./glass-optical-source";
import type { LensPlacement } from "../vendor/glass-hq/src/dom/morph";
import type { MapGeometry } from "../vendor/glass-hq/src/gpu/geometry";
import { webkit } from "../vendor/glass-hq/src/dom/engine";

export type LensKind = "chrome" | "toolbar" | "slider" | "menu";
export type GlassAppearance = NonNullable<MapGeometry["appearance"]>;
export type MaterialPlanes = { field: string; rim: string };
export type LensLayer = { placement: LensPlacement; maps: MaterialPlanes };

const namespace = "http://www.w3.org/2000/svg";
const reach = 26;
let serial = 0;

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
export function createGlassLens(host: HTMLElement, kind: LensKind) {
  const id = `reader-glass-${++serial}`;
  const strip = document.createElement("div");
  strip.className = "glass-optical-strip";
  strip.dataset.glassLens = kind;
  strip.style.visibility = "hidden";
  const plane = document.createElement("div");
  plane.className = "glass-optical-plane";
  strip.append(plane);
  const svgHost = svg("svg", { width: 0, height: 0, "aria-hidden": "true" });
  const filter = svg("filter", { id, x: 0, y: 0, width: 1, height: 1,
    filterUnits: "objectBoundingBox", primitiveUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB" });

  function pair(name: "field" | "rim") {
    const a = svg("feImage", { result: name + "A", preserveAspectRatio: "none" });
    const b = svg("feImage", { result: name + "B", preserveAspectRatio: "none" });
    const blend = svg("feComposite", { in: name + "A", in2: name + "B", operator: "arithmetic", k1: 0, k2: 1, k3: 0, k4: 0, result: name });
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
  if (kind === "menu") {
    filter.append(svg("feFlood", { class: "glass-menu-tint", result: "tint" }),
      svg("feComposite", { in: "tint", in2: "field", operator: "in", result: "tinted" }));
    merge.append(svg("feMergeNode", { in: "tinted" }));
  }
  merge.append(svg("feMergeNode", { in: "rim" }));
  filter.append(merge);
  const defs = svg("defs", {});
  defs.append(filter);
  svgHost.append(defs);
  host.append(svgHost, strip);
  plane.style.filter = `url("#${id}")`;
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
      const region = position({ left, top, width: right - left, height: bottom - top });
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
      const pieces = source.update(roots, region, refresh);
      const alpha = opacity.toFixed(3);
      if (strip.style.opacity !== alpha) strip.style.opacity = alpha;
      if (strip.style.visibility !== "visible") strip.style.visibility = "visible";
      return pieces;
    },
    dispose() { source.clear(); svgHost.remove(); strip.remove(); },
  };
}
