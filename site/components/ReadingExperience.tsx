"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { installReaderSheetDrag } from "../lib/reader-sheet";
import { createReaderChromeMotion } from "../lib/reader-chrome-motion";

export default function ReadingExperience() {
  const pathname = usePathname();
  const chrome = useRef<ReturnType<typeof createReaderChromeMotion> | null>(null);
  useLayoutEffect(() => {
    chrome.current = createReaderChromeMotion();
    return () => { chrome.current?.dispose(); chrome.current = null; };
  }, []);
  useLayoutEffect(() => { chrome.current?.route(pathname); }, [pathname]);
  useEffect(installReaderSheetDrag, []);
  useEffect(() => {
    if (!document.querySelector("[data-reader-article]")) return;
    const phone = matchMedia("(max-width: 767px)");
    const folded = matchMedia("(vertical-viewport-segments: 2)");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let last = Math.max(0, window.scrollY);
    let width = window.innerWidth;
    let orientation = screen.orientation?.angle;
    let programmatic = false;
    function reveal() { chrome.current?.setVisible(true); }
    function protectedChrome() {
      return Boolean(document.querySelector("[data-reader-route-pending], main[data-card-pulling], .reader-header[data-menu-open=true], #reader-font-panel, .reading-navigator.is-open, dialog[open]")
        || document.activeElement?.matches("[data-reader-scroll-chrome] :focus-visible"));
    }
    function update() {
      frame = 0;
      const y = Math.max(0, window.scrollY);
      const delta = y - last;
      last = y;
      if (!phone.matches || folded.matches || y === 0 || protectedChrome() || (visualViewport?.scale ?? 1) > 1.01) {
        reveal();
        return;
      }
      if (programmatic || !delta) return;
      // Keep every fractional CSS pixel. There is no release timer: a pause at
      // any progress remains paused until content actually moves again.
      chrome.current?.followScroll(delta);
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(update); }
    function userInput(event: Event) {
      if (event.defaultPrevented) return;
      if (programmatic) { programmatic = false; last = Math.max(0, scrollY); }
    }
    function jump() {
      programmatic = true;
      last = Math.max(0, scrollY);
      reveal();
    }
    function scrollEnd() {
      if (programmatic) { programmatic = false; last = Math.max(0, scrollY); }
    }
    function resize() {
      const nextOrientation = screen.orientation?.angle;
      // Safari's address bar changes height while scrolling. That is neither
      // a new gesture nor a new reading layout, so do not reset q or last Y.
      if (width !== innerWidth || orientation !== nextOrientation) {
        width = innerWidth; orientation = nextOrientation;
        last = Math.max(0, scrollY); programmatic = false;
        chrome.current?.setVisible(true, true);
      }
      schedule();
    }
    function layoutChange() {
      last = Math.max(0, scrollY);
      chrome.current?.setVisible(true, true);
    }
    function keys(event: KeyboardEvent) {
      if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
      userInput(event);
    }
    function revealFocus(event: FocusEvent) {
      if (event.target instanceof Element && event.target.closest("[data-reader-scroll-chrome]")) reveal();
    }
    const panels = new MutationObserver(records => {
      if (!records.some(record => record.target instanceof Element &&
        !record.target.closest("[data-glass-optics], [data-glass-optics-host]"))) return;
      if (protectedChrome()) { last = Math.max(0, scrollY); reveal(); }
    });
    panels.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["data-menu-open", "data-reader-route-pending", "data-card-pulling", "class", "open"] });
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("scrollend", scrollEnd);
    window.addEventListener("touchstart", userInput, { passive: true });
    window.addEventListener("wheel", userInput, { passive: true });
    window.addEventListener("keydown", keys);
    window.addEventListener("reading-navigation-jump", jump);
    window.addEventListener("reading-position-align", jump);
    window.addEventListener("resize", resize);
    visualViewport?.addEventListener("resize", resize);
    document.addEventListener("focusin", revealFocus);
    folded.addEventListener("change", layoutChange);
    reduced.addEventListener("change", layoutChange);
    return () => {
      cancelAnimationFrame(frame); panels.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("scrollend", scrollEnd);
      window.removeEventListener("touchstart", userInput);
      window.removeEventListener("wheel", userInput);
      window.removeEventListener("keydown", keys);
      window.removeEventListener("reading-navigation-jump", jump);
      window.removeEventListener("reading-position-align", jump);
      window.removeEventListener("resize", resize);
      visualViewport?.removeEventListener("resize", resize);
      document.removeEventListener("focusin", revealFocus);
      folded.removeEventListener("change", layoutChange);
      reduced.removeEventListener("change", layoutChange);
    };
  }, [pathname]);

  useEffect(() => {
    const cover = document.querySelector<HTMLElement>(".article-cover, .article-intro-cover");
    const image = cover?.querySelector<HTMLImageElement>(".source-image > img");
    if (!cover || !image) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let previous = -1;
    let sampledSource = "";
    const properties = ["--cover-hue", "--cover-blur", "--cover-image-y", "--cover-ambient-y"];
    // A real, non-interactive layer can also be sampled by the glass optics.
    const ambient = document.createElement("span");
    ambient.className = "reader-cover-ambient";
    ambient.setAttribute("aria-hidden", "true");
    cover.prepend(ambient);
    // Basic fading is CSS-only; this marker identifies the optional live effects.
    cover.dataset.readerCover = "";
    function sample() {
      if (!image!.complete || !image!.naturalWidth) return;
      const source = image!.currentSrc || image!.src;
      if (sampledSource === source) return;
      sampledSource = source;
      // A tiny, one-time lower-half sample preserves the image's ambient hue without
      // holding a full-resolution canvas or reading pixels during scrolling.
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 16;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      try {
        context.drawImage(image!, 0, image!.naturalHeight * .4, image!.naturalWidth, image!.naturalHeight * .6, 0, 0, 16, 16);
        const pixels = context.getImageData(0, 0, 16, 16).data;
        const buckets = new Map<string, { weight: number; r: number; g: number; b: number }>();
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] < 128) continue;
          const [r, g, b] = [pixels[index], pixels[index + 1], pixels[index + 2]];
          const key = `${r >> 5},${g >> 5},${b >> 5}`;
          const weight = 1 + (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
          const bucket = buckets.get(key) || { weight: 0, r: 0, g: 0, b: 0 };
          bucket.weight += weight; bucket.r += r * weight; bucket.g += g * weight; bucket.b += b * weight;
          buckets.set(key, bucket);
        }
        const dominant = [...buckets.values()].sort((a, b) => b.weight - a.weight)[0];
        if (dominant) cover!.style.setProperty("--cover-hue", `rgb(${Math.round(dominant.r / dominant.weight)} ${Math.round(dominant.g / dominant.weight)} ${Math.round(dominant.b / dominant.weight)})`);
      } catch {
        // External images without CORS keep the same fade with the theme surface.
        cover!.style.removeProperty("--cover-hue");
      }
      schedule();
    }
    function update() {
      frame = 0;
      const bounds = cover!.getBoundingClientRect();
      const height = Math.max(image!.offsetHeight, 1);
      const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-height")) || 56;
      const start = bounds.top + window.scrollY;
      const overlap = Math.max(0, Math.min(header, start) - bounds.top);
      const progress = !reduced.matches && bounds.bottom > -120 ? Math.min(1, overlap / (height * .8)) : 0;
      const rounded = Math.round(progress * 1000) / 1000;
      if (rounded === previous) return;
      previous = rounded;
      cover!.style.setProperty("--cover-blur", `${Math.round(18 * progress * 4) / 4}px`);
      cover!.style.setProperty("--cover-image-y", `${Math.round(Math.min(overlap, height) * (reduced.matches ? 0 : .16))}px`);
      cover!.style.setProperty("--cover-ambient-y", `${Math.round(Math.min(overlap, height) * (reduced.matches ? 0 : .28))}px`);
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(update); }
    const failed = () => { properties.forEach(property => cover!.style.removeProperty(property)); };
    sample();
    schedule();
    image.addEventListener("load", sample);
    image.addEventListener("error", failed);
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    reduced.addEventListener("change", schedule);
    return () => {
      cancelAnimationFrame(frame);
      ambient.remove();
      delete cover.dataset.readerCover;
      properties.forEach(property => cover.style.removeProperty(property));
      image.removeEventListener("load", sample);
      image.removeEventListener("error", failed);
      removeEventListener("scroll", schedule);
      removeEventListener("resize", schedule);
      reduced.removeEventListener("change", schedule);
    };
  }, [pathname]);

  return null;
}
