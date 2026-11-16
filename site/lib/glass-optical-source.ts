export type OpticalBox = { left: number; top: number; width: number; height: number };

const excluded = "script, style, link, svg, iframe, object, embed, canvas, audio, video, dialog, [data-glass-surface], [data-glass-optics], [data-no-optical-source]";
const typeStyles = ["font", "font-kerning", "font-variant", "font-feature-settings", "font-optical-sizing", "letter-spacing", "line-height", "text-align", "text-decoration", "text-indent", "text-transform", "text-wrap", "white-space", "word-break", "overflow-wrap", "direction", "color"];
const boxStyles = ["background-color", "background-image", "background-size", "background-position", "background-repeat", "border-radius", "border", "padding", "object-fit", "object-position", "overflow", "opacity", "box-sizing"];
const maskStyles = ["mask-image", "mask-mode", "mask-size", "mask-position", "mask-repeat", "mask-origin", "mask-clip", "mask-composite",
  "-webkit-mask-image", "-webkit-mask-size", "-webkit-mask-position", "-webkit-mask-repeat", "-webkit-mask-origin", "-webkit-mask-clip", "-webkit-mask-composite"];
function hasMask(style: CSSStyleDeclaration) {
  return ["mask-image", "-webkit-mask-image"].some(property => {
    const value = style.getPropertyValue(property);
    return value && value !== "none";
  });
}
const leaf = "p, h1, h2, h3, h4, h5, h6, pre, figcaption, dt, dd, blockquote, td, th, li";
const maxPieces = 96;

export function intersectsOpticalBox(a: OpticalBox, b: OpticalBox) {
  return a.width > 0 && a.height > 0 && a.left < b.left + b.width && a.left + a.width > b.left &&
    a.top < b.top + b.height && a.top + a.height > b.top;
}

/** Overflow-visible tracks (including Swiper's translated wrapper) can have
 * visible descendants outside their own box. Only clipping ancestors narrow
 * the area in which descendants can paint. */
export function opticalChildClip(clip: OpticalBox, box: OpticalBox, overflowX: string, overflowY: string): OpticalBox {
  const clips = (value: string) => /^(hidden|clip|scroll|auto)$/.test(value);
  const left = clips(overflowX) ? Math.max(clip.left, box.left) : clip.left;
  const top = clips(overflowY) ? Math.max(clip.top, box.top) : clip.top;
  const right = clips(overflowX) ? Math.min(clip.left + clip.width, box.left + box.width) : clip.left + clip.width;
  const bottom = clips(overflowY) ? Math.min(clip.top + clip.height, box.top + box.height) : clip.top + clip.height;
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function copyStyles(source: CSSStyleDeclaration, target: HTMLElement, properties: readonly string[]) {
  for (const property of properties) target.style.setProperty(property, source.getPropertyValue(property));
}

function inlineCopy(source: Node): Node | null {
  if (source.nodeType === Node.TEXT_NODE) return source.cloneNode();
  if (!(source instanceof HTMLElement) || source.matches(excluded)) return null;
  if (source instanceof HTMLImageElement) {
    const image = document.createElement("img");
    image.alt = "";
    image.src = source.currentSrc || source.src;
    copyStyles(getComputedStyle(source), image, [...typeStyles, ...boxStyles, ...maskStyles, "width", "height", "vertical-align"]);
    return image;
  }
  const tag = ["BR", "WBR"].includes(source.tagName) ? source.tagName : "span";
  const copy = document.createElement(tag);
  copyStyles(getComputedStyle(source), copy, [...typeStyles, "display", "vertical-align"]);
  for (const child of source.childNodes) {
    const clone = inlineCopy(child);
    if (clone) copy.append(clone);
  }
  return copy;
}

type Piece = { node: HTMLElement; width: number; height: number; backgroundOnly: boolean };
type Group = { node: HTMLElement; displayed: HTMLElement[] };
type Frame = { group: Group; children: HTMLElement[]; left: number; top: number; scaleX: number; scaleY: number };

function layoutBox(source: HTMLElement, rect: DOMRect, style: CSSStyleDeclaration) {
  const borderBox = style.boxSizing === "border-box";
  const px = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
  const width = px("width") + (borderBox ? 0 : px("padding-left") + px("padding-right") + px("border-left-width") + px("border-right-width")) || source.offsetWidth || rect.width;
  const height = px("height") + (borderBox ? 0 : px("padding-top") + px("padding-bottom") + px("border-top-width") + px("border-bottom-width")) || source.offsetHeight || rect.height;
  return { width, height, scaleX: width ? rect.width / width : 1, scaleY: height ? rect.height / height : 1 };
}

function placement(rect: DOMRect, scaleX: number, scaleY: number, parent: Frame) {
  return `translate(${(rect.left - parent.left) / parent.scaleX}px, ${(rect.top - parent.top) / parent.scaleY}px) scale(${scaleX / parent.scaleX}, ${scaleY / parent.scaleY})`;
}

/** Uses real HTML layout for the visible source pieces. The replica contains
 * no original attributes, links, handlers, or interactive elements. */
export class OpticalSource {
  private pieces = new Map<HTMLElement, Piece>();
  private groups = new Map<HTMLElement, Group>();
  private displayed: HTMLElement[] = [];
  private textCount = 0;

  get visibleTextCount() { return this.textCount; }

  clear() {
    this.pieces.clear();
    this.groups.clear();
    this.displayed = [];
    this.textCount = 0;
    this.layer.replaceChildren();
  }

  constructor(private layer: HTMLElement) {}

  update(roots: HTMLElement[], region: OpticalBox, refresh = false) {
    const visible: HTMLElement[] = [];
    let textCount = 0;
    const active = new Set<HTMLElement>();
    const activeGroups = new Set<HTMLElement>();
    const root: Frame = { group: { node: this.layer, displayed: this.displayed }, children: [],
      left: region.left, top: region.top, scaleX: 1, scaleY: 1 };
    const frames: Frame[] = [root];
    const effectGroup = (source: HTMLElement, rect: DOMRect, style: CSSStyleDeclaration, parent: Frame) => {
      let group = this.groups.get(source);
      if (!group) {
        const node = document.createElement("div");
        Object.assign(node.style, { position: "absolute", left: "0", top: "0", margin: "0", padding: "0",
          border: "0", boxSizing: "border-box", transformOrigin: "0 0", pointerEvents: "none" });
        group = { node, displayed: [] };
        this.groups.set(source, group);
      }
      const { width, height, scaleX, scaleY } = layoutBox(source, rect, style);
      const values = { width: `${width}px`, height: `${height}px`, transform: placement(rect, scaleX, scaleY, parent),
        opacity: style.opacity, filter: style.filter, clipPath: style.clipPath };
      for (const [key, value] of Object.entries(values)) {
        const property = key as keyof typeof values;
        if (group.node.style[property] !== value) group.node.style[property] = value;
      }
      // Keep ancestor masks on their own sized coordinate system. A stable
      // cover wrapper can mask its independently blurred/transformed image.
      copyStyles(style, group.node, maskStyles);
      activeGroups.add(source);
      const frame = { group, children: [], left: rect.left, top: rect.top, scaleX, scaleY };
      frames.push(frame);
      return frame;
    };
    const add = (source: HTMLElement, rect: DOMRect, style: CSSStyleDeclaration, backgroundOnly: boolean, clip: OpticalBox, parent: Frame) => {
      const { width, height, scaleX: scale, scaleY } = layoutBox(source, rect, style);
      let entry = this.pieces.get(source);
      const existing = entry && entry.backgroundOnly === backgroundOnly ? entry : undefined;
      if (!existing || existing.width !== width || existing.height !== height || refresh) {
        const node = existing?.node ?? document.createElement(source instanceof HTMLImageElement ? "img" : "div");
        copyStyles(style, node, [...typeStyles, ...boxStyles]);
        if (node instanceof HTMLImageElement && source instanceof HTMLImageElement) {
          node.alt = "";
          const url = source.currentSrc || source.src;
          if (node.src !== url) node.src = url;
        } else if (!backgroundOnly) {
          const fragments = [];
          for (const child of source.childNodes) {
            const clone = inlineCopy(child);
            if (clone) fragments.push(clone);
          }
          node.replaceChildren(...fragments);
        }
        Object.assign(node.style, { position: "absolute", left: "0", top: "0", boxSizing: "border-box",
          width: `${width}px`, height: `${height}px`, maxWidth: "none", maxHeight: "none", transformOrigin: "0 0" });
        entry = { node, width, height, backgroundOnly };
        this.pieces.set(source, entry);
      }
      if (!entry) return;
      const transform = placement(rect, scale, scaleY, parent);
      if (entry.node.style.transform !== transform) entry.node.style.transform = transform;
      // A source's own effects belong to its group, once for the composited
      // descendants, rather than being multiplied onto each flattened piece.
      if (entry.node.style.opacity !== "1") entry.node.style.opacity = "1";
      if (entry.node.style.filter !== "none") entry.node.style.filter = "none";
      if (entry.node.style.maskImage !== "none") entry.node.style.maskImage = "none";
      if (entry.node.style.webkitMaskImage !== "none") entry.node.style.webkitMaskImage = "none";
      // Rectangular overflow clipping still prunes neighbouring slides. Actual
      // clip-paths stay on their sized groups, including calc() and round radii.
      const inset = (value: number, ratio: number) => `${Math.max(0, value / (ratio || 1)).toFixed(3)}px`;
      const clipPath = `inset(${inset(clip.top - rect.top, scaleY)} ${inset(rect.right - clip.left - clip.width, scale)} ${inset(rect.bottom - clip.top - clip.height, scaleY)} ${inset(clip.left - rect.left, scale)})`;
      if (entry.node.style.clipPath !== clipPath) entry.node.style.clipPath = clipPath;
      visible.push(entry.node);
      parent.children.push(entry.node);
      if (!backgroundOnly && entry.node.textContent?.trim()) textCount++;
      active.add(source);
    };
    const visit = (node: HTMLElement, clip: OpticalBox, parent: Frame) => {
      if (visible.length >= maxPieces || clip.width <= 0 || clip.height <= 0 || node.matches(excluded)) return;
      const rect = node.getBoundingClientRect();
      const intersects = intersectsOpticalBox(rect, clip);
      if (!intersects) {
        if (!node.children.length) return;
        // Ordinary article sections can be pruned as a whole. Only the
        // translated slide track, overhanging date badge and cover's ambient
        // tail have visible descendants outside their box. Contents has no box.
        const overflowSource = node.matches(".home-carousel > .swiper-wrapper, .home-slide-visual, :is(.article-cover, .article-intro-cover)[data-reader-cover]");
        if (!overflowSource && (rect.width || rect.height || getComputedStyle(node).display !== "contents")) return;
      }
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) <= .01) return;
      // Keep only effect-bearing ancestors. The normal document stays flat and
      // only visible pieces are cloned; ordinary offscreen branches stay pruned.
      const grouped = style.display !== "contents" && rect.width > 0 && rect.height > 0 &&
        (Number(style.opacity) < 1 || style.filter !== "none" || style.clipPath !== "none" || hasMask(style));
      const frame = grouped ? effectGroup(node, rect, style, parent) : parent;
      const text = Array.from(node.childNodes).some(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim());
      const hasBlockChildren = node.querySelector(":scope > p, :scope > li, :scope > ul, :scope > ol, :scope > div");
      const isLeaf = node instanceof HTMLImageElement || ((node.matches(leaf) || text) && !hasBlockChildren);
      if (intersects && (isLeaf || style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.backgroundImage !== "none"))
        add(node, rect, style, !isLeaf, clip, frame);
      const childClip = style.display === "contents" ? clip : opticalChildClip(clip, rect, style.overflowX, style.overflowY);
      if (!isLeaf) for (const child of node.children) if (child instanceof HTMLElement) visit(child, childClip, frame);
      if (grouped && frame.children.length) parent.children.push(frame.group.node);
    };
    for (const source of roots) visit(source, region, root);
    for (const node of this.pieces.keys()) if (!active.has(node)) this.pieces.delete(node);
    for (const node of this.groups.keys()) if (!activeGroups.has(node)) this.groups.delete(node);
    for (const { group, children } of frames) {
      if (children.length !== group.displayed.length || children.some((node, index) => node !== group.displayed[index])) {
        group.node.replaceChildren(...children);
        group.displayed = children;
      }
    }
    this.displayed = root.children;
    this.textCount = textCount;
    return visible.length;
  }
}
