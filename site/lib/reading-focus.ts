/** Navigation focus announces the destination without styling a heading like a control. */
const releases = new WeakMap<HTMLElement, () => void>();
const interactive = "a[href], button, input, textarea, select, summary, [contenteditable=true], [role=button], [role=link], [role=slider]";

export function focusReadingTarget(target: HTMLElement | null) {
  if (!target?.isConnected) return;
  if (target.matches(interactive)) {
    target.focus({ preventScroll: true });
    return;
  }
  releases.get(target)?.();
  const hadTabIndex = target.hasAttribute("tabindex");
  if (!hadTabIndex) target.tabIndex = -1;
  target.dataset.readerFocusTarget = "";
  const release = () => {
    delete target.dataset.readerFocusTarget;
    if (!hadTabIndex) target.removeAttribute("tabindex");
    target.removeEventListener("blur", release);
    releases.delete(target);
  };
  releases.set(target, release);
  target.addEventListener("blur", release, { once: true });
  target.focus({ preventScroll: true });
}
