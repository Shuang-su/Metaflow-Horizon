"use client";

import { useSyncExternalStore } from "react";

const key = "gsd-carousel-autoplay";
const changed = "gsd-carousel-autoplay-change";
let fallback = true;

function read() {
  try { return localStorage.getItem(key) !== "off"; }
  catch { return fallback; }
}

function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) listener(); };
  window.addEventListener("storage", storage);
  window.addEventListener(changed, listener);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(changed, listener);
  };
}

export function setCarouselAutoplay(enabled: boolean) {
  fallback = enabled;
  try { localStorage.setItem(key, enabled ? "on" : "off"); } catch {}
  window.dispatchEvent(new Event(changed));
}

export function useCarouselAutoplay() {
  return useSyncExternalStore(subscribe, read, () => true);
}
