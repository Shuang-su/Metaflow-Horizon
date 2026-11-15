// Run against an isolated preview tab through its CDP capability.
// resize({ width, height }) must resize that tab's real viewport.
export async function verifyHomeCarousel(cdp, resize) {
  const report = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const evaluate = async expression => {
    const response = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  };
  const read = () => evaluate(`(() => {
    const root = document.querySelector('#main .home-carousel');
    const swiper = root.swiper;
    const rect = root.getBoundingClientRect();
    const badge = root.querySelector('.home-slide:not([inert]) .home-slide-date');
    const style = getComputedStyle(badge);
    return {
      real: swiper.realIndex, count: swiper.slides.length, x: swiper.getTranslate(),
      date: root.dataset.activeReport, moving: swiper.animating, playing: root.dataset.playing,
      rect: { x: rect.x, y: rect.y, width: rect.width }, viewport: [innerWidth, innerHeight], scroll: scrollY,
      speed: swiper.params.speed, timing: getComputedStyle(swiper.wrapperEl).transitionTimingFunction,
      badge: [style.borderWidth, style.boxShadow],
      lines: [root.querySelector('.carousel-track').getBoundingClientRect().left - rect.left,
        parseFloat(getComputedStyle(root.querySelector('.carousel-pages')).gap),
        root.querySelector('.carousel-track').getBoundingClientRect().height]
    };
  })()`);
  const settle = async () => {
    check(await evaluate(`new Promise(resolve => {
      const start = performance.now();
      function frame() {
        const swiper = document.querySelector('#main .home-carousel')?.swiper;
        if (swiper && !swiper.animating && performance.now() - start > 32) resolve(true);
        else if (performance.now() - start > 1800) resolve(false);
        else requestAnimationFrame(frame);
      }
      frame();
    })`), "Carousel did not settle");
    return read();
  };
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const mouse = (type, x, y, pressed = false) => cdp.send("Input.dispatchMouseEvent", {
    type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: pressed ? 1 : 0,
    clickCount: type === "mouseMoved" ? 0 : 1,
  });
  const drag = async (distance, hold, row) => {
    let before = await settle();
    const x = before.rect.x + (distance > 0 ? 40 : before.rect.width - 40);
    const y = before.rect.y + row;
    await mouse("mouseMoved", x, y);
    before = await settle();
    await mouse("mousePressed", x, y, true);
    await mouse("mouseMoved", x + Math.sign(distance) * 8, y, true);
    await mouse("mouseMoved", x + distance, y, true);
    const during = await read();
    if (hold) await pause(hold);
    await mouse("mouseReleased", x + distance, y);
    return { before, during, after: await settle() };
  };
  for (const [width, height] of [[477, 939], [495, 879], [588, 939], [1441, 958]]) {
    await resize({ width, height });
    await evaluate("scrollTo({top:0,behavior:'instant'})");
    const sized = await settle();
    check(sized.viewport[0] === width && sized.viewport[1] === height, `Viewport override at ${width}`);
    const flick = await drag(-24, 0, 24);
    check(flick.after.real === (flick.before.real + 1) % 5, `Short swipe failed at ${width}`);
    const held = await drag(45, 360, 24);
    check(held.after.real === held.before.real, `Long, shallow drag failed at ${width}`);
    const long = await drag(310, 360, 160);
    check(long.after.real === (long.before.real + 4) % 5, `Long drag failed at ${width}`);
    check(JSON.stringify(long.after.lines) === "[16,8,2]", `Progress geometry at ${width}`);
    check(JSON.stringify(long.after.badge) === '["0px","none"]', `Date outline at ${width}`);
    check(long.after.speed === 300 && long.after.timing === "ease", `Transition parameters at ${width}`);
    check(long.after.playing === "false", `Hover did not pause autoplay at ${width}`);
    report.push({ viewport: long.after.viewport, flick: [flick.before.date, flick.after.date], held: held.after.date,
      long: [long.before.date, long.after.date], lines: long.after.lines, badge: long.after.badge });
  }
  await resize({ width: 495, height: 879 });
  for (const row of [24, 170]) {
    let before = await settle();
    const x = before.rect.x + before.rect.width / 2, y = before.rect.y + row;
    await mouse("mouseMoved", x, y);
    before = await settle();
    for (const deltaX of [48, 24, 12, 6, 3, 1]) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY: 0 });
      await pause(16);
    }
    const next = await settle();
    check(next.real === (before.real + 1) % 5, `Wheel tail at row ${row}`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: -48, deltaY: 0 });
    const previous = await settle();
    check(previous.real === before.real, `Wheel reversal at row ${row}`);
    report.push({ wheelRow: row, from: before.date, to: next.date, reversed: previous.date });
  }
  const beforeScroll = await read();
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 245, y: 240, deltaX: 5, deltaY: 100 });
  const afterScroll = await settle();
  check(afterScroll.scroll > beforeScroll.scroll && afterScroll.real === beforeScroll.real, "Vertical wheel was captured");
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 245, y: 240, deltaX: 0, deltaY: -100 });
  await settle();
  report.push({ verticalScroll: [beforeScroll.scroll, afterScroll.scroll] });
  // PointerEvent checks the library's touch path. Native iPhone gesture acceptance is separate.
  const touch = await evaluate(`(async () => {
    const root = document.querySelector('#main .home-carousel'), swiper = root.swiper;
    const rect = root.getBoundingClientRect(), x = rect.right - 60, y = rect.top + 150;
    const target = document.elementFromPoint(x, y), before = swiper.realIndex;
    function emit(type, dx, buttons) {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
        pointerId: 91, pointerType: 'touch', isPrimary: true, button: 0, buttons,
        clientX: x + dx, clientY: y }));
    }
    emit('pointerdown', 0, 1); emit('pointermove', -8, 1); emit('pointermove', -24, 1);
    emit('pointerup', -24, 0);
    await new Promise(resolve => setTimeout(resolve, 360));
    return { before, after: swiper.realIndex };
  })()`);
  check(touch.after === (touch.before + 1) % 5, "Synthetic touch short swipe");
  report.push({ syntheticTouch: touch });
  const interrupted = await evaluate(`(async () => {
    const root = document.querySelector('#main .home-carousel'), previous = root.swiper;
    const rect = root.getBoundingClientRect(), x = rect.right - 60, y = rect.top + 150;
    const target = document.elementFromPoint(x, y), before = previous.realIndex;
    for (const [type, dx] of [['pointerdown', 0], ['pointermove', -8], ['pointermove', -40]])
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
        pointerId: 92, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
        clientX: x + dx, clientY: y }));
    window.dispatchEvent(new Event('blur'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const next = document.querySelector('#main .home-carousel').swiper;
    return { before, after: next.realIndex, recreated: next !== previous,
      touched: next.touchEventsData.isTouched, enabled: next.enabled };
  })()`);
  check(interrupted.recreated && interrupted.enabled && !interrupted.touched &&
    interrupted.after === interrupted.before, "External pointer release recovery");
  report.push({ interrupted });
  return report;
}

/** A carousel mounts disabled during a card return; its live engine must resume. */
export async function verifyCarouselReturn(cdp) {
  const evaluate = async expression => {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = condition => evaluate(`new Promise(resolve => {
    const start=performance.now(); function frame(){ if (${condition}) resolve(true);
    else if(performance.now()-start>2500) resolve(false); else requestAnimationFrame(frame); } frame(); })`);
  const before = await evaluate(`(() => { const c=document.querySelector('#main .home-carousel');
    const result={date:c.dataset.activeReport,index:c.swiper.realIndex};
    c.querySelector('.home-slide-link').click(); return result; })()`);
  if (!await wait(`document.querySelector('.article-back') && !document.documentElement.hasAttribute('data-reader-route-pending')`))
    throw new Error("Article entry did not finish");
  await evaluate(`document.querySelector('.article-back').click()`);
  if (!await wait(`document.querySelector('#main .home-carousel') && !document.documentElement.hasAttribute('data-reader-route-pending')`))
    throw new Error("Carousel return did not finish");
  const restored = await evaluate(`(() => { const c=document.querySelector('#main .home-carousel');
    return {date:c.dataset.activeReport,enabled:c.swiper.enabled,focus:document.activeElement.className}; })()`);
  if (!restored.enabled || restored.date !== before.date || restored.focus !== "home-slide-link")
    throw new Error("Returning did not restore an operable carousel: " + JSON.stringify(restored));
  const next = (before.index + 1) % 5;
  await evaluate(`document.querySelectorAll('#main .carousel-page')[${next}].click()`);
  if (!await wait(`document.querySelector('#main .home-carousel').swiper.realIndex === ${next} && !document.querySelector('#main .home-carousel').swiper.animating`))
    throw new Error("Carousel stayed disabled after returning from reading");
  return {before,restored,next};
}
