"use client";

import { useEffect, useRef, useState } from "react";
import type { Swiper as SwiperInstance } from "swiper";
import { Mousewheel } from "swiper/modules";
import { Swiper, SwiperSlide } from "swiper/react";
import "swiper/css";
import Link from "./ArticleLink";
import { useCarouselAutoplay } from "../lib/carousel-autoplay";
import { carouselState, restoredUI, UI_CAPTURE, type PageUI } from "../lib/card-navigation";
import { useCardNavigation } from "./CardNavigation";
import { calendarDate, type HomeSlide } from "../lib/home";
import SourceImage from "./SourceImage";

const INTERVAL = 8000;
const modules = [Mousewheel];
const mousewheel = { forceToAxis: true, sensitivity: 1, releaseOnEdges: true };

export default function HomeCarousel({ slides }: { slides: HomeSlide[] }) {
  const [active, setActive] = useState(0);
  const [cycle, setCycle] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [visible, setVisible] = useState(true);
  const [ready, setReady] = useState(false);
  const [recovery, setRecovery] = useState<{ version: number; active: number; elapsed: number } | null>(null);
  const swiper = useRef<SwiperInstance | null>(null);
  const interaction = useRef(false);
  const pagers = useRef<(HTMLButtonElement | null)[]>([]);
  const timerStarted = useRef<number | null>(null);
  const elapsed = useRef({ key: "", value: 0 });
  const progressStart = useRef({ key: "", value: 0 });
  const autoplay = useCarouselAutoplay();
  const navigation = useCardNavigation();
  const key = `${active}-${cycle}`;
  const playing = ready && !navigation?.busy && slides.length > 1 && autoplay &&
    !dragging && !settling && !hovered && !focused && !reducedMotion && visible;

  function initialize(instance: SwiperInstance) {
    const saved = recovery || carouselState(restoredUI("carousel"), slides.map(slide => slide.id));
    instance.params.initialSlide = saved.active;
    elapsed.current = { key: `${saved.active}-${cycle}`, value: saved.elapsed };
    progressStart.current = { ...elapsed.current };
    setActive(saved.active);
  }

  useEffect(() => {
    const capture = (event: Event) => {
      const instance = swiper.current;
      if (!instance || instance.destroyed) return;
      (event as CustomEvent<{ ui: PageUI }>).detail.ui.carousel = {
        id: slides[instance.realIndex]?.id,
        elapsed: Math.min(INTERVAL, elapsed.current.value +
          (timerStarted.current === null ? 0 : performance.now() - timerStarted.current)),
      };
    };
    window.addEventListener(UI_CAPTURE, capture);
    return () => window.removeEventListener(UI_CAPTURE, capture);
  }, [slides]);

  useEffect(() => {
    if (ready) setFocused(Boolean(swiper.current?.el.contains(document.activeElement)));
  }, [active, ready]);

  useEffect(() => {
    const instance = swiper.current;
    if (!instance || instance.destroyed) return;
    // React updates params.enabled, but the live engine also owns enabled.
    // A carousel mounted during the return transition must be enabled again
    // when that transition finishes, using Swiper's public lifecycle API.
    if (navigation?.busy) instance.disable();
    else instance.enable();
  }, [navigation?.busy, ready, recovery?.version]);

  useEffect(() => {
    const interrupt = () => {
      const instance = swiper.current;
      if (!interaction.current || !instance || instance.destroyed) return;
      interaction.current = false;
      instance.disable();
      // Recreate the engine after an external release so no private touch state
      // from the lost pointer can affect the next gesture.
      setRecovery(previous => ({ version: (previous?.version || 0) + 1,
        active: instance.realIndex, elapsed: elapsed.current.value }));
      setDragging(false);
      setSettling(false);
      setHovered(false);
      setFocused(false);
    };
    const visibility = () => { if (document.hidden) interrupt(); };
    window.addEventListener("blur", interrupt);
    window.addEventListener("resize", interrupt);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", interrupt);
      window.removeEventListener("resize", interrupt);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => {
      setReducedMotion(motion.matches);
      const instance = swiper.current;
      if (motion.matches && instance && !instance.destroyed) {
        instance.slideToLoop(instance.realIndex, 0);
        setSettling(false);
      }
    };
    const updateVisibility = () => setVisible(document.visibilityState === "visible");
    updateMotion();
    updateVisibility();
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
    const timer = window.setTimeout(() => swiper.current?.slideNext(), Math.max(0, INTERVAL - elapsed.current.value));
    return () => {
      clearTimeout(timer);
      timerStarted.current = null;
      if (elapsed.current.key === key) elapsed.current.value += performance.now() - started;
    };
  }, [key, playing]);

  function select(index: number) {
    const instance = swiper.current;
    if (!instance || instance.destroyed) return;
    if (instance.realIndex === index) setCycle(current => current + 1);
    instance.slideToLoop(index, reducedMotion ? 0 : 300);
  }

  function endInteraction() {
    interaction.current = false;
    setDragging(false);
  }

  if (!slides.length) return null;
  const slide = slides[active] || slides[0];
  return <section className="home-hero" aria-label="精选日报" aria-roledescription="轮播">
    <div className="home-carousel-frame" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)} onBlurCapture={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}>
    <Swiper key={recovery?.version || 0} className="home-carousel" wrapperClass="carousel-viewport" modules={modules}
      slidesPerView={1} spaceBetween={0} loop={slides.length > 1} speed={reducedMotion ? 0 : 300}
      threshold={5} touchRatio={1} touchAngle={45} followFinger shortSwipes longSwipes
      longSwipesMs={300} longSwipesRatio={0.5} preventInteractionOnTransition={false}
      mousewheel={mousewheel} simulateTouch touchEventsTarget="container"
      edgeSwipeDetection edgeSwipeThreshold={24} enabled={!navigation?.busy}
      focusableElements="input, select, option, textarea, video, label"
      data-active-report={slide.date} data-source-sha256={slide.contentHash} data-playing={playing}
      onBeforeInit={initialize} onSwiper={instance => { swiper.current = instance; setReady(true); }}
      onSlideChange={instance => setActive(instance.realIndex)}
      onTouchStart={() => { interaction.current = true; setDragging(true); }} onTouchEnd={endInteraction}
      onTouchMoveOpposite={endInteraction}
      onBeforeTransitionStart={(_instance, speed) => setSettling(speed > 0)}
      onTransitionEnd={() => setSettling(false)}>
      {slides.map((item, index) => {
        const date = calendarDate(item.date);
        const isActive = index === active;
        return <SwiperSlide key={item.id} tag="article" className="home-slide"
          data-article-origin={isActive ? `carousel:${item.id}` : undefined}
          aria-label={`${index + 1} / ${slides.length}`} aria-hidden={!isActive || undefined} inert={!isActive}>
          <div className="home-slide-visual">
            {item.image ? <SourceImage image={{ ...item.image, fit: "cover" }} caption={false} previewable={false}
              priority={index === 0} sizes="(max-width: 767px) calc(100vw - 32px), 588px" />
              : <div className="image-unavailable">本期日报</div>}
            <div className="home-slide-date" aria-hidden="true"><span>{date.weekday}</span><strong>{date.day}</strong></div>
          </div>
          <div className="home-slide-copy">{isActive ? <h1>{item.title}</h1> : <p>{item.title}</p>}</div>
          {isActive && <Link className="home-slide-link" draggable={false} href={item.url} aria-label={`${item.date}，${item.title}`}><span className="sr-only">阅读全文</span></Link>}
        </SwiperSlide>;
      })}
      <div className="carousel-controls" slot="container-end">
        <div className="carousel-pages" role="group" aria-label="选择日报">{slides.map((item, index) =>
          <button key={item.id} ref={element => { pagers.current[index] = element; }} className="carousel-page"
            aria-label={`查看 ${item.date} 日报`} aria-current={active === index ? "true" : undefined}
            onClick={() => select(index)} onKeyDown={event => {
              const next = event.key === "ArrowRight" ? (index + 1) % slides.length
                : event.key === "ArrowLeft" ? (index + slides.length - 1) % slides.length
                  : event.key === "Home" ? 0 : event.key === "End" ? slides.length - 1 : -1;
              if (next >= 0) { event.preventDefault(); select(next); pagers.current[next]?.focus({ preventScroll: true }); }
            }}><span className="carousel-track">{active === index && <span key={key} className="carousel-progress" style={{
              animationPlayState: playing ? "running" : "paused",
              animationDelay: `-${progressStart.current.key === key ? progressStart.current.value : 0}ms`,
            }} />}</span></button>,
        )}</div>
      </div>
      <p className="sr-only" slot="container-end" aria-live={playing ? "off" : "polite"}>{slide.date} 日报，{slide.title}</p>
    </Swiper>
    </div>
  </section>;
}
