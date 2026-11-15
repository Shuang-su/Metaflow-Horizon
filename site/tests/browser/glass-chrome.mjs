// Browser regression for the source/dropout and final-transition-frame defects.
// Run on an isolated, hydrated home page at a narrow viewport through tab CDP.
export async function verifyGlassSources(cdp) {
  const read = async expression => {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await read(`(() => {
    document.querySelector('.carousel-page[aria-current="true"]').focus({preventScroll:true});
    scrollTo({top:200,behavior:'instant'});
  })()`);
  const result = [];
  for (let turn = 0; turn < 5; turn++) {
    result.push(await read(`new Promise(resolve => {
      const carousel = document.querySelector('.home-carousel');
      const next = (carousel.swiper.realIndex + 1) % 5;
      const samples = [], start = performance.now();
      const sample = now => {
        const images = [...document.querySelectorAll('#main .home-slide-visual img')];
        const strips = [...document.querySelectorAll('.glass-optical-strip[data-glass-lens="chrome"]')];
        const deltas = strips.flatMap(strip => [...strip.querySelectorAll('.glass-optical-plane img')].flatMap(copy => {
          const original = images.find(image => image.currentSrc === copy.src);
          if (!original) return [];
          return [Math.abs(original.getBoundingClientRect().left-copy.getBoundingClientRect().left)];
        }));
        samples.push({ms:Math.round(now-start),images:deltas.length,error:Math.max(0,...deltas)});
        if (now-start < 430) requestAnimationFrame(sample);
        else {
          const image=carousel.querySelector('.home-slide:not([inert]) img');
          resolve({index:carousel.swiper.realIndex, expected:next,samples,
            sources:strips.map(strip=>[...strip.querySelectorAll('.glass-optical-plane img')].some(copy=>copy.src===image.currentSrc)),
            controls:[...document.querySelectorAll('.home-header [data-glass-surface]')].map(e=>({
              ready:e.hasAttribute('data-glass-ready'),background:getComputedStyle(e).backgroundColor,
              border:getComputedStyle(e).borderColor,shadow:getComputedStyle(e).boxShadow}))});
        }
      };
      document.querySelectorAll('.carousel-page')[next].click();
      requestAnimationFrame(sample);
    })`));
  }
  for (const turn of result) {
    if (turn.index !== turn.expected || turn.sources.length !== 3 || !turn.sources.every(Boolean))
      throw new Error(`Missing carousel glass source at slide ${turn.expected}`);
    if (turn.controls.some(control => !control.ready || control.background !== "rgba(0, 0, 0, 0)" || control.shadow !== "none"))
      throw new Error(`Duplicate DOM material at slide ${turn.expected}`);
    // A frame may precede the optics RAF; a frozen 50ms tail has a larger error.
    const finalFrames = turn.samples.filter(frame => frame.ms >= 310);
    if (finalFrames.some(frame => frame.error > .75 || frame.images === 0))
      throw new Error(`Unsettled glass source at slide ${turn.expected}`);
  }
  return result;
}
