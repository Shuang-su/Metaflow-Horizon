export type OpticalBox = { left: number; top: number; width: number; height: number };
type OpticalRect = OpticalBox & { right: number; bottom: number };

const excluded = "script, style, link, svg, iframe, object, embed, canvas, audio, video, dialog, [data-glass-surface], [data-glass-optics], [data-no-optical-source]";
const typeStyles = ["font", "font-kerning", "font-variant", "font-feature-settings", "font-optical-sizing", "letter-spacing", "line-height", "text-align", "text-decoration", "text-indent", "text-transform", "text-wrap", "white-space", "word-break", "overflow-wrap", "direction", "color"];
const boxStyles = ["background-color", "background-image", "background-size", "background-position", "background-repeat", "border-radius", "border", "padding", "object-fit", "object-position", "overflow", "box-sizing"];
const maskStyles = ["mask-image", "mask-mode", "mask-size", "mask-position", "mask-repeat", "mask-origin", "mask-clip", "mask-composite",
  "-webkit-mask-image", "-webkit-mask-size", "-webkit-mask-position", "-webkit-mask-repeat", "-webkit-mask-origin", "-webkit-mask-clip", "-webkit-mask-composite"];
const layoutStyles = ["width", "height", "padding-left", "padding-right", "padding-top", "padding-bottom", "border-left-width", "border-right-width", "border-top-width", "border-bottom-width"];
const sampledStyles = [...new Set([...typeStyles, ...boxStyles, ...maskStyles, ...layoutStyles,
  "display", "visibility", "opacity", "filter", "clip-path", "overflow-x", "overflow-y", "vertical-align"])];
type FrozenStyle = Readonly<Record<string, string>>;
const leaf = "p, h1, h2, h3, h4, h5, h6, pre, figcaption, dt, dd, blockquote, td, th, li";
const overflowSources = ".home-carousel > .swiper-wrapper, .home-slide-visual, :is(.article-cover, .article-intro-cover)[data-reader-cover]";
const maxPieces = 96;

export function intersectsOpticalBox(a: OpticalBox, b: OpticalBox) {
  return a.width > 0 && a.height > 0 && a.left < b.left + b.width && a.left + a.width > b.left &&
    a.top < b.top + b.height && a.top + a.height > b.top;
}

/** Overflow-visible tracks can paint children outside their own translated box. */
export function opticalChildClip(clip: OpticalBox, box: OpticalBox, overflowX: string, overflowY: string): OpticalBox {
  const clips = (value: string) => /^(hidden|clip|scroll|auto)$/.test(value);
  const left = clips(overflowX) ? Math.max(clip.left, box.left) : clip.left;
  const top = clips(overflowY) ? Math.max(clip.top, box.top) : clip.top;
  const right = clips(overflowX) ? Math.min(clip.left + clip.width, box.left + box.width) : clip.left + clip.width;
  const bottom = clips(overflowY) ? Math.min(clip.top + clip.height, box.top + box.height) : clip.top + clip.height;
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
function hasMask(style: FrozenStyle) {
  return ["mask-image", "-webkit-mask-image"].some(property => style[property] && style[property] !== "none");
}
function copyStyles(source: FrozenStyle, target: HTMLElement, properties: readonly string[]) {
  for (const property of properties) {
    const value = source[property];
    if (target.style.getPropertyValue(property) !== value) target.style.setProperty(property, value);
  }
}
type InlineSnapshot = { kind: "text"; text: string } | {
  kind: "element"; tag: string; style: FrozenStyle; imageUrl?: string; children: readonly InlineSnapshot[];
};
function inlineCopy(source: InlineSnapshot): Node {
  if (source.kind === "text") return document.createTextNode(source.text);
  const copy = document.createElement(source.tag);
  if (source.imageUrl !== undefined) {
    (copy as HTMLImageElement).alt = "";
    (copy as HTMLImageElement).src = source.imageUrl;
    copyStyles(source.style, copy, [...typeStyles, ...boxStyles, ...maskStyles, "width", "height", "vertical-align"]);
  } else {
    copyStyles(source.style, copy, [...typeStyles, "display", "vertical-align"]);
    for (const child of source.children) copy.append(inlineCopy(child));
  }
  return copy;
}
type Layout = { width: number; height: number; scaleX: number; scaleY: number };
function layoutBox(source: HTMLElement, rect: OpticalRect, style: FrozenStyle): Layout {
  const borderBox = style["box-sizing"] === "border-box";
  const px = (name: string) => parseFloat(style[name]) || 0;
  const width = px("width") + (borderBox ? 0 : px("padding-left") + px("padding-right") + px("border-left-width") + px("border-right-width")) || source.offsetWidth || rect.width;
  const height = px("height") + (borderBox ? 0 : px("padding-top") + px("padding-bottom") + px("border-top-width") + px("border-bottom-width")) || source.offsetHeight || rect.height;
  return { width, height, scaleX: width ? rect.width / width : 1, scaleY: height ? rect.height / height : 1 };
}
type CapturedSource = {
  source: HTMLElement; rect: OpticalRect; style: FrozenStyle; layout: Layout;
  grouped: boolean; isLeaf: boolean; imageUrl?: string; inline: readonly InlineSnapshot[]; hasText: boolean;
};
type CapturedNode = { data: CapturedSource; clip: OpticalBox; piece: boolean; children: CapturedNode[] };
type RegionPlan = { region: OpticalBox; nodes: CapturedNode[] };
/** One short-lived read phase. Plans stay separate, so the gaps between lenses
 * never expand the sampled region. Each plan has its own 96-piece budget. */
export type OpticalFrameSnapshot = { readonly roots: readonly HTMLElement[]; readonly plans: readonly RegionPlan[] };
const sameBox = (a: OpticalBox, b: OpticalBox) => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

export function createOpticalFrame(roots: readonly HTMLElement[], regions: readonly OpticalBox[]): OpticalFrameSnapshot {
  const boxes = new Map<HTMLElement, OpticalRect>();
  const styles = new Map<HTMLElement, FrozenStyle>();
  const exclusions = new Map<HTMLElement, boolean>();
  const overflow = new Map<HTMLElement, boolean>();
  const children = new Map<HTMLElement, HTMLElement[]>();
  const sources = new Map<HTMLElement, CapturedSource>();
  const inlines = new Map<Node, InlineSnapshot | null>();
  const isExcluded = (node: HTMLElement) => {
    if (!exclusions.has(node)) exclusions.set(node, node.matches(excluded));
    return exclusions.get(node)!;
  };
  const styleOf = (node: HTMLElement) => {
    let style = styles.get(node);
    if (!style) {
      const computed = getComputedStyle(node);
      // ComputedStyle is live: freeze all values during the read phase, before
      // any lens writes its replica tree or triggers a new browser layout.
      style = Object.fromEntries(sampledStyles.map(property => [property, computed.getPropertyValue(property)]));
      styles.set(node, style);
    }
    return style;
  };
  const inlineOf = (node: Node): InlineSnapshot | null => {
    if (inlines.has(node)) return inlines.get(node)!;
    let value: InlineSnapshot | null = null;
    if (node.nodeType === Node.TEXT_NODE) value = { kind: "text", text: node.textContent || "" };
    else if (node instanceof HTMLElement && !isExcluded(node)) {
      const image = node instanceof HTMLImageElement;
      value = { kind: "element", tag: image ? "img" : ["BR", "WBR"].includes(node.tagName) ? node.tagName : "span",
        style: styleOf(node), ...(image ? { imageUrl: node.currentSrc || node.src } : {}),
        children: image ? [] : Array.from(node.childNodes).flatMap(child => { const part = inlineOf(child); return part ? [part] : []; }) };
    }
    inlines.set(node, value);
    return value;
  };
  const sourceOf = (node: HTMLElement, rect: OpticalRect, style: FrozenStyle) => {
    let data = sources.get(node);
    if (!data) {
      const childNodes = Array.from(node.childNodes);
      const text = childNodes.some(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim());
      const hasBlockChildren = node.querySelector(":scope > p, :scope > li, :scope > ul, :scope > ol, :scope > div");
      const image = node instanceof HTMLImageElement;
      const isLeaf = image || ((node.matches(leaf) || text) && !hasBlockChildren);
      data = { source: node, rect, style, layout: layoutBox(node, rect, style), isLeaf,
        grouped: style.display !== "contents" && rect.width > 0 && rect.height > 0 &&
          (Number(style.opacity) < 1 || style.filter !== "none" || style["clip-path"] !== "none" || hasMask(style)),
        ...(image ? { imageUrl: node.currentSrc || node.src } : {}),
        inline: isLeaf && !image ? childNodes.flatMap(child => { const part = inlineOf(child); return part ? [part] : []; }) : [],
        hasText: isLeaf && Boolean(node.textContent?.trim()) };
      sources.set(node, data);
    }
    return data;
  };
  const plans: RegionPlan[] = [];
  for (const region of regions) {
    if (plans.some(plan => sameBox(plan.region, region))) continue;
    let pieces = 0;
    const visit = (node: HTMLElement, clip: OpticalBox): CapturedNode | null => {
      if (pieces >= maxPieces || clip.width <= 0 || clip.height <= 0 || isExcluded(node)) return null;
      let rect = boxes.get(node);
      if (!rect) {
        const measured = node.getBoundingClientRect();
        rect = { left: measured.left, top: measured.top, width: measured.width, height: measured.height,
          right: measured.left + measured.width, bottom: measured.top + measured.height };
        boxes.set(node, rect);
      }
      const intersects = intersectsOpticalBox(rect, clip);
      if (!intersects) {
        if (!node.children.length) return null;
        if (!overflow.has(node)) overflow.set(node, node.matches(overflowSources));
        if (!overflow.get(node) && (rect.width || rect.height || styleOf(node).display !== "contents")) return null;
      }
      const style = styleOf(node);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) <= .01) return null;
      const data = sourceOf(node, rect, style);
      const piece = intersects && (data.isLeaf || style["background-color"] !== "rgba(0, 0, 0, 0)" || style["background-image"] !== "none");
      if (piece) pieces++;
      const result: CapturedNode = { data, clip: { ...clip }, piece, children: [] };
      if (!data.isLeaf) {
        const childClip = style.display === "contents" ? clip : opticalChildClip(clip, rect, style["overflow-x"], style["overflow-y"]);
        if (!children.has(node)) children.set(node, Array.from(node.children).filter((child): child is HTMLElement => child instanceof HTMLElement));
        for (const child of children.get(node)!) {
          if (pieces >= maxPieces) break;
          const collected = visit(child, childClip);
          if (collected) result.children.push(collected);
        }
      }
      return piece || result.children.length ? result : null;
    };
    plans.push({ region: { ...region }, nodes: roots.flatMap(source => { const node = visit(source, region); return node ? [node] : []; }) });
  }
  return { roots: [...roots], plans };
}

type Piece = { node: HTMLElement; width: number; height: number; backgroundOnly: boolean };
type Group = { node: HTMLElement; displayed: HTMLElement[] };
type Frame = { group: Group; children: HTMLElement[]; left: number; top: number; scaleX: number; scaleY: number };
function placement(rect: OpticalRect, scaleX: number, scaleY: number, parent: Frame) {
  return `translate(${(rect.left - parent.left) / parent.scaleX}px, ${(rect.top - parent.top) / parent.scaleY}px) scale(${scaleX / parent.scaleX}, ${scaleY / parent.scaleY})`;
}

/** Replica writes only: no original attributes, links or handlers are copied. */
export class OpticalSource {
  private pieces = new Map<HTMLElement, Piece>();
  private groups = new Map<HTMLElement, Group>();
  private displayed: HTMLElement[] = [];
  private textCount = 0;
  get visibleTextCount() { return this.textCount; }
  constructor(private layer: HTMLElement) {}
  clear() {
    this.pieces.clear(); this.groups.clear(); this.displayed = []; this.textCount = 0;
    this.layer.replaceChildren();
  }
  update(roots: HTMLElement[], region: OpticalBox, refresh = false, snapshot?: OpticalFrameSnapshot) {
    const collected = snapshot || createOpticalFrame(roots, [region]);
    const plan = collected.plans.find(plan => sameBox(plan.region, region));
    if (!plan || roots.length !== collected.roots.length || roots.some((root, i) => root !== collected.roots[i])) {
      throw new RangeError("Optical frame does not cover these roots and region");
    }
    let count = 0, textCount = 0;
    const active = new Set<HTMLElement>(), activeGroups = new Set<HTMLElement>();
    const root: Frame = { group: { node: this.layer, displayed: this.displayed }, children: [],
      left: region.left, top: region.top, scaleX: 1, scaleY: 1 };
    const frames: Frame[] = [root];
    const effectGroup = (data: CapturedSource, parent: Frame) => {
      const { source, rect, style, layout: { width, height, scaleX, scaleY } } = data;
      let group = this.groups.get(source);
      if (!group) {
        const node = document.createElement("div");
        Object.assign(node.style, { position: "absolute", left: "0", top: "0", margin: "0", padding: "0",
          border: "0", boxSizing: "border-box", transformOrigin: "0 0", pointerEvents: "none" });
        group = { node, displayed: [] };
        this.groups.set(source, group);
      }
      const values = { width: `${width}px`, height: `${height}px`, transform: placement(rect, scaleX, scaleY, parent),
        opacity: style.opacity, filter: style.filter, clipPath: style["clip-path"] };
      for (const [key, value] of Object.entries(values)) {
        const property = key as keyof typeof values;
        if (group.node.style[property] !== value) group.node.style[property] = value;
      }
      copyStyles(style, group.node, maskStyles);
      activeGroups.add(source);
      const frame: Frame = { group, children: [], left: rect.left, top: rect.top, scaleX, scaleY };
      frames.push(frame);
      return frame;
    };
    const add = (data: CapturedSource, clip: OpticalBox, parent: Frame) => {
      const { source, rect, style, layout: { width, height, scaleX: scale, scaleY } } = data;
      const backgroundOnly = !data.isLeaf;
      let entry = this.pieces.get(source);
      const existing = entry && entry.backgroundOnly === backgroundOnly ? entry : undefined;
      if (!existing || existing.width !== width || existing.height !== height || refresh) {
        const node = existing?.node ?? document.createElement(data.imageUrl !== undefined ? "img" : "div");
        if (data.imageUrl !== undefined) {
          (node as HTMLImageElement).alt = "";
          if ((node as HTMLImageElement).src !== data.imageUrl) (node as HTMLImageElement).src = data.imageUrl;
        } else if (!backgroundOnly) node.replaceChildren(...data.inline.map(inlineCopy));
        const placementStyles = { position: "absolute", left: "0", top: "0", boxSizing: "border-box",
          width: `${width}px`, height: `${height}px`, maxWidth: "none", maxHeight: "none", transformOrigin: "0 0" };
        for (const [key, value] of Object.entries(placementStyles)) {
          const property = key as keyof typeof placementStyles;
          if (node.style[property] !== value) node.style[property] = value;
        }
        entry = { node, width, height, backgroundOnly };
        this.pieces.set(source, entry);
      }
      if (!entry) return;
      // Animated colors and backgrounds use this frame's values; unchanged
      // declarations, including masks on groups, never cause redundant writes.
      copyStyles(style, entry.node, [...typeStyles, ...boxStyles.filter(property => property !== "box-sizing")]);
      const transform = placement(rect, scale, scaleY, parent);
      if (entry.node.style.transform !== transform) entry.node.style.transform = transform;
      if (entry.node.style.opacity !== "1") entry.node.style.opacity = "1";
      if (entry.node.style.filter !== "none") entry.node.style.filter = "none";
      if (entry.node.style.maskImage !== "none") entry.node.style.maskImage = "none";
      if (entry.node.style.webkitMaskImage !== "none") entry.node.style.webkitMaskImage = "none";
      const inset = (value: number, ratio: number) => `${Math.max(0, value / (ratio || 1)).toFixed(3)}px`;
      const clipPath = `inset(${inset(clip.top - rect.top, scaleY)} ${inset(rect.right - clip.left - clip.width, scale)} ${inset(rect.bottom - clip.top - clip.height, scaleY)} ${inset(clip.left - rect.left, scale)})`;
      if (entry.node.style.clipPath !== clipPath) entry.node.style.clipPath = clipPath;
      parent.children.push(entry.node); count++;
      if (!backgroundOnly && data.hasText) textCount++;
      active.add(source);
    };
    const visit = ({ data, clip, piece, children }: CapturedNode, parent: Frame) => {
      const frame = data.grouped ? effectGroup(data, parent) : parent;
      if (piece) add(data, clip, frame);
      for (const child of children) visit(child, frame);
      if (data.grouped && frame.children.length) parent.children.push(frame.group.node);
    };
    for (const node of plan.nodes) visit(node, root);
    for (const node of this.pieces.keys()) if (!active.has(node)) this.pieces.delete(node);
    for (const node of this.groups.keys()) if (!activeGroups.has(node)) this.groups.delete(node);
    for (const { group, children } of frames) {
      if (children.length !== group.displayed.length || children.some((node, index) => node !== group.displayed[index])) {
        group.node.replaceChildren(...children); group.displayed = children;
      }
    }
    this.displayed = root.children; this.textCount = textCount;
    return count;
  }
}
