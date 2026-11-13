"use client";

import Link from "./ArticleLink";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { carouselAxis, carouselSnap, isCarouselEdge } from "../lib/carousel-gesture";
import { useCarouselAutoplay } from "../lib/carousel-autoplay";
import { carouselState, restoredUI, UI_CAPTURE, type PageUI } from "../lib/card-navigation";
import { useCardNavigation } from "./CardNavigation";
import { calendarDate, type HomeSlide } from "../lib/home";
import SourceImage from "./SourceImage";

const INTERVAL = 8000;
const SNAP_MS = 240;
type Drag = {
  id: number;
  x: number;
  y: number;
  time: number;
  lastX: number;
  velocity: number;
  owned: boolean;
  initialFocus: Element | null;
};

export default function HomeCarousel({ slides }: { slides: HomeSlide[] }) {
  const [active, setActive] = useState(0);
  const [cycle, setCycle] = useState(0);
  const autoplay = useCarouselAutoplay();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [visible, setVisible] = useState(true);
  const [ready, setReady] = useState(false);
  const navigation = useCardNavigation();
  const timerStarted = useRef<number | null>(null);
  const elapsed = useRef({ key: "", value: 0 });
  const progressStart = useRef({ key: "", value: 0 });
  const surface = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const pointer = useRef<Drag | null>(null);
  const suppressClick = useRef(0);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wheelCooldown = useRef(0);
  const snapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const offset = useRef(0);
  const wheel = useRef({ axis: null as ReturnType<typeof carouselAxis>, x: 0, y: 0, last: 0 });
  const [interacting, setInteracting] = useState(false);
  const pagers = useRef<(HTMLButtonElement | null)[]>([]);
  const playing = ready && !navigation?.busy && slides.length > 1 && autoplay && !interacting && !hovered && !focused && !reducedMotion && visible;
  const key = `${active}-${cycle}`;
  const current = useRef({ active });
  current.current = { active };

  useLayoutEffect(() => {
    const saved = carouselState(restoredUI("carousel"), slides.map(slide => slide.id));
    setActive(saved.active);
    elapsed.current = { key: `${saved.active}-0`, value: saved.elapsed };
    progressStart.current = { ...elapsed.current };
    setReady(true);
    const capture = (event: Event) => {
      const state = current.current;
      (event as CustomEvent<{ ui: PageUI }>).detail.ui.carousel = { id: slides[state.active]?.id,
        elapsed: elapsed.current.value + (timerStarted.current === null ? 0 : performance.now() - timerStarted.current) };
    };
    window.addEventListener(UI_CAPTURE, capture);
    return () => window.removeEventListener(UI_CAPTURE, capture);
  }, [slides]);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => {
      reset();
      setReducedMotion(motion.matches);
    };
    const updateVisibility = () => setVisible(document.visibilityState === "visible");
    setReducedMotion(motion.matches); updateVisibility();
    motion.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      motion.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  useEffect(() => {
    if (elapsed.current.key !== key) elapsed.current = { key, value: 0 };
    if (!playing) return;
    const started = performance.now();
    timerStarted.current = started;
    const timer = window.setTimeout(() => {
      setActive((current) => (current + 1) % slides.length);
    }, Math.max(0, INTERVAL - elapsed.current.value));
    return () => {
      clearTimeout(timer);
      timerStarted.current = null;
      if (elapsed.current.key === key) elapsed.current.value += performance.now() - started;
    };
  }, [key, playing, slides.length]);

  function select(index: number) {
    setActive((index + slides.length) % slides.length);
    setCycle((current) => current + 1);
  }

  function paint(distance: number, animate: boolean) {
    const element = viewport.current;
    if (!element) return;
    offset.current = distance;
    element.dataset.snapping = String(animate);
    element.style.setProperty("--carousel-offset", `${distance}px`);
  }

  function reset() {
    clearTimeout(wheelTimer.current);
    clearTimeout(snapTimer.current);
    snapTimer.current = undefined;
    const drag = pointer.current;
    pointer.current = null;
    if (drag && surface.current?.hasPointerCapture(drag.id)) surface.current.releasePointerCapture(drag.id);
    wheel.current = { axis: null, x: 0, y: 0, last: 0 };
    paint(0, false);
    setInteracting(false);
  }

  function settle(velocity = 0, cancel = false) {
    const width = viewport.current?.clientWidth || 1;
    const direction = cancel ? 0 : carouselSnap(offset.current, width, velocity);
    const finish = () => {
      if (direction) select(current.current.active + direction);
      reset();
    };
    if (reducedMotion || !offset.current) { finish(); return; }
    paint(-direction * width, true);
    snapTimer.current = setTimeout(finish, SNAP_MS);
  }

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    suppressClick.current = 0;
    if (pointer.current && event.pointerId !== pointer.current.id) { reset(); return; }
    if (navigation?.busy || slides.length < 2 || !event.isPrimary || event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || interacting) return;
    if (event.pointerType === "touch" && isCarouselEdge(event.clientX, window.innerWidth)) return;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp,
      lastX: event.clientX, velocity: 0, owned: false, initialFocus: document.activeElement };
    setInteracting(true);
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = pointer.current;
    if (!drag || event.pointerId !== drag.id) return;
    const x = event.clientX - drag.x;
    if (!drag.owned) {
      const axis = carouselAxis(x, event.clientY - drag.y);
      if (!axis) return;
      if (axis === "vertical") { reset(); return; }
      drag.owned = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      // A mouse press can focus a link or pager before the movement resolves into a drag.
      const focusedElement = document.activeElement;
      if (focusedElement !== drag.initialFocus && focusedElement instanceof HTMLElement &&
        event.currentTarget.contains(focusedElement) && !focusedElement.matches(":focus-visible")) focusedElement.blur();
    }
    drag.velocity = (event.clientX - drag.lastX) / Math.max(8, event.timeStamp - drag.time);
    drag.lastX = event.clientX;
    drag.time = event.timeStamp;
    const width = event.currentTarget.clientWidth;
    paint(Math.max(-width, Math.min(width, x)), false);
  }

  function pointerLeave(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = pointer.current;
    if (event.pointerType === "mouse" && drag?.id === event.pointerId && !drag.owned) reset();
  }

  function pointerEnd(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    const drag = pointer.current;
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.owned) { reset(); return; }
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    suppressClick.current = performance.now() + 450;
    settle(event.timeStamp - drag.time < 90 ? drag.velocity : 0, cancel);
  }

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (navigation?.busy || slides.length < 2 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || pointer.current) return;
      if (wheelCooldown.current && event.timeStamp - wheelCooldown.current < 150) {
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && event.cancelable) {
          event.preventDefault();
          wheelCooldown.current = event.timeStamp;
        }
        return;
      }
      const state = wheel.current;
      if (state.last && event.timeStamp - state.last > 150) {
        state.axis = null; state.x = 0; state.y = 0;
      }
      state.last = event.timeStamp;
      const width = element.clientWidth;
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1;
      state.x += event.deltaX * units;
      state.y += event.deltaY * units;
      state.axis ||= carouselAxis(state.x, state.y);
      if (state.axis !== "horizontal" || !event.cancelable) return;
      event.preventDefault();
      if (snapTimer.current !== undefined) return;
      setInteracting(true);
      paint(Math.max(-width, Math.min(width, -state.x)), false);
      clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => {
        wheelCooldown.current = wheel.current.last;
        settle();
      }, 120);
    };
    const cancel = () => reset();
    element.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", cancel);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      element.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", cancel);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", cancel);
      clearTimeout(wheelTimer.current);
      clearTimeout(snapTimer.current);
    };
  }, [navigation?.busy, reducedMotion, slides.length]);

  useEffect(() => { if (navigation?.busy) reset(); }, [navigation?.busy]);

  if (!slides.length) return null;
  const slide = slides[active];
  function renderSlide(index: number, position: number) {
    const item = slides[index];
    const date = calendarDate(item.date);
    return <article key={`${position}:${item.id}`} data-article-origin={position === 0 ? `carousel:${item.id}` : undefined}
      className="home-slide" style={{ "--carousel-position": position } as React.CSSProperties}
      aria-label={`${index + 1} / ${slides.length}`} aria-hidden={position !== 0 || undefined} inert={position !== 0}>
      <div className="home-slide-visual">
        {item.image ? <SourceImage image={{ ...item.image, fit: "cover" }} caption={false} previewable={false}
          priority={index === 0 && position === 0} sizes="(max-width: 767px) calc(100vw - 32px), 588px" />
          : <div className="image-unavailable">本期日报</div>}
        <div className="home-slide-date" aria-hidden="true"><span>{date.weekday}</span><strong>{date.day}</strong></div>
      </div>
      <div className="home-slide-copy">{position === 0 ? <h1>{item.title}</h1> : <p>{item.title}</p>}</div>
      {position === 0 && <Link className="home-slide-link" draggable={false} href={item.url} aria-label={`${item.date} 日报：${item.title}`}><span className="sr-only">阅读全文</span></Link>}
    </article>;
  }
  return <section className="home-hero" aria-label="精选日报" aria-roledescription="轮播">
    <div className="home-carousel" data-active-report={slide.date} data-source-sha256={slide.contentHash}
      data-playing={playing} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)} onBlurCapture={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }} ref={surface} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerLeave={pointerLeave}
      onPointerUp={event => pointerEnd(event)} onPointerCancel={event => pointerEnd(event, true)}
      onLostPointerCapture={event => {
        // Touch starts with implicit capture on a child before the carousel takes ownership.
        if (event.target === event.currentTarget) pointerEnd(event, true);
      }}
      onDragStart={event => event.preventDefault()}
      onClickCapture={event => {
        if (event.detail > 0 && performance.now() < suppressClick.current) {
          event.preventDefault(); event.stopPropagation(); suppressClick.current = 0;
        }
      }}>
      <div className="carousel-viewport" ref={viewport}>
        {slides.length > 1 && renderSlide((active + slides.length - 1) % slides.length, -1)}
        {renderSlide(active, 0)}
        {slides.length > 1 && renderSlide((active + 1) % slides.length, 1)}
      </div>
      <div className="carousel-controls">
        <div className="carousel-pages" role="group" aria-label="选择日报">{slides.map((item, i) =>
          <button key={item.id} ref={(el) => { pagers.current[i] = el; }} className="carousel-page"
            aria-label={`查看 ${item.date} 日报`} aria-current={active === i ? "true" : undefined}
            onClick={() => { reset(); select(i); }} onKeyDown={(e) => {
              const next = e.key === "ArrowRight" ? (i + 1) % slides.length
                : e.key === "ArrowLeft" ? (i + slides.length - 1) % slides.length
                  : e.key === "Home" ? 0 : e.key === "End" ? slides.length - 1 : -1;
              if (next >= 0) { e.preventDefault(); reset(); select(next); pagers.current[next]?.focus(); }
            }}><span className="carousel-track">{active === i && <span key={key} className="carousel-progress" style={{ animationPlayState: playing ? "running" : "paused", animationDelay: `-${progressStart.current.key === key ? progressStart.current.value : 0}ms` }} />}</span></button>,
        )}</div>
      </div>
      <p className="sr-only" aria-live={playing ? "off" : "polite"}>{slide.date} 日报，{slide.title}</p>
    </div>
  </section>;
}
