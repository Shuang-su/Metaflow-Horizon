const selector = "[data-reader-toolbar-motion]";
const properties = ["--reader-chrome-q", "--reader-toolbar-exit", "--reader-toolbar-scale"];

/** The toolbar has no second clock. Its material host, capsule and glyphs all
 * inherit one motion container driven by the header's sampled q. */
export function paintReaderToolbarMotion(root: ParentNode, q: number, scale: number) {
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    const values = [String(q), String(1 - q), String(scale)];
    properties.forEach((property, index) => {
      if (element.style.getPropertyValue(property) !== values[index]) element.style.setProperty(property, values[index]);
    });
    const hidden = q <= .001;
    if (element.inert !== hidden) element.inert = hidden;
  }
}

export function clearReaderToolbarMotion(root: ParentNode) {
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    properties.forEach(property => element.style.removeProperty(property));
    element.inert = false;
  }
}
