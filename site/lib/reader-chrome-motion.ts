import { readerFrame } from "./reader-frame";

/** One reversible clock for DOM chrome and its separately hosted optical lens. */
export const CHROME_FADE_MS = 180;
export const CHROME_ROUTE_MS = 320;
// Web tuning distance: gesture displacement drives q, rather than a hide timer.
export const CHROME_SCROLL_RANGE = 64;
const selector = ".reader-header :is(.reader-chrome-control,.menu-toggle), .home-header .header-actions :is(.search-link,.appearance-toggle,.menu-toggle)";
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const ease = (value: number) => value * value * (3 - 2 * value);

export class ChromeVisibility {
  value = 1;
  target = 1;
  private from = 1;
  private start = 0;
  set(visible: boolean, now: number, immediate = false) {
    this.sample(now);
    const target = visible ? 1 : 0;
    if (immediate) { this.value = this.from = this.target = target; return; }
    if (target === this.target) return;
    this.from = this.value;
    this.target = target;
    this.start = now;
  }
  follow(delta: number, now: number) {
    this.sample(now);
    this.value = this.from = this.target = clamp(this.value - delta / CHROME_SCROLL_RANGE);
    this.start = now;
    return this.value;
  }
  sample(now: number) {
    const progress = clamp((now - this.start) / CHROME_FADE_MS);
    this.value = this.from + (this.target - this.from) * ease(progress);
    return this.value;
  }
  get moving() { return this.value !== this.target; }
}

export function chromeRouteFrame(elapsed: number) {
  const progress = clamp(elapsed / CHROME_ROUTE_MS);
  // Separate shell breathing from the short glyph crossfade.
  const pulse = progress <= .5 ? ease(progress * 2) : ease((1 - progress) * 2);
  return { scale: 1 + .2 * pulse, glyph: ease(clamp(elapsed / CHROME_FADE_MS)) };
}
export function chromeExitOffset(q: number, side: "left" | "right", left: number, width: number, viewport: number) {
  const distance = side === "left" ? -(left + width + 16) : viewport - left + 16;
  return distance * (1 - clamp(q));
}
export function chromeVisibilityScale(q: number) { return .96 + .04 * clamp(q); }
export function chromeOpticalOpacity(q: number, absorption: number) { return clamp(q) * (1 - clamp(absorption)); }

type Glyph = { live: HTMLElement | SVGElement; ghost?: HTMLElement };

export function createReaderChromeMotion() {
  const root = document.documentElement;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const visibility = new ChromeVisibility();
  let routeStart: number | undefined;
  let pathname: string | undefined;
  let snapshots = new Map<string, Node>();
  let glyphs: Glyph[] = [];
  const controls = () => Array.from(document.querySelectorAll<HTMLElement>(selector))
    .filter(element => element.closest(".reader-header") || window.innerWidth <= 767);
  const key = (element: HTMLElement) => element.matches(".menu-toggle") ? "menu"
    : element.matches(".article-back") ? "back"
    : element.matches(".search-link,.reader-font-trigger") ? "primary" : "secondary";
  const glyph = (element: HTMLElement) => Array.from(element.children).find(child =>
    !child.classList.contains("sr-only") && !child.hasAttribute("data-chrome-old-glyph")) as HTMLElement | SVGElement | undefined;
  function clearGlyphs() {
    for (const { live, ghost } of glyphs) {
      live.style.removeProperty("opacity"); live.style.removeProperty("filter"); live.style.removeProperty("scale");
      ghost?.remove();
    }
    glyphs = [];
  }
  function capture() {
    snapshots = new Map(controls().flatMap(element => {
      const node = glyph(element);
      return node ? [[key(element), node.cloneNode(true)] as const] : [];
    }));
  }
  function paint(now: number) {
    const q = visibility.sample(now);
    const route = routeStart === undefined ? { scale: 1, glyph: 1 } : chromeRouteFrame(now - routeStart);
    const header = document.querySelector<HTMLElement>(".reader-header");
    const right = header?.querySelector<HTMLElement>(".header-actions")?.getBoundingClientRect();
    const left = header?.querySelector<HTMLElement>(".header-brand-group")?.getBoundingClientRect();
    for (const element of controls()) {
      const side = element.matches(".article-back") ? "left" : "right";
      const anchor = side === "left" ? left : right;
      const x = anchor ? chromeExitOffset(q, side, anchor.left, anchor.width, window.innerWidth) : 0;
      for (const [property, value] of [["--reader-chrome-x", `${x}px`], ["--reader-chrome-q", String(q)],
        ["--reader-chrome-scale", String(chromeVisibilityScale(q) * route.scale)]]) {
        if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
      }
      if (!element.hasAttribute("data-chrome-motion")) element.dataset.chromeMotion = "";
    }
    for (const { live, ghost } of glyphs) {
      live.style.opacity = `calc(${route.glyph} * var(--lg-morph-source, 1))`;
      live.style.filter = `blur(${4 * (1 - route.glyph)}px)`;
      live.style.scale = String(1 / route.scale);
      if (ghost) { ghost.style.opacity = `calc(${1 - route.glyph} * var(--lg-morph-source, 1))`; ghost.style.filter = `blur(${4 * route.glyph}px)`; ghost.style.scale = String(1 / route.scale); }
    }
    if (routeStart !== undefined && now - routeStart >= CHROME_ROUTE_MS) {
      routeStart = undefined;
      clearGlyphs();
      capture();
    }
    return visibility.moving || routeStart !== undefined;
  }
  const releaseFrame = readerFrame.subscribe("advance", paint, 10);
  function repaint() { readerFrame.request(); }
  function setVisible(visible: boolean, immediate = reduced.matches) {
    if (visibility.target === (visible ? 1 : 0) && !visibility.moving) return;
    visibility.set(visible, performance.now(), immediate);
    root.toggleAttribute("data-reader-controls-hidden", !visible);
    repaint();
  }
  function followScroll(delta: number) {
    if (!delta) return;
    if (reduced.matches) { setVisible(delta < 0, true); return; }
    const q = visibility.follow(delta, performance.now());
    root.toggleAttribute("data-reader-controls-hidden", q <= .001);
    repaint();
  }
  function route(next: string) {
    if (pathname === next) return;
    const initial = pathname === undefined;
    pathname = next;
    clearGlyphs();
    visibility.set(true, performance.now(), true);
    root.removeAttribute("data-reader-controls-hidden");
    routeStart = undefined;
    if (!initial && !reduced.matches) {
      routeStart = performance.now();
      for (const element of controls()) {
        const live = glyph(element);
        if (!live) continue;
        const previous = snapshots.get(key(element));
        let ghost: HTMLElement | undefined;
        if (previous) {
          ghost = document.createElement("span");
          ghost.dataset.chromeOldGlyph = "";
          ghost.setAttribute("aria-hidden", "true");
          ghost.append(previous.cloneNode(true));
          // Snapshots contain only a glyph; remove any interrupted motion styles.
          const child = ghost.firstElementChild as HTMLElement | SVGElement;
          child.style.removeProperty("opacity"); child.style.removeProperty("filter"); child.style.removeProperty("scale");
          element.append(ghost);
        }
        glyphs.push({ live, ghost });
      }
    }
    repaint();
    if (initial || reduced.matches) capture();
  }
  // Keep the old glyph current for menu icon changes between route commits.
  // The route layout effect runs before this observer, preserving its old snapshot.
  const observer = new MutationObserver(() => { if (routeStart === undefined) capture(); });
  const header = document.querySelector(".site-header");
  if (header) observer.observe(header, { subtree: true, childList: true });
  function preferences() {
    routeStart = undefined; clearGlyphs();
    visibility.set(visibility.target === 1, performance.now(), true);
    repaint(); capture();
  }
  reduced.addEventListener("change", preferences);
  return {
    route, setVisible, followScroll,
    dispose() {
      releaseFrame(); observer.disconnect(); clearGlyphs(); reduced.removeEventListener("change", preferences);
      root.removeAttribute("data-reader-controls-hidden");
      for (const element of controls()) {
        element.style.removeProperty("--reader-chrome-q"); element.style.removeProperty("--reader-chrome-scale");
        element.style.removeProperty("--reader-chrome-x");
        delete element.dataset.chromeMotion;
      }
    },
  };
}
