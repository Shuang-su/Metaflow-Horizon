/** A small PNG writer for GPU readback pixels. It never touches a canvas:
 * canvas encoding runs through the GPU process, where it competes with the
 * compositor for the very frames an animation needs. Compression is the
 * platform's zlib through `CompressionStream`; without it, stored deflate
 * blocks keep the image valid at the cost of size. */
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = -1;
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 3800);
    for (; i < end; i++) { a += bytes[i]!; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
/** Zlib stream of stored blocks: valid everywhere, compressed nowhere. */
function stored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535, size = Math.min(65535, raw.length - start);
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = size & 0xff; out[o++] = size >>> 8;
    out[o++] = ~size & 0xff; out[o++] = (~size >>> 8) & 0xff;
    out.set(raw.subarray(start, start + size), o);
    o += size;
  }
  const check = adler32(raw);
  out[o++] = check >>> 24; out[o++] = (check >>> 16) & 0xff; out[o++] = (check >>> 8) & 0xff; out[o++] = check & 0xff;
  return out;
}
async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") return stored(raw);
  try {
    // A byte stream avoids opening a temporary blob URL while WebKit is leaving the page.
    const bytes = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(raw as Uint8Array<ArrayBuffer>);
        controller.close();
      },
    });
    return new Uint8Array(await new Response(bytes.pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  } catch {
    return stored(raw);
  }
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
function rows(width: number, height: number, rgba: Uint8Array, stride: number): Uint8Array {
  const row = width * 4;
  const raw = new Uint8Array((row + 1) * height);
  for (let y = 0; y < height; y++) {
    const from = y * stride, to = y * (row + 1);
    raw[to] = 1;
    for (let i = 0; i < 4; i++) raw[to + 1 + i] = rgba[from + i]!;
    for (let i = 4; i < row; i++) raw[to + 1 + i] = (rgba[from + i]! - rgba[from + i - 4]!) & 0xff;
  }
  return raw;
}
function assemble(width: number, height: number, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", data), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** Encode tightly packed RGBA pixels, `stride` bytes per row, as a PNG. The
 * "Sub" filter turns the maps' smooth gradients into runs zlib packs well. */
export async function encodePng(width: number, height: number, rgba: Uint8Array, stride = width * 4): Promise<Uint8Array> {
  return assemble(width, height, await deflate(rows(width, height, rgba, stride)));
}
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function base64(bytes: Uint8Array): string {
  let out = "";
  const full = bytes.length - (bytes.length % 3);
  for (let i = 0; i < full; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += alphabet[n >>> 18]! + alphabet[(n >>> 12) & 63]! + alphabet[(n >>> 6) & 63]! + alphabet[n & 63]!;
  }
  if (bytes.length - full === 1) {
    const n = bytes[full]! << 16;
    out += alphabet[n >>> 18]! + alphabet[(n >>> 12) & 63]! + "==";
  } else if (bytes.length - full === 2) {
    const n = (bytes[full]! << 16) | (bytes[full + 1]! << 8);
    out += alphabet[n >>> 18]! + alphabet[(n >>> 12) & 63]! + alphabet[(n >>> 6) & 63]! + "=";
  }
  return out;
}
/** A `data:` URL: Chromium resolves it synchronously for `feImage`, where a
 * `blob:` URL would leave the material blank for a frame. */
export async function pngDataUrl(width: number, height: number, rgba: Uint8Array, stride?: number): Promise<string> {
  return `data:image/png;base64,${base64(await encodePng(width, height, rgba, stride))}`;
}
/** An uncompressed PNG `data:` URL, available at once for tiny images. */
export function pngDataUrlSync(width: number, height: number, rgba: Uint8Array): string {
  return `data:image/png;base64,${base64(assemble(width, height, stored(rows(width, height, rgba, width * 4))))}`;
}

/** Cooperative stored-deflate fallback also covers engines without
 * CompressionStream; neither the checksum nor raw copy runs as one huge loop. */
async function deflateYielding(raw: Uint8Array, yieldTask: () => Promise<void>) {
  if (typeof CompressionStream !== "undefined") {
    try {
      const bytes = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) { controller.enqueue(raw as Uint8Array<ArrayBuffer>); controller.close(); },
      });
      return new Uint8Array(await new Response(bytes.pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
    } catch { /* Keep the same PNG with stored deflate blocks. */ }
  }
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let offset = 2, a = 1, b = 0;
  for (let block = 0; block < blocks; block++) {
    await yieldTask();
    const start = block * 65535, size = Math.min(65535, raw.length - start);
    out[offset++] = block === blocks - 1 ? 1 : 0;
    out[offset++] = size & 0xff; out[offset++] = size >>> 8;
    out[offset++] = ~size & 0xff; out[offset++] = (~size >>> 8) & 0xff;
    out.set(raw.subarray(start, start + size), offset); offset += size;
    for (let i = start; i < start + size;) {
      const end = Math.min(start + size, i + 3800);
      for (; i < end; i++) { a += raw[i]!; b += a; }
      a %= 65521; b %= 65521;
    }
  }
  const check = ((b << 16) | a) >>> 0;
  out[offset++] = check >>> 24; out[offset++] = (check >>> 16) & 0xff;
  out[offset++] = (check >>> 8) & 0xff; out[offset] = check & 0xff;
  return out;
}

/** Same lossless PNG representation, yielding between bounded JS row, CRC,
 * and base64 batches when a worker cannot run. CompressionStream stays async. */
export async function pngDataUrlYielding(width: number, height: number, rgba: Uint8Array, stride: number,
  yieldTask: () => Promise<void>): Promise<string> {
  const row = width * 4;
  const raw = new Uint8Array((row + 1) * height);
  for (let start = 0; start < height; start += 32) {
    await yieldTask();
    for (let y = start; y < Math.min(height, start + 32); y++) {
      const from = y * stride, to = y * (row + 1);
      raw[to] = 1;
      for (let i = 0; i < 4; i++) raw[to + 1 + i] = rgba[from + i]!;
      for (let i = 4; i < row; i++) raw[to + 1 + i] = (rgba[from + i]! - rgba[from + i - 4]!) & 0xff;
    }
  }
  await yieldTask();
  const data = await deflateYielding(raw, yieldTask);
  const idat = new Uint8Array(12 + data.length);
  new DataView(idat.buffer).setUint32(0, data.length);
  idat.set([73, 68, 65, 84], 4); idat.set(data, 8);
  let crc = -1;
  for (let start = 4; start < 8 + data.length; start += 16384) {
    await yieldTask();
    for (let i = start; i < Math.min(8 + data.length, start + 16384); i++) crc = crcTable[(crc ^ idat[i]!) & 0xff]! ^ (crc >>> 8);
  }
  new DataView(idat.buffer).setUint32(8 + data.length, (crc ^ -1) >>> 0);
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), idat, chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { png.set(part, offset); offset += part.length; }
  const encoded: string[] = [];
  for (let start = 0; start < png.length; start += 12288) {
    await yieldTask();
    encoded.push(base64(png.subarray(start, Math.min(png.length, start + 12288))));
  }
  return `data:image/png;base64,${encoded.join("")}`;
}
