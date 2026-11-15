import { animate } from "motion";

type SheetState = {
  position: number;
  height: number;
  animation?: ReturnType<typeof animate>;
  stopDrag?: () => void;
  release?: () => void;
};

const states = new WeakMap<HTMLElement, SheetState>();
const phone = () => matchMedia("(max-width: 767px)").matches;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function backdrop(sheet: HTMLElement) {
  return sheet.parentElement?.querySelector<HTMLElement>("[data-sheet-backdrop]") ||
    sheet.closest(".reading-navigator")?.querySelector<HTMLElement>(".reading-nav-backdrop");
}

function paint(sheet: HTMLElement, state: SheetState, position: number) {
  state.position = position;
  sheet.style.translate = `0 ${position}px`;
  const opacity = 1 - Math.max(0, Math.min(1, position / state.height));
  sheet.style.setProperty("--sheet-scrim", String(opacity * .46));
  const scrim = backdrop(sheet);
  scrim?.setAttribute("data-sheet-scrim-moving", "");
  scrim?.style.setProperty("opacity", String(opacity));
}

function clear(sheet: HTMLElement, state: SheetState) {
  state.animation?.stop();
  sheet.style.removeProperty("translate");
  sheet.style.removeProperty("--sheet-scrim");
  sheet.removeAttribute("data-sheet-moving");
  sheet.removeAttribute("data-sheet-closing");
  const scrim = backdrop(sheet);
  scrim?.style.removeProperty("opacity");
  scrim?.removeAttribute("data-sheet-scrim-moving");
  states.delete(sheet);
  state.release?.();
}

function stateFor(sheet: HTMLElement) {
  const existing = states.get(sheet);
  if (existing) return existing;
  const offset = parseFloat(getComputedStyle(sheet).translate.split(" ")[1] || "0") || 0;
  const state: SheetState = { position: offset, height: Math.max(1, sheet.getBoundingClientRect().height) };
  states.set(sheet, state);
  return state;
}

function mounted(sheet: HTMLElement) {
  return sheet.isConnected && (!(sheet instanceof HTMLDialogElement) || sheet.open);
}

export function closeReaderSheet(sheet: HTMLElement | null, close: () => void) {
  if (!sheet || reduced()) { close(); return; }
  if (sheet.hasAttribute("data-sheet-released")) { close(); return; }
  if (sheet.dataset.sheetClosing === "explicit" || sheet.dataset.sheetClosing === "popover") return;
  if (!phone()) {
    if (!sheet.matches("dialog[open]:is(.reader-dialog-share, .reader-dialog-discussion)") || !sheet.animate) {
      close();
      return;
    }
    const { opacity, translate } = getComputedStyle(sheet);
    sheet.dataset.sheetClosing = "popover";
    const exit = sheet.animate([{ opacity, translate }, { opacity: 0, translate: "0 6px" }], {
      duration: 150, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards",
    });
    exit.onfinish = () => {
      if (mounted(sheet)) close();
      delete sheet.dataset.sheetClosing;
      exit.cancel();
    };
    return;
  }
  const state = stateFor(sheet);
  sheet.dataset.sheetClosing = "explicit";
  state.stopDrag?.();
  state.animation?.stop();
  sheet.dataset.sheetMoved = "";
  sheet.dataset.sheetMoving = "";
  state.animation = animate(state.position, state.height + 16, {
    duration: .17, ease: [.25, .7, .4, 1],
    onUpdate: value => paint(sheet, state, value),
    onComplete: () => { clear(sheet, state); if (mounted(sheet)) close(); },
  });
}

export function installReaderSheetDrag() {
  type Drag = { sheet: HTMLElement; state: SheetState; pointer: number; start: number;
    offset: number; samples: { position: number; time: number }[] };
  let drag: Drag | null = null;
  const moving = new Set<HTMLElement>();

  function down(event: PointerEvent) {
    if (!phone() || reduced() || event.button !== 0 || !(event.target instanceof Element)) return;
    if (drag && event.pointerId !== drag.pointer) { finish(); return; }
    const handle = event.target.closest<HTMLElement>("[data-sheet-handle]");
    const sheet = handle?.closest<HTMLElement>("[data-sheet-drag]");
    if (!handle || !sheet || sheet.dataset.sheetClosing === "explicit" || !event.isPrimary || !handle.getClientRects().length ||
        !mounted(sheet) || sheet.closest("[inert]")) return;
    const topModal = [...document.querySelectorAll("dialog:modal")].at(-1);
    if (topModal && topModal !== sheet) return;
    const state = stateFor(sheet);
    state.animation?.stop();
    state.animation = undefined;
    // Re-grabbing a released sheet resumes from its painted position.
    delete sheet.dataset.sheetClosing;
    const pointer = event.pointerId;
    drag = { sheet, state, pointer, start: event.clientY, offset: state.position, samples: [] };
    state.stopDrag = () => {
      drag = null;
      delete state.stopDrag;
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
    };
    sheet.dataset.sheetMoved = "";
    sheet.dataset.sheetMoving = "";
    moving.add(sheet);
    state.release = () => { moving.delete(sheet); };
    paint(sheet, state, state.position);
    if (event.cancelable) event.preventDefault();
    handle.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (event.cancelable) event.preventDefault();
    const { sheet, state, start, offset, samples } = drag;
    const distance = offset + event.clientY - start;
    const position = distance >= 0 ? distance : -28 * (1 - Math.exp(distance / 100));
    paint(sheet, state, position);
    samples.push({ position, time: event.timeStamp });
    while (samples.length > 2 && event.timeStamp - samples[0].time > 95) samples.shift();
  }

  function finish(event?: PointerEvent) {
    if (!drag || (event && event.pointerId !== drag.pointer)) return;
    const { sheet, state, samples } = drag;
    state.stopDrag?.();
    const newest = samples.at(-1);
    const oldest = samples[0];
    const velocity = event?.type === "pointerup" && newest && oldest && event.timeStamp - newest.time < 80
      ? Math.max(-2000, Math.min(2000, (newest.position - oldest.position) * 1000 / Math.max(12, newest.time - oldest.time))) : 0;
    const threshold = Math.min(130, Math.max(64, state.height * .34));
    const projected = Math.max(0, Math.min(92, velocity * .10));
    const dismiss = event?.type === "pointerup" && state.position >= 32 && state.position + projected >= threshold;
    if (dismiss) sheet.dataset.sheetClosing = "spring";
    state.animation = animate(state.position, dismiss ? state.height + 16 : 0, {
      type: "spring", stiffness: 420, damping: 36, velocity,
      onUpdate: value => paint(sheet, state, value),
      onComplete: () => {
        clear(sheet, state);
        if (dismiss && mounted(sheet)) {
          sheet.dataset.sheetReleased = "";
          sheet.querySelector<HTMLButtonElement>("[data-sheet-close]")?.click();
          delete sheet.dataset.sheetReleased;
        }
      },
    });
  }

  function reset() {
    drag?.state.stopDrag?.();
    for (const sheet of moving) {
      const state = states.get(sheet);
      if (state && sheet.dataset.sheetClosing !== "explicit") clear(sheet, state);
    }
    moving.clear();
  }

  document.addEventListener("pointerdown", down);
  document.addEventListener("pointermove", move, { passive: false });
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
  document.addEventListener("lostpointercapture", finish);
  window.addEventListener("resize", reset);
  return () => {
    reset();
    document.removeEventListener("pointerdown", down);
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", finish);
    document.removeEventListener("lostpointercapture", finish);
    window.removeEventListener("resize", reset);
  };
}
