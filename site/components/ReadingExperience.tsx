"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { installReaderSheetDrag } from "../lib/reader-sheet";

export default function ReadingExperience() {
  const pathname = usePathname();
  useEffect(installReaderSheetDrag, []);
  useEffect(() => {
    if (!document.querySelector("[data-reader-article]")) return;
    const root = document.documentElement;
    const phone = matchMedia("(max-width: 767px)");
    const folded = matchMedia("(vertical-viewport-segments: 2)");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let last = window.scrollY;
    let distance = 0;
    let touchScrolling = false;
    let inputUntil = 0;
    function reveal() {
      delete root.dataset.readerControlsHidden;
      distance = 0;
    }
    function update() {
      frame = 0;
      const y = Math.max(0, window.scrollY);
      const delta = y - last;
      last = y;
      if (!phone.matches || folded.matches || y <= 64) {
        reveal();
        return;
      }
      if (performance.now() > inputUntil || Math.abs(delta) < 1) return;
      if (document.querySelector("[data-reader-route-pending], main[data-card-pulling], .reader-header[data-menu-open=true], #reader-font-panel, .reading-navigator.is-open, dialog[open]")
        || document.activeElement?.matches("[data-reader-scroll-chrome] :focus-visible")) {
        distance = 0;
        return;
      }
      if (Math.sign(distance) !== Math.sign(delta)) distance = 0;
      distance += delta;
      if (distance < -14) reveal();
      else if (distance > 38 && y > 104) root.dataset.readerControlsHidden = "";
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }
    function markInput(event: Event) {
      if (event.defaultPrevented || (event.target instanceof Element &&
        event.target.closest(".site-header, dialog, .article-interaction-wrap, .reading-nav-panel"))) return;
      inputUntil = performance.now() + 1100;
      if (event.type === "touchmove") touchScrolling = true;
    }
    function endInput() {
      if (touchScrolling) inputUntil = performance.now() + 1100;
      touchScrolling = false;
    }
    function resetInput() {
      inputUntil = 0;
      touchScrolling = false;
      last = window.scrollY;
      distance = 0;
    }
    function reset() {
      resetInput();
      reveal();
    }
    function keys(event: KeyboardEvent) {
      if (event.defaultPrevented || !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
      markInput(event);
    }
    function revealFocus(event: FocusEvent) {
      if (event.target instanceof Element && event.target.closest("[data-reader-scroll-chrome]")) reveal();
    }
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("touchstart", resetInput, { passive: true });
    window.addEventListener("touchmove", markInput, { passive: true });
    window.addEventListener("touchend", endInput, { passive: true });
    window.addEventListener("touchcancel", endInput, { passive: true });
    window.addEventListener("wheel", markInput, { passive: true });
    window.addEventListener("keydown", keys);
    window.addEventListener("reading-navigation-jump", reset);
    window.addEventListener("resize", reset);
    document.addEventListener("focusin", revealFocus);
    reduced.addEventListener("change", reset);
    return () => {
      cancelAnimationFrame(frame);
      reveal();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("touchstart", resetInput);
      window.removeEventListener("touchmove", markInput);
      window.removeEventListener("touchend", endInput);
      window.removeEventListener("touchcancel", endInput);
      window.removeEventListener("wheel", markInput);
      window.removeEventListener("keydown", keys);
      window.removeEventListener("reading-navigation-jump", reset);
      window.removeEventListener("resize", reset);
      document.removeEventListener("focusin", revealFocus);
      reduced.removeEventListener("change", reset);
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
      cover!.dataset.readerCover = "";
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
    const failed = () => { delete cover!.dataset.readerCover; properties.forEach(property => cover!.style.removeProperty(property)); };
    sample();
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
