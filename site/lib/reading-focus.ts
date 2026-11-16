/** Navigation focus announces the destination without styling a heading like a control. */
const releases = new WeakMap<HTMLElement, () => void>();
const interactive = "a[href], button, input, textarea, select, summary, [contenteditable=true], [role=button], [role=link], [role=slider]";

export function focusReadingTarget(target: HTMLElement | null, quiet = false) {
  if (!target?.isConnected) return;
  releases.get(target)?.();
  if (target.matches(interactive) && !quiet) {
    target.focus({ preventScroll: true });
    return;
  }
  const hadTabIndex = target.hasAttribute("tabindex");
  const needsTabIndex = !hadTabIndex && !target.matches(interactive);
  if (needsTabIndex) target.tabIndex = -1;
  target.dataset.readerFocusTarget = "";
  const release = () => {
    delete target.dataset.readerFocusTarget;
    if (needsTabIndex) target.removeAttribute("tabindex");
    target.removeEventListener("blur", release);
    target.removeEventListener("keydown", release);
    releases.delete(target);
  };
  releases.set(target, release);
  target.addEventListener("blur", release, { once: true });
  // A pointer-return keeps navigation focus for assistive technology without
  // a sticky touch outline. The next keyboard action restores the indicator.
  if (quiet) target.addEventListener("keydown", release, { once: true });
  target.focus({ preventScroll: true });
}
