export function isCarouselEdge(x: number, viewportWidth: number) {
  return x < 24 || x > viewportWidth - 24;
}

export function carouselAxis(x: number, y: number, slop = 8) {
  if (Math.max(Math.abs(x), Math.abs(y)) < slop) return null;
  return Math.abs(x) > Math.abs(y) * 1.25 ? "horizontal" : "vertical";
}

export function carouselSnap(offset: number, width: number, velocity = 0) {
  if (Math.abs(offset) >= width * .22 || (Math.abs(offset) >= 22 && Math.sign(offset) * velocity >= .45))
    return offset < 0 ? 1 : -1;
  return 0;
}
