// Run through the browser plugin's CDP on an isolated hydrated article preview.
// Real Safari/iPhone pixel acceptance is separate from these integration checks.
export async function verifyReaderRepair(cdp) {
  const response = await cdp.send("Runtime.evaluate", {
    awaitPromise: true, returnByValue: true,
    expression: ` (async () => {
      const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      const button = document.querySelector('.reader-font-trigger');
      if (!button) throw new Error('Expected a hydrated article');
      const q = () => Number(button.style.getPropertyValue('--reader-chrome-q'));
      const originalY = scrollY;
      const saved = Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('gsd:reading-progress:')));
      const align = async top => {
        window.dispatchEvent(new Event('reading-position-align'));
        scrollTo({top, behavior:'instant'});
        await frames(); await pause(220);
      };
      const step = async amount => {
        window.dispatchEvent(new WheelEvent('wheel', {deltaY: amount}));
        scrollBy({top: amount, behavior:'instant'});
        await frames();
      };
      const expect = (actual, expected, label) => {
        if (Math.abs(actual - expected) > .001) throw new Error(label + ': ' + actual + ' != ' + expected);
      };
      try {
        document.activeElement?.blur();
        await align(600);
        const alignment = q(); expect(alignment, 1, 'Programmatic alignment');
        await step(16);
        const fast = q(); expect(fast, .75, '16px step');
        await pause(650);
        const paused = q(); expect(paused, fast, 'Pause must not auto-complete');
        await step(-8);
        const reversed = q(); expect(reversed, .875, 'Immediate reverse');
        await align(600);
        for (let index = 0; index < 16; index++) await step(1);
        const slow = q(); expect(slow, fast, 'Equal total displacement');
        const shapes = [...document.querySelectorAll('.glass-optical-strip')];
        const optical = {
          state: document.querySelector('[data-glass-state]')?.dataset.glassState,
          foreignObjects: document.querySelectorAll('[data-glass-optics] foreignObject').length,
          clipped: shapes.length > 0 && shapes.every(shape => getComputedStyle(shape).clipPath.startsWith('polygon(')),
          coverMask: getComputedStyle(document.querySelector('.article-cover .source-image')).maskImage,
        };
        if (optical.foreignObjects || !optical.clipped || optical.coverMask === 'none') throw new Error('Unsafe optical carrier/mask');
        const controls = [...document.querySelectorAll('.reader-header [data-glass-surface]')]
          .filter(element => element.matches('button,a')).map(element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {width:rect.width, height:rect.height, background:style.backgroundColor, shadow:style.boxShadow};
          });
        if (controls.some(control => Math.abs(control.width - control.height) > 1)) throw new Error('Non-circular control');
        return {alignment, fast, paused, reversed, slow, optical, controls};
      } finally {
        await align(originalY);
        await pause(200);
        for (const key of Object.keys(localStorage).filter(key => key.startsWith('gsd:reading-progress:'))) localStorage.removeItem(key);
        for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
      }
    })()`,
  });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
