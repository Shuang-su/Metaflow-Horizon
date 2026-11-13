// Blur the old content before changing it, then bring the new content into focus.
const transitions = new WeakMap<Element, Animation>();
const soft = { filter: "blur(5px)", opacity: .62 };
const clear = { filter: "blur(0px)", opacity: 1 };

export function transitionContent(surface: Element | null, update: () => void, animated = true) {
  if (!surface) { update(); return; }

  const previous = transitions.get(surface);
  if (!animated || matchMedia("(prefers-reduced-motion: reduce)").matches || !surface.animate) {
    previous?.cancel();
    transitions.delete(surface);
    update();
    return;
  }

  const style = previous && getComputedStyle(surface);
  const start = style ? { filter: style.filter, opacity: Number(style.opacity) } : clear;
  previous?.cancel();
  const exit = surface.animate([start, soft], { duration: 90, easing: "ease-in", fill: "forwards" });
  transitions.set(surface, exit);
  exit.onfinish = () => {
    if (transitions.get(surface) !== exit) return;
    update();
    const enter = surface.animate([soft, clear], { duration: 180, easing: "ease-out" });
    transitions.set(surface, enter);
    exit.cancel();
    enter.onfinish = () => {
      if (transitions.get(surface) === enter) transitions.delete(surface);
    };
  };
}
