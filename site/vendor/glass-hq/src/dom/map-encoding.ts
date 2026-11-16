import { pngDataUrl, pngDataUrlYielding } from "./png";
import { mapPlanes } from "../gpu/planes";

/** Encode GPU readback pixels, never DOM content. The atlas holds its planes
 * stacked vertically. Each plane yields its full image followed, for capsule
 * maps, by its left, middle, and right slices. Everything runs on the CPU of
 * whichever thread calls it. */
export function encodeMapPixels(pixels: Uint8Array, width: number, height: number, cap?: number): Promise<string[][]> {
  const stride = width * 4;
  const regions = cap === undefined ? [[0, width]] : [[0, width], [0, cap], [cap, width - 2 * cap], [width - cap, cap]];
  return Promise.all(Array.from({ length: mapPlanes }, (_, plane) => {
    const base = plane * height * stride;
    return Promise.all(regions.map(([offset, size]) =>
      pngDataUrl(size!, height, pixels.subarray(base + offset! * 4, base + height * stride), stride)));
  }));
}

/** Fallback only: serialize the planes and yield within each PNG stage. */
export async function encodeMapPixelsYielding(pixels: Uint8Array, width: number, height: number,
  yieldTask: () => Promise<void>): Promise<string[][]> {
  const stride = width * 4;
  const planes: string[][] = [];
  for (let plane = 0; plane < mapPlanes; plane++) {
    const base = plane * height * stride;
    planes.push([await pngDataUrlYielding(width, height, pixels.subarray(base, base + height * stride), stride, yieldTask)]);
  }
  return planes;
}
