import { updateCoverGlyphContrast } from "./reader-chrome-contrast";
import { chromeOpticalOpacity } from "./reader-chrome-motion";
import { createGlassLens, lensOpticalRegion, type GlassAppearance, type LensKind, type MaterialPlanes } from "./glass-lens";
import { createOpticalFrame, type OpticalFrameSnapshot } from "./glass-optical-source";
import { createGlassMaterialCache } from "./glass-material-cache";
import { readerFrame } from "./reader-frame";
import { isGlassMenuSourceAtRest, READER_GLASS_MOTION_REST } from "./glass-menu-prewarm";
import { attachGeometryMotion, type GeometryAnimator, type LensFrame, type LensPlacement } from "../vendor/glass-hq/src/dom/morph";
import { attachInteraction, resolveMotion, type SurfaceAnimator } from "../vendor/glass-hq/src/dom/interaction";
import { attachNativeControlMotion, updateControlMotion } from "../vendor/glass-hq/src/dom/control-motion";
import { polygonClip } from "../vendor/glass-hq/src/core/concentric";
import { shapeClip } from "../vendor/glass-hq/src/core/shape";
import type { MorphGeometry } from "../vendor/glass-hq/src/core/morph-path";
import { WebGL2MaterialRenderer } from "../vendor/glass-hq/src/webgl2/index";

const selector = "[data-glass-surface]";
const maximumSurfaces = 12;
const interactionEvents = ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerover", "pointerout", "keydown", "keyup", "focusout", "input"];
type Surface = {
  element: HTMLElement;
  kind: LensKind;
  lens: ReturnType<typeof createGlassLens>;
  outline?: GeometryAnimator;
  content?: HTMLElement | null;
  fallback?: HTMLElement;
  trigger?: HTMLElement | null;
  releaseControl?: () => void;
  entered: boolean;
  maps?: MaterialPlanes;
  mapsAppearance?: GlassAppearance;
  previousMaps?: MaterialPlanes;
  themeStart?: number;
  preparedPath?: readonly MorphGeometry[];
  preparedAppearance?: GlassAppearance;
  preparedDpr?: number;
};
type PaintJob = {
  surface: Surface; a: LensPlacement; b: LensPlacement; aMaps: MaterialPlanes; bMaps: MaterialPlanes;
  mix: number; sources: HTMLElement[]; opacity: number; changed: boolean; glow: number;
};

function lensKind(element: HTMLElement): LensKind {
  const kind = element.dataset.glassSurface;
  return kind === "toolbar" || kind === "slider" || kind === "menu" ? kind : "chrome";
}

function visible(element: HTMLElement) {
  if (element.closest("[hidden]")) return false;
  const bounds = element.getBoundingClientRect();
  return bounds.width > 1 && bounds.height > 1 && bounds.right > 0 && bounds.left < innerWidth &&
    bounds.bottom > 0 && bounds.top < innerHeight && getComputedStyle(element).visibility === "visible";
}

function shapeOf(surface: Surface): LensPlacement {
  const { element, kind } = surface;
  const box = element.getBoundingClientRect();
  const width = Math.max(1, element.offsetWidth);
  const height = Math.max(1, element.offsetHeight);
  // The thumb's shell grows on press. Its optical map is constant and is
  // stretched to the live outline, including the last release frame.
  const shape = kind === "slider" ? { width: 50, height: 28, radius: "capsule" as const }
    : { width, height, radius: kind === "menu" ? 24 : kind === "toolbar" ? "capsule" as const : "circle" as const };
  const lift = kind === "slider" ? Math.max(0, Math.min(1, Number(element.style.getPropertyValue("--lg-control-progress")))) : 0;
  const liveWidth = box.width * (1 + .923 * lift);
  const liveHeight = box.height * (1 + .273 * lift);
  return { left: box.left + (box.width - liveWidth) / 2, top: box.top + (box.height - liveHeight) / 2,
    width: liveWidth, height: liveHeight, shape };
}

function backdropRoots() {
  const main = document.querySelector<HTMLElement>("#main");
  const source = document.querySelector<HTMLElement>(".card-transition-backdrop[data-pull-visible] .card-transition-source, .card-transition-backdrop:not([data-retained]) .card-transition-source");
  const transition = document.querySelector<HTMLElement>(".card-transition-layer:not(:empty)");
  const entering = transition?.dataset.kind === "enter" && transition.dataset.state === "waiting";
  const draggedReturn = transition?.dataset.kind === "return" && Boolean(source?.closest("[data-pull-visible]"));
  return [source, entering || draggedReturn ? null : main, transition].filter((element): element is HTMLElement => Boolean(element));
}

export function startGlassChrome(root: HTMLElement) {
  delete root.dataset.glassFailure;
  const surfaces = new Map<HTMLElement, Surface>();
  const interactions = new Map<HTMLElement, SurfaceAnimator>();
  const preference = matchMedia("(prefers-color-scheme: dark)");
  let density = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
  const transparency = matchMedia("(prefers-reduced-transparency: reduce), (forced-colors: active)");
  const motion = () => resolveMotion("full");
  let appearance: GlassAppearance = "light";
  let renderer: WebGL2MaterialRenderer | undefined;
  let materials: ReturnType<typeof createGlassMaterialCache> | undefined;
  let failed = false;
  let disposed = false;
  let motionUntil = 0;
  let refreshSources = false;
  let jobs: PaintJob[] = [];
  const snapshots = new Map<HTMLElement[], OpticalFrameSnapshot>();
  let measuredFrames = 0;
  let paintedFrames = 0;
  let sourceCaptureMs = 0;
  let fontPrewarmShapes: readonly MorphGeometry[] = [];
  let warmedAppearance: GlassAppearance | undefined;
  let warmedDpr = 0;
  let motionRest = false;
  const debug = new URLSearchParams(location.search).has("glassDiagnostics");

  function report(state: string) {
    if (root.dataset.glassState !== state) root.dataset.glassState = state;
  }
  function fallback(reason = "material-or-context") {
    if (disposed || failed) return;
    failed = true;
    root.dataset.glassFailure = reason;
    materials?.dispose();
    renderer?.dispose();
    for (const surface of surfaces.values()) {
      delete surface.element.dataset.glassReady;
      delete surface.element.dataset.coverGlyph;
      delete surface.element.dataset.glassPending;
      surface.lens.hide();
    }
    report("fallback");
    schedule();
  }
  function material(shape: MorphGeometry) {
    if (failed || !materials) return;
    return materials.get(shape, appearance, Math.min(devicePixelRatio || 1, 2));
  }

  function makeSurface(element: HTMLElement, kind: LensKind, host: HTMLElement) {
    const surface: Surface = { element, kind, lens: createGlassLens(host, kind, () => fallback("filter-resource")), entered: false };
    if (kind === "slider") surface.releaseControl = attachNativeControlMotion(element, "full", true);
    if (kind === "menu") {
      surface.trigger = document.getElementById(element.dataset.glassMorphFrom || "");
      surface.content = element.querySelector<HTMLElement>(".reader-font-content, [data-glass-menu-content]");
      surface.fallback = document.createElement("div");
      surface.fallback.className = "glass-menu-fallback";
      surface.fallback.hidden = true;
      root.append(surface.fallback);
      const becomesTrigger = element.dataset.glassMorphMode === "become";
      surface.outline = attachGeometryMotion(element, {
        from: () => surface.trigger,
        morph: becomesTrigger ? "become" : "detach",
        radius: 24,
        neck: becomesTrigger ? 0 : 36,
        motion,
        prepared: shape => failed || transparency.matches || Boolean(material(shape)),
      });
    }
    resize.observe(element);
    return surface;
  }

  function removeSurface(surface: Surface) {
    resize.unobserve(surface.element);
    surface.outline?.dispose();
    surface.releaseControl?.();
    surface.fallback?.remove();
    surface.lens.dispose();
    delete surface.element.dataset.glassReady;
    delete surface.element.dataset.coverGlyph;
    delete surface.element.dataset.glassPending;
    delete surface.element.dataset.glassAbsorbing;
    surface.element.style.removeProperty("--glass-absorbed");
    surface.content?.style.removeProperty("clip-path");
  }

  function clipMenu(surface: Surface, box: LensPlacement, path: LensFrame | undefined) {
    if (!surface.content) return;
    if (!path) {
      surface.content.style.removeProperty("clip-path");
      return;
    }
    const inset = (value: number) => `${Math.max(0, value).toFixed(2)}px`;
    const clip = `inset(${inset(path.top - box.top)} ${inset(box.left + box.width - path.left - path.width)} ${inset(box.top + box.height - path.top - path.height)} ${inset(path.left - box.left)} round ${path.radius === "capsule" ? path.height / 2 : path.radius}px)`;
    if (surface.content.style.clipPath !== clip) surface.content.style.clipPath = clip;
  }

  function fallbackShape(surface: Surface, box: LensPlacement, placement: LensPlacement, opacity: number) {
    const layer = surface.fallback;
    if (!layer) return;
    layer.hidden = false;
    Object.assign(layer.style, {
      left: `${placement.left}px`, top: `${placement.top}px`, width: `${placement.width}px`, height: `${placement.height}px`,
      opacity: String(opacity),
      clipPath: placement.shape.outline
        ? polygonClip(placement.shape.outline)
        : shapeClip(placement.width, placement.height, placement.shape.radius),
    });
    if (!surface.outline?.geometry() && (box.width === 0 || box.height === 0)) layer.hidden = true;
  }

  function schedule() {
    if (!disposed) readerFrame.request();
  }
  function syncSlider() {
    // React commits the range value before the shared RAF. Do not start a
    // second optical scan from an input microtask in the same display frame.
    schedule();
  }
  const wakeMotion = () => { motionUntil = performance.now() + 250; schedule(); };
  const densityChanged = () => {
    density.removeEventListener("change", densityChanged);
    density = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
    density.addEventListener("change", densityChanged);
    wakeMotion();
  };
  density.addEventListener("change", densityChanged);
  const resize = new ResizeObserver(() => { refreshSources = true; schedule(); });
  function draw(now: number) {
    jobs = [];
    snapshots.clear();
    if (disposed || document.hidden) return;
    materials?.beginFrame();
    const theme = document.documentElement.dataset.theme;
    appearance = theme === "light" || theme === "dark" ? theme : preference.matches ? "dark" : "light";
    if (!document.getElementById("reader-font-trigger")) fontPrewarmShapes = [];
    const currentDpr = Math.min(devicePixelRatio || 1, 2);
    if (fontPrewarmShapes.length && (appearance !== warmedAppearance || currentDpr !== warmedDpr)) {
      materials?.prewarm(fontPrewarmShapes, appearance, currentDpr);
      warmedAppearance = appearance; warmedDpr = currentDpr;
    }
    const controls = new Set(Array.from(document.querySelectorAll<HTMLElement>("[data-glass-interactive]"))
      .filter(element => !element.closest("[inert]") && visible(element)));
    for (const [element, animator] of interactions) if (!controls.has(element)) {
      animator.dispose();
      interactions.delete(element);
    }
    for (const element of controls) if (!interactions.has(element)) interactions.set(element, attachInteraction(element, motion));
    let moving = false;
    moving = updateControlMotion(document.body, now);
    for (const animator of interactions.values()) if (animator.frame(now)) moving = true;

    const targets = Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter(element => {
        const kind = lensKind(element);
        return (kind === "menu" || kind === "slider" || !element.closest("[aria-hidden=true]")) && visible(element);
      }).slice(0, maximumSurfaces);
    for (const [element, surface] of surfaces) if (!targets.includes(element)) {
      removeSurface(surface);
      surfaces.delete(element);
    }
    for (const element of targets) if (!surfaces.has(element)) {
      const kind = lensKind(element);
      const host = kind === "slider" ? element.closest("[data-glass-scope]")?.querySelector<HTMLElement>("[data-glass-optics-host]") : root;
      if (host) surfaces.set(element, makeSurface(element, kind, host));
    }

    const backdrop = backdropRoots();
    const finiteMotion = (animations: Animation[]) => animations.some(animation => {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      // This thin timer runs for eight seconds; it does not need to keep all
      // optical surfaces sampling between actual carousel movements.
      if (target instanceof Element && target.closest(".carousel-progress")) return false;
      return animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().endTime);
    });

    // Continue sampling independent interaction and ancestor animations.
    // Cover and scroll chrome advance earlier in this same coordinated frame.
    const motionHosts = new Set<HTMLElement>();
    for (const element of targets) {
      for (let host: HTMLElement | null = element; host && host !== document.body; host = host.parentElement)
        motionHosts.add(host);
    }
    for (const host of motionHosts) {
      if (finiteMotion(host.getAnimations())) moving = true;
    }
    // Backdrop transitions, such as Swiper's 300ms slide, are not ancestors of
    // the fixed controls. Follow their actual lifetime as well; reading the
    // animation list does not walk and measure the source's DOM on every frame.
    if (backdrop.some(source => finiteMotion(source.getAnimations({ subtree: true })))) moving = true;

    const paths = new Map<Surface, LensFrame>();
    const absorbed = new Map<Element, number>();
    for (const surface of surfaces.values()) {
      const outline = surface.outline;
      if (!outline) continue;
      if (surface.element.hasAttribute("data-ending-style")) surface.entered = false;
      if (outline.frame(now)) moving = true;
      const path = outline.geometry();
      if (path) {
        paths.set(surface, path);
        if (path.absorbs) absorbed.set(path.absorbs.element, path.absorbs.weight);
      }
      const waypoints = outline.waypoints();
      const dpr = Math.min(devicePixelRatio || 1, 2);
      if (!failed && !transparency.matches && (surface.preparedPath !== waypoints ||
          surface.preparedAppearance !== appearance || surface.preparedDpr !== dpr)) {
        materials?.prewarm(waypoints, appearance, dpr);
        surface.preparedPath = waypoints; surface.preparedAppearance = appearance; surface.preparedDpr = dpr;
      }
      const reveal = parseFloat(surface.element.style.getPropertyValue("--lg-morph"));
      const contentReady = !surface.element.hasAttribute("data-glass-morph") || reveal >= .97;
      const menuBox = path && surface.element.dataset.glassMorphMode === "become"
        ? surface.element.getBoundingClientRect() : undefined;
      const positionReady = !menuBox || !path ||
        (Math.abs(path.left - menuBox.left) < 1 && Math.abs(path.width - menuBox.width) < 1);
      if (!surface.entered && !outline.positioning() && !outline.pending() && contentReady && positionReady
          && !surface.element.hasAttribute("data-ending-style") && !surface.element.hasAttribute("data-starting-style")) {
        surface.entered = true;
        surface.element.dispatchEvent(new CustomEvent("glass:entered"));
      }
    }

    // Source replicas store computed colours. Sample every frame of the theme
    // crossfade instead of freezing its first colour until transitionend.
    const changed = refreshSources || document.documentElement.hasAttribute("data-theme-changing");
    refreshSources = false;
    for (const surface of surfaces.values()) {
      const { element, kind, lens, outline } = surface;
      if (kind === "chrome") {
        // Decoding a new material is not a capability fallback. Avoid flashing
        // a second DOM disc while its first optical field is being prepared.
        if (!failed && !transparency.matches && !element.hasAttribute("data-glass-ready")) element.dataset.glassPending = "";
        else delete element.dataset.glassPending;
      }
      if (kind === "chrome" && (failed || transparency.matches)) delete element.dataset.coverGlyph;
      const box = shapeOf(surface);
      const path = paths.get(surface);
      const a = path?.draw?.a ?? box, b = path?.draw?.b ?? a;
      const mix = path?.draw?.mix ?? 0;
      const suppressed = absorbed.get(element) || 0;
      const progress = kind === "slider" ? Math.max(0, Math.min(1, Number(element.style.getPropertyValue("--lg-control-progress")))) : 1;
      const transitioning = element.hasAttribute("data-glass-morph");
      const exitAtSource = kind === "menu" && element.hasAttribute("data-ending-style") && !transitioning;
      const chromeQ = kind === "chrome" && element.hasAttribute("data-chrome-motion")
        ? Number(element.style.getPropertyValue("--reader-chrome-q")) : 1;
      const opacity = (outline?.opacity() ?? 1) * progress * chromeOpticalOpacity(chromeQ, suppressed) * (exitAtSource ? 0 : 1);
      if (suppressed > 0 && element.style.getPropertyValue("--glass-absorbed") !== String(suppressed)) {
        element.style.setProperty("--glass-absorbed", String(suppressed));
        element.dataset.glassAbsorbing = "";
      } else if (suppressed === 0 && element.hasAttribute("data-glass-absorbing")) {
        element.style.removeProperty("--glass-absorbed");
        delete element.dataset.glassAbsorbing;
      }
      clipMenu(surface, box, path);
      if (surface.fallback && !surface.fallback.hidden) surface.fallback.hidden = true;
      if (transparency.matches && kind === "menu") {
        lens.hide();
        delete element.dataset.glassReady;
        continue;
      }

      const settled = !failed && !transparency.matches ? material(box.shape) : undefined;
      if (settled && settled !== surface.maps) {
        // A density/geometry upgrade is ready to display now. Only an actual
        // theme change needs the material crossfade; quality must not lag 200ms.
        surface.previousMaps = motion() === "full" && surface.mapsAppearance !== appearance ? surface.maps : undefined;
        surface.maps = settled;
        surface.mapsAppearance = appearance;
        surface.themeStart = now;
      }
      const themeMix = surface.previousMaps ? Math.min(1, (now - (surface.themeStart ?? now)) / 200) : 1;
      if (themeMix < 1) moving = true;
      else surface.previousMaps = undefined;
      const field = !failed && !transparency.matches;
      const aMaps = field ? material(a.shape) ?? surface.maps : undefined;
      const bMaps = field && a !== b ? material(b.shape) ?? surface.maps : aMaps;
      if (opacity < .001 || !aMaps || !bMaps) {
        lens.hide();
        if (failed || transparency.matches) delete element.dataset.glassReady;
        if (outline && path && opacity >= .001) fallbackShape(surface, box, mix < .5 ? a : b, opacity);
        continue;
      }
      const sources = kind === "slider"
        ? Array.from(element.closest("[data-glass-scope]")?.querySelectorAll<HTMLElement>("[data-glass-source]") || [])
        : backdrop;
      const previous = !path && surface.previousMaps;
      const glow = kind === "toolbar" ? Array.from(element.querySelectorAll<HTMLElement>("[data-glass-interactive]"))
        .reduce((value, control) => Math.max(value, Number(control.style.getPropertyValue("--lg-glow"))), 0) : 0;
      if (kind === "chrome") updateCoverGlyphContrast(element, appearance === "dark", true);
      materials?.pin(previous || aMaps); materials?.pin(bMaps);
      jobs.push({ surface, a, b, aMaps: previous || aMaps, bMaps,
        mix: previous ? themeMix * (2 - themeMix) : mix, sources, opacity, changed, glow });
    }
    const started = performance.now();
    if (jobs.length) {
      // All page lenses share the exact backdrop array; a slider's tiny local
      // rail is a separate source, never another full article traversal.
      for (const roots of new Set(jobs.map(job => job.sources))) {
        snapshots.set(roots, createOpticalFrame(roots, jobs.filter(job => job.sources === roots)
          .map(job => lensOpticalRegion(job.a, job.b))));
      }
      measuredFrames++;
    }
    sourceCaptureMs = performance.now() - started;
    const keepMoving = moving || now < motionUntil;
    const fontTrigger = document.getElementById("reader-font-trigger");
    const atRest = !keepMoving && fontTrigger !== null && isGlassMenuSourceAtRest(fontTrigger);
    if (atRest && !motionRest) document.dispatchEvent(new Event(READER_GLASS_MOTION_REST));
    motionRest = atRest;
    return keepMoving;
  }

  function paint() {
    if (disposed || document.hidden) return;
    let pieces = 0, textPieces = 0;
    for (const job of jobs) {
      const { surface, a, b, aMaps, bMaps, sources, opacity, changed, glow, mix } = job;
      try {
        pieces += surface.lens.paint({ placement: a, maps: aMaps }, { placement: b, maps: bMaps },
          mix, sources, opacity, changed, glow, snapshots.get(sources));
      } catch { fallback("lens-binding-or-paint"); break; }
      textPieces += surface.lens.source.visibleTextCount;
      if (!surface.element.hasAttribute("data-glass-ready")) surface.element.dataset.glassReady = "";
      delete surface.element.dataset.glassPending;
      report("webgl2-html");
    }
    if (jobs.length) paintedFrames++;
    materials?.endFrame();
    if (!surfaces.size && !failed) report("idle");
    if (root.dataset.glassPieces !== String(pieces)) root.dataset.glassPieces = String(pieces);
    if (root.dataset.glassTextPieces !== String(textPieces)) root.dataset.glassTextPieces = String(textPieces);
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target || target.closest("[data-glass-optics], [data-glass-optics-host]")) continue;
      if (record.type === "attributes" && record.attributeName && record.oldValue === target.getAttribute(record.attributeName)) continue;
      if (record.type !== "attributes" || record.attributeName === "data-theme" ||
          record.attributeName === "class" || record.attributeName === "src" ||
          (target === document.documentElement && record.attributeName === "style")) refreshSources = true;
      if (target.matches(".reader-font-graphics") && record.attributeName === "style") syncSlider();
      schedule();
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true,
    attributeFilter: ["class", "style", "hidden", "inert", "aria-hidden", "data-card-pulling", "data-pull-visible", "data-retained",
      "src", "data-glass-surface", "data-ending-style", "data-starting-style", "data-press-phase"] });
  observer.observe(document.documentElement, { attributes: true, attributeOldValue: true, attributeFilter: ["data-theme", "style"] });
  const releaseMeasure = readerFrame.subscribe("measure", draw);
  const releasePaint = readerFrame.subscribe("paint", paint);
  const prewarmFont = (event: Event) => {
    fontPrewarmShapes = (event as CustomEvent<{ shapes: readonly MorphGeometry[] }>).detail.shapes;
    warmedAppearance = undefined;
    schedule();
  };
  document.addEventListener("reader-glass-prewarm", prewarmFont);
  const repaint = (event: Event) => {
    if (event.target instanceof Element && event.target.closest("[data-glass-optics], [data-glass-optics-host]")) return;
    refreshSources = true;
    wakeMotion();
  };
  const input = (event: Event) => {
    if (event.target instanceof Element && event.target.closest("[data-glass-interactive], [data-glass-scope], [data-glass-surface=menu]")) wakeMotion();
    if (event.type === "input" && event.target instanceof HTMLInputElement && event.target.closest("[data-glass-scope]")) {
      // A native range commits its discrete value after the capture phase.
      // Sample again after React's commit so the next paint shares its rail.
      syncSlider();
    }
  };
  for (const event of interactionEvents) document.addEventListener(event, input, { capture: true, passive: true });
  window.addEventListener("scroll", schedule, { passive: true, capture: true });
  window.addEventListener("resize", wakeMotion, { passive: true });
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", wakeMotion);
  document.addEventListener("visibilitychange", schedule);
  document.addEventListener("transitionrun", wakeMotion);
  document.addEventListener("transitionend", repaint);
  document.addEventListener("animationstart", wakeMotion);
  document.addEventListener("load", repaint, true);
  document.fonts?.addEventListener("loadingdone", repaint);
  preference.addEventListener("change", repaint);
  transparency.addEventListener("change", repaint);
  try {
    renderer = new WebGL2MaterialRenderer(fallback);
    materials = createGlassMaterialCache(renderer, { onReady: schedule, onFailure: () => fallback("material-resource") });
  } catch { fallback(); }
  type DebugRoot = HTMLElement & { glassDiagnostics?: () => unknown };
  if (debug) (root as DebugRoot).glassDiagnostics = () => ({
    frame: readerFrame.inspect(), measuredFrames, paintedFrames, sourceCaptureMs,
    sourceGroups: snapshots.size, surfaces: surfaces.size, materials: materials?.diagnostics(),
  });
  const warmStatic = () => {
    if (disposed || failed || transparency.matches) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const shapes = [...surfaces.values()].filter(surface => !surface.outline).map(surface => shapeOf(surface).shape);
    materials?.prewarm(shapes, appearance === "dark" ? "light" : "dark", dpr);
  };
  const warmTimer = setTimeout(warmStatic, 600);
  schedule();

  return () => {
    disposed = true;
    releaseMeasure(); releasePaint(); clearTimeout(warmTimer);
    observer.disconnect();
    delete (root as DebugRoot).glassDiagnostics;
    document.removeEventListener("reader-glass-prewarm", prewarmFont);
    resize.disconnect();
    for (const event of interactionEvents) document.removeEventListener(event, input, true);
    window.removeEventListener("scroll", schedule, true);
    window.removeEventListener("resize", wakeMotion);
    viewport?.removeEventListener("resize", wakeMotion);
    document.removeEventListener("visibilitychange", schedule);
    document.removeEventListener("transitionrun", wakeMotion);
    document.removeEventListener("transitionend", repaint);
    document.removeEventListener("animationstart", wakeMotion);
    document.removeEventListener("load", repaint, true);
    document.fonts?.removeEventListener("loadingdone", repaint);
    preference.removeEventListener("change", repaint);
    density.removeEventListener("change", densityChanged);
    transparency.removeEventListener("change", repaint);
    for (const surface of surfaces.values()) removeSurface(surface);
    for (const animator of interactions.values()) animator.dispose();
    materials?.dispose();
    renderer?.dispose();
  };
}
