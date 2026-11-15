/** Interruptible reading jumps with one completion point for focus and saved position. */
export function scrollReadingTo(top: number, settled: (completed: boolean) => void) {
  const start = window.scrollY;
  const destination = Math.max(0, Math.min(top, document.documentElement.scrollHeight - innerHeight));
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;
  let finished = false;
  const finish = (completed: boolean) => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(frame);
    for (const event of ["pointerdown", "touchstart", "wheel", "popstate", "hashchange", "pagehide", "reading-navigation-jump"]) window.removeEventListener(event, cancel);
    window.removeEventListener("keydown", keydown);
    reduced.removeEventListener("change", motionChange);
    settled(completed);
  };
  const cancel = () => finish(false);
  const keydown = (event: KeyboardEvent) => {
    if (!event.defaultPrevented && ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " ", "Escape"].includes(event.key)) cancel();
  };
  const motionChange = () => {
    if (reduced.matches) { window.scrollTo({ top: destination, behavior: "instant" }); finish(true); }
  };
  if (reduced.matches || Math.abs(destination - start) < 1) {
    window.scrollTo({ top: destination, behavior: "instant" });
    finish(true);
    return cancel;
  }
  for (const event of ["pointerdown", "touchstart", "wheel", "popstate", "hashchange", "pagehide", "reading-navigation-jump"]) window.addEventListener(event, cancel, { passive: true });
  window.addEventListener("keydown", keydown);
  reduced.addEventListener("change", motionChange);
  const duration = Math.min(850, 400 + Math.sqrt(Math.abs(destination - start)) * 5);
  const started = performance.now();
  const tick = (now: number) => {
    const progress = Math.min(1, (now - started) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    window.scrollTo({ top: start + (destination - start) * eased, behavior: "instant" });
    if (progress < 1) frame = requestAnimationFrame(tick);
    else finish(true);
  };
  frame = requestAnimationFrame(tick);
  return cancel;
}
