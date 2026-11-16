import { getLayoutSize } from "../vendor/lisse-core/index.js";
import { openingAxis, type Box, type MorphGeometry } from "../vendor/glass-hq/src/core/morph-path";
import { requestMorphPlan, morphLayoutBox } from "../vendor/glass-hq/src/dom/morph-plan";
import { glassColdStart, traceGlass } from "./glass-diagnostics";
import { webkit } from "../vendor/glass-hq/src/dom/engine";

export const READER_GLASS_PREWARM = "reader-glass-prewarm";
export const READER_GLASS_MOTION_REST = "reader-glass-motion-rest";
export type GlassMenuPrewarmDetail = { shapes: readonly MorphGeometry[] };
type PredictionOptions = { webkit?: boolean; dpr?: number; signal?: AbortSignal };
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
export async function predictGlassMenuShapes(source: HTMLElement, panel: HTMLElement, options: PredictionOptions = {}): Promise<readonly MorphGeometry[]> {
  if (glassColdStart() || !isGlassMenuSourceAtRest(source)) return [];
  const sourceSize = getLayoutSize(source), targetSize = getLayoutSize(panel);
  const from = morphLayoutBox(boxOf(source), sourceSize), to = morphLayoutBox(boxOf(panel), targetSize);
  if (![from.width, from.height, to.width, to.height, sourceSize.width, sourceSize.height, targetSize.width, targetSize.height]
    .every(value => Number.isFinite(value) && value > 0)) return [];
  const requestedDpr = options.dpr ?? (typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
  const dpr = Math.min(Math.max(Number.isFinite(requestedDpr) ? requestedDpr : 1, 1), 2);
  const endpoints = { from, fromRadius: "circle" as const, to, toRadius: 24, along: openingAxis(from, to) };
  const glass = { ...from, radius: "circle" as const, layoutWidth: sourceSize.width, layoutHeight: sourceSize.height };
  const stops = await requestMorphPlan(endpoints, glass, { dpr: 1, restDpr: dpr, neck: 36, stops: (options.webkit ?? webkit) ? 7 : 14 }, { signal: options.signal });
  const last = stops.at(-1);
  if (last) Object.assign(last.shape, { width: targetSize.width, height: targetSize.height });
  return stops.map(stop => stop.shape);
}

/** Predict only at layout boundaries, never on scroll. ResizeObserver covers
 * text/font reflow; the normalized signature ignores joint viewport movement. */
export function installGlassMenuPrewarm(source: HTMLElement, panel: HTMLElement,
  options: { predict?: typeof predictGlassMenuShapes; cold?: () => boolean } = {}) {
  const cold = options.cold ?? glassColdStart;
  if (cold()) return () => {};
  const planner = options.predict ?? predictGlassMenuShapes;
  let frame = 0, disposed = false, signature = "", version = 0;
  let pending: AbortController | undefined;
  const layoutSignature = () => {
    const a = getLayoutSize(source), b = getLayoutSize(panel);
    const from = morphLayoutBox(boxOf(source), a), to = morphLayoutBox(boxOf(panel), b);
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    return JSON.stringify([from.width, from.height, to.left - from.left, to.top - from.top,
      to.width, to.height, a.width, a.height, b.width, b.height, dpr]);
  };
  function predict() {
    frame = 0;
    if (disposed || cold() || !panel.isConnected || !isGlassMenuSourceAtRest(source)) return;
    const next = layoutSignature();
    if (next === signature) return;
    const current = version, controller = pending = new AbortController();
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    void planner(source, panel, { dpr, signal: controller.signal }).then(shapes => {
      if (disposed || cold() || current !== version || controller.signal.aborted || !shapes.length ||
          !panel.isConnected || !isGlassMenuSourceAtRest(source)) return;
      if (layoutSignature() !== next) { schedule(); return; }
      signature = next; pending = undefined;
      document.dispatchEvent(new CustomEvent<GlassMenuPrewarmDetail>(READER_GLASS_PREWARM, { detail: { shapes } }));
    }, error => {
      if (!disposed && current === version && error?.name !== "AbortError") traceGlass("menu-prewarm-failure", { error: String(error) });
      if (pending === controller) pending = undefined;
    });
  }
  function schedule() {
    if (disposed || cold()) return;
    // Invalidate immediately, before the scheduled measurement, so a result
    // arriving between resize and RAF cannot publish an obsolete layout.
    version++; pending?.abort(); pending = undefined;
    if (!frame) frame = requestAnimationFrame(predict);
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(source); observer.observe(panel);
  window.addEventListener("resize", schedule);
  document.addEventListener(READER_GLASS_MOTION_REST, schedule);
  document.fonts?.addEventListener("loadingdone", schedule);
  schedule();
  return () => {
    disposed = true; version++; pending?.abort(); pending = undefined;
    cancelAnimationFrame(frame); observer.disconnect();
    window.removeEventListener("resize", schedule);
    document.removeEventListener(READER_GLASS_MOTION_REST, schedule);
    document.fonts?.removeEventListener("loadingdone", schedule);
  };
}

/** A timer may recover a surface with no animator, never bypass an active
 * geometry/material preparation or interrupted return. Normal completion
 * belongs to glass:entered / glass:exited. */
export function canFinishGlassMenuWithoutMotion(panel: Pick<HTMLElement, "hasAttribute">) {
  return !panel.hasAttribute("data-glass-morph") && !panel.hasAttribute("data-glass-pending") &&
    !panel.hasAttribute("data-starting-style");
}
