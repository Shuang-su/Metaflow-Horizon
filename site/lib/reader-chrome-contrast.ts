/** Glyph-only contrast over a real cover image; optical material is untouched. */
export type GlyphTone = "dark" | "light";
const sampleSize = 32;
type ImageSample = { src: string; pixels: Uint8ClampedArray | null };
const samples = new WeakMap<HTMLImageElement, ImageSample>();

export function coverGlyphTone(brightness: number, previous?: GlyphTone): GlyphTone {
  // Hysteresis avoids flipping at every small parallax or scroll change.
  if (previous === "dark") return brightness < .40 ? "light" : "dark";
  if (previous === "light") return brightness > .56 ? "dark" : "light";
  return brightness >= .48 ? "dark" : "light";
}
export function coverMaskAlpha(y: number) {
  const stops = [[0, 1], [.42, 1], [.61, .88], [.83, .28], [1, 0]];
  for (let i = 1; i < stops.length; i++) {
    const [end, alpha] = stops[i], [start, before] = stops[i - 1];
    if (y <= end) return before + (alpha - before) * Math.max(0, (y - start) / (end - start));
  }
  return 0;
}
export function sampleCoverBrightness(pixels: Uint8ClampedArray, u: number, v: number, radiusU: number, radiusV: number) {
  let total = 0, weight = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = Math.max(0, Math.min(sampleSize - 1, Math.floor((u + dx * radiusU / 2) * sampleSize)));
    const y = Math.max(0, Math.min(sampleSize - 1, Math.floor((v + dy * radiusV / 2) * sampleSize)));
    const at = (y * sampleSize + x) * 4, alpha = pixels[at + 3] / 255;
    total += (.2126 * pixels[at] + .7152 * pixels[at + 1] + .0722 * pixels[at + 2]) / 255 * alpha;
    weight += alpha;
  }
  return weight > 0 ? total / weight : null;
}
function imageSample(image: HTMLImageElement) {
  if (!image.complete || !image.naturalWidth) return null;
  const src = image.currentSrc || image.src;
  if (new URL(src, document.baseURI).origin !== location.origin) return null;
  const cached = samples.get(image);
  if (cached?.src === src) return cached.pixels;
  let pixels: Uint8ClampedArray | null = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = sampleSize;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context) {
      context.drawImage(image, 0, 0, sampleSize, sampleSize);
      pixels = context.getImageData(0, 0, sampleSize, sampleSize).data;
    }
  } catch { /* Cross-origin/failed images retain the theme glyph. */ }
  samples.set(image, { src, pixels });
  return pixels;
}

export function updateCoverGlyphContrast(element: HTMLElement, darkTheme: boolean, materialReady = element.hasAttribute("data-glass-ready")) {
  const reset = () => { delete element.dataset.coverGlyph; };
  if (!element.closest(".reader-header") || !materialReady) { reset(); return; }
  const cover = document.querySelector<HTMLElement>("#main .article-cover, #main .article-intro-cover");
  const image = cover?.querySelector<HTMLImageElement>(".source-image > img");
  if (!cover || !image) { reset(); return; }
  const box = element.getBoundingClientRect(), imageBox = image.getBoundingClientRect();
  const clip = image.parentElement!.getBoundingClientRect();
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  const inset = Math.min(box.width, box.height) * .2;
  if (cx - inset < Math.max(imageBox.left, clip.left) || cx + inset > Math.min(imageBox.right, clip.right) ||
      cy - inset < Math.max(imageBox.top, clip.top) || cy + inset > Math.min(imageBox.bottom, clip.bottom)) { reset(); return; }
  const pixels = imageSample(image);
  if (!pixels) { reset(); return; }
  const style = getComputedStyle(image);
  const ratio = style.objectFit === "contain"
    ? Math.min(imageBox.width / image.naturalWidth, imageBox.height / image.naturalHeight)
    : Math.max(imageBox.width / image.naturalWidth, imageBox.height / image.naturalHeight);
  const renderedWidth = style.objectFit === "fill" ? imageBox.width : image.naturalWidth * ratio;
  const renderedHeight = style.objectFit === "fill" ? imageBox.height : image.naturalHeight * ratio;
  const position = style.objectPosition.split(" ").map(value => parseFloat(value) / 100);
  const imageLeft = imageBox.left + (imageBox.width - renderedWidth) * (Number.isFinite(position[0]) ? position[0] : .5);
  const imageTop = imageBox.top + (imageBox.height - renderedHeight) * (Number.isFinite(position[1]) ? position[1] : .5);
  const u = (cx - imageLeft) / renderedWidth, v = (cy - imageTop) / renderedHeight;
  if (u < 0 || u > 1 || v < 0 || v > 1) { reset(); return; }
  let brightness = sampleCoverBrightness(pixels, u, v, inset / renderedWidth, inset / renderedHeight);
  if (brightness === null) { reset(); return; }
  // The existing cover mask fades into the theme; do not keep dark glyphs
  // after the image detail has faded out under the controls.
  const alpha = coverMaskAlpha((cy - clip.top) / clip.height);
  if (alpha < .1) { reset(); return; }
  const background = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)?.map(Number);
  const backgroundBrightness = background && background.length >= 3 && (background[3] ?? 1) > .9
    ? (.2126 * background[0] + .7152 * background[1] + .0722 * background[2]) / 255 : darkTheme ? .10 : .97;
  brightness = brightness * alpha + backgroundBrightness * (1 - alpha);
  if (darkTheme) brightness = brightness * .86 + .14;
  const previous = element.dataset.coverGlyph as GlyphTone | undefined;
  const next = coverGlyphTone(brightness, previous);
  if (previous !== next) element.dataset.coverGlyph = next;
}
