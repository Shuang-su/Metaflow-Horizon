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
      if (event.target instanceof Element && event.target.closest(".site-header, dialog, .article-interaction-wrap, .reading-nav-panel")) return;
      inputUntil = performance.now() + 1100;
      if (event.type === "touchmove") touchScrolling = true;
    }
    function endInput() {
      if (touchScrolling) inputUntil = performance.now() + 1100;
      touchScrolling = false;
    }
    function reset() {
      inputUntil = 0;
      touchScrolling = false;
      last = window.scrollY;
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
    const image = cover?.querySelector<HTMLElement>(".source-image > img");
    if (!cover || !image) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let previous = -1;
    function update() {
      frame = 0;
      const bounds = image!.getBoundingClientRect();
      const height = Math.max(bounds.height, 1);
      const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-height")) || 56;
      const coverStart = bounds.top + window.scrollY;
      const overlap = Math.min(top, coverStart) - bounds.top;
      const progress = !reduced.matches && bounds.bottom > 0
        ? Math.min(1, Math.max(0, overlap / (height * .8))) : 0;
      const blur = Math.round(14 * progress * 4) / 4;
      if (blur !== previous) {
        image!.style.filter = blur > 0 ? `blur(${blur}px)` : "";
        previous = blur;
      }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    schedule();
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    reduced.addEventListener("change", schedule);
    return () => {
      cancelAnimationFrame(frame);
      image.style.removeProperty("filter");
      removeEventListener("scroll", schedule);
      removeEventListener("resize", schedule);
      reduced.removeEventListener("change", schedule);
    };
  }, [pathname]);
  return null;
}
