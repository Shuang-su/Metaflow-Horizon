/** Opt-in, local diagnostics. Nothing is installed or recorded on ordinary pages. */
export type GlassTraceEvent = { sequence: number; name: string; at: number; absoluteTime: number; detail: Record<string, unknown> };
const query = typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search);
const enabled = query.has("glassDiagnostics");
const cold = enabled && query.get("glassCold") === "1";
const events: GlassTraceEvent[] = [];
const limit = 8000;
let sequence = 0, dropped = 0;
export const glassDiagnosticsEnabled = () => enabled;
export const glassColdStart = () => cold;
export function traceGlass(name: string, detail: Record<string, unknown> = {}, at = performance.now()) {
  if (!enabled) return;
  if (events.length === limit) { events.splice(0, 1000); dropped += 1000; }
  events.push({ sequence: ++sequence, name, at, absoluteTime: performance.timeOrigin + at, detail });
}
export function readGlassTrace() {
  return { timeOrigin: performance.timeOrigin, cold, dropped, events: events.slice() };
}
export function startGlassDiagnostics() {
  if (!enabled) return () => {};
  traceGlass("session", { cold, userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
    visibility: document.visibilityState, networkCache: "not-cleared", gpuProcess: "not-reset" });
  const observers: PerformanceObserver[] = [];
  for (const type of ["longtask", "long-animation-frame"]) {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) { traceGlass("unsupported", { type }); continue; }
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const detail = entry.toJSON();
        const scripts = (entry as PerformanceEntry & { scripts?: { toJSON?: () => unknown }[] }).scripts;
        if (scripts) detail.scripts = Array.from(scripts, script => script.toJSON?.() ?? {});
        traceGlass(type, detail, entry.startTime);
      }
    });
    observer.observe({ type, buffered: true }); observers.push(observer);
  }
  const visibility = () => traceGlass("visibility", { state: document.visibilityState });
  const plan = (event: Event) => {
    const message = (event as CustomEvent<{ name: string; detail: Record<string, unknown> }>).detail;
    traceGlass(message.name, message.detail);
  };
  const input = (event: Event) => {
    if (event.target instanceof Element && event.target.closest("#reader-font-trigger, #reader-font-panel, #header-menu-trigger, .reader-more-menu")) {
      const pointer = event as PointerEvent;
      traceGlass(event.type, { target: event.target.closest("[id]")?.id, pointerType: pointer.pointerType });
    }
  };
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("glass-plan-trace", plan);
  for (const name of ["pointerdown", "pointerup", "click", "glass:entered"]) document.addEventListener(name, input, true);
  return () => {
    observers.forEach(observer => observer.disconnect());
    document.removeEventListener("visibilitychange", visibility);
    document.removeEventListener("glass-plan-trace", plan);
    for (const name of ["pointerdown", "pointerup", "click", "glass:entered"]) document.removeEventListener(name, input, true);
  };
}
