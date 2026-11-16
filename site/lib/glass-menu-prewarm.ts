import { getLayoutSize } from "../vendor/lisse-core/index.js";
import { openingAxis, planMorph, type Box, type MorphGeometry } from "../vendor/glass-hq/src/core/morph-path";
import { webkit } from "../vendor/glass-hq/src/dom/engine";

export const READER_GLASS_PREWARM = "reader-glass-prewarm";
export const READER_GLASS_MOTION_REST = "reader-glass-motion-rest";
export type GlassMenuPrewarmDetail = { shapes: readonly MorphGeometry[] };
type PredictionOptions = { webkit?: boolean; dpr?: number };
const boxOf = (element: HTMLElement): Box => {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height };
};

/** Geometry, rather than ResizeObserver alone, determines whether a source
 * has finished route breathing, scroll hiding, or pointer/keyboard pressure. */
export function isGlassMenuSourceAtRest(source: HTMLElement) {
  if (!source.isConnected || source.closest("[hidden], [inert], [aria-hidden=true]") ||
      source.matches(":active, [data-glass-pressed], [data-press-phase=pressed]")) return false;
  const style = window.getComputedStyle(source);
  if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) < .9999) return false;
  const number = (name: string, fallback: number) => {
    const value = style.getPropertyValue(name).trim();
    return value ? Number(value) : fallback;
  };
  const q = number("--reader-chrome-q", 1), scale = number("--reader-chrome-scale", 1);
  // Motion writes a CSS length ("0px" at rest), unlike the unitless q/scale.
  const length = style.getPropertyValue("--reader-chrome-x").trim();
  const x = !length ? 0 : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)px$/.test(length) ? parseFloat(length) : NaN;
  if (![q, scale, x].every(Number.isFinite) || Math.abs(q - 1) > .0001 || Math.abs(scale - 1) > .0001 || Math.abs(x) > .01) return false;
  const translate = style.translate;
  if (translate && translate !== "none" && translate.split(/\s+/).some(value => !Number.isFinite(parseFloat(value)) || Math.abs(parseFloat(value)) > .01)) return false;
  const bounds = boxOf(source), size = getLayoutSize(source, style);
  return bounds.width > 0 && bounds.height > 0 &&
    bounds.left >= -.01 && bounds.top >= -.01 && bounds.left + bounds.width <= window.innerWidth + .01 &&
    bounds.top + bounds.height <= window.innerHeight + .01 &&
    Math.abs(bounds.width - size.width) <= .01 && Math.abs(bounds.height - size.height) <= .01;
}

/** Matches attachGeometryMotion's font-menu detach plan, including its traced
 * neck and exact layout endpoint. The hidden panel has real content and CSS;
 * no menu height or rounded endpoint is estimated from text or constants. */
export function predictGlassMenuShapes(source: HTMLElement, panel: HTMLElement, options: PredictionOptions = {}): readonly MorphGeometry[] {
  if (!isGlassMenuSourceAtRest(source)) return [];
  const from = boxOf(source), to = boxOf(panel);
  const sourceSize = getLayoutSize(source), targetSize = getLayoutSize(panel);
  if (![from.width, from.height, to.width, to.height, sourceSize.width, sourceSize.height, targetSize.width, targetSize.height]
    .every(value => Number.isFinite(value) && value > 0)) return [];
  const requestedDpr = options.dpr ?? (typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
  const dpr = Math.min(Math.max(Number.isFinite(requestedDpr) ? requestedDpr : 1, 1), 2);
  const endpoints = { from, fromRadius: "circle" as const, to, toRadius: 24, along: openingAxis(from, to) };
  const glass = { ...from, radius: "circle" as const, layoutWidth: sourceSize.width, layoutHeight: sourceSize.height };
  const stops = planMorph(endpoints, glass, { dpr: 1, restDpr: dpr, neck: 36, stops: (options.webkit ?? webkit) ? 7 : 14 });
  const last = stops.at(-1);
  if (last) Object.assign(last.shape, { width: targetSize.width, height: targetSize.height });
  return stops.map(stop => stop.shape);
}

/** Predict only at layout boundaries, never on scroll. ResizeObserver covers
 * text/font reflow; the normalized signature ignores joint viewport movement. */
export function installGlassMenuPrewarm(source: HTMLElement, panel: HTMLElement) {
  let frame = 0, disposed = false, signature = "";
  function predict() {
    frame = 0;
    if (disposed || !panel.isConnected || !isGlassMenuSourceAtRest(source)) return;
    const from = boxOf(source), to = boxOf(panel);
    const a = getLayoutSize(source), b = getLayoutSize(panel);
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const next = JSON.stringify([from.width, from.height, to.left - from.left, to.top - from.top,
      to.width, to.height, a.width, a.height, b.width, b.height, dpr]);
    if (next === signature) return;
    const shapes = predictGlassMenuShapes(source, panel, { dpr });
    if (!shapes.length) return;
    signature = next;
    document.dispatchEvent(new CustomEvent<GlassMenuPrewarmDetail>(READER_GLASS_PREWARM, { detail: { shapes } }));
  }
  function schedule() { if (!disposed && !frame) frame = requestAnimationFrame(predict); }
  const observer = new ResizeObserver(schedule);
  observer.observe(source); observer.observe(panel);
  window.addEventListener("resize", schedule);
  document.addEventListener(READER_GLASS_MOTION_REST, schedule);
  document.fonts?.addEventListener("loadingdone", schedule);
  schedule();
  return () => {
    disposed = true; cancelAnimationFrame(frame); observer.disconnect();
    window.removeEventListener("resize", schedule);
    document.removeEventListener(READER_GLASS_MOTION_REST, schedule);
    document.fonts?.removeEventListener("loadingdone", schedule);
  };
}
