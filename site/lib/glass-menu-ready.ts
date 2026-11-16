type Bounds = { left: number; top: number; width: number; height: number };

/** The original spring can cross the endpoint between display frames. An
 * outward overshoot already contains the content; do not wait for its second
 * passage through an artificial one-pixel equality window. */
export function glassMenuContainsContent(path: Bounds, content: Bounds) {
  return path.left <= content.left + 1 && path.top <= content.top + 1 &&
    path.left + path.width >= content.left + content.width - 1 &&
    path.top + path.height >= content.top + content.height - 1;
}
