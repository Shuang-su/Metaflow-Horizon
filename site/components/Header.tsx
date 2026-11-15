"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { BASE, TOPICS } from "../lib/catalog";
import BrandMark from "./BrandMark";
import ArticleBack from "./ArticleBack";
import Icon, { type IconName } from "./Icon";
import SearchOverlay from "./SearchOverlay";
import { ReaderFontControl, ReaderShareControl } from "./ReadingControls";
import { useCardNavigation } from "./CardNavigation";
import { useReader } from "./ReaderProvider";
import { ReadLaterTrigger } from "./ReadLater";
import { rememberSearch, searchTerm } from "../lib/search-history";
import { lockDocumentScroll } from "../lib/scroll-lock";
import { setCarouselAutoplay, useCarouselAutoplay } from "../lib/carousel-autoplay";
import { transitionContent } from "../lib/content-transition";

type Panel = "mobile" | "topics" | "theme" | "search" | null;
const themes = [["system", "跟随系统"], ["light", "浅色"], ["dark", "暗色"]] as const;
type Theme = typeof themes[number][0];
const routes: { href: string; label: string; icon: IconName }[] = [
  { href: "/daily/", label: "日报", icon: "paper" },
  { href: "/articles/", label: "文章", icon: "paper" },
  { href: "/features/", label: "专题", icon: "layers" },
  { href: "/papers/", label: "研究", icon: "layers" },
  { href: "/apps/", label: "应用", icon: "tool" },
];

export default function Header() {
  const [panel, setPanel] = useState<Panel>(null);
  const [readerMenuMounted, setReaderMenuMounted] = useState(false);
  const [readerMenuReady, setReaderMenuReady] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [mobileLayout, setMobileLayout] = useState(false);
  const [phoneLayout, setPhoneLayout] = useState(false);
  const cardNavigation = useCardNavigation();
  const reader = useReader();
  const pathname = usePathname();
  const home = pathname === "/";
  const collection = pathname === "/daily/" || pathname === "/daily";
  const article = /^\/(?:daily\/\d{4}\/\d{2}\/\d{2}|articles\/[^/]+)\/?$/.test(pathname) || reader?.article?.kind === "weekly";
  const immersive = article || (home && phoneLayout);
  const autoplay = useCarouselAutoplay();
  const fixedChrome = useRef(immersive || collection);
  fixedChrome.current = immersive || collection;
  const header = useRef<HTMLElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const currentPanel = useRef(panel);
  const readingDestination = useRef<number | null>(null);
  const themeTimer = useRef<number | undefined>(undefined);
  const mobileOpen = panel === "mobile";
  const mobileOverlay = mobileOpen || (article && readerMenuMounted);
  const interactiveMenu = mobileOpen && (!article || readerMenuReady);
  currentPanel.current = panel;

  useEffect(() => {
    setPanel(null);
    setReaderMenuMounted(false);
    setReaderMenuReady(false);
    readingDestination.current = null;
    header.current?.classList.remove("header-hidden");
  }, [pathname]);
  useEffect(() => {
    const width = window.matchMedia(`(max-width: ${home ? 1023 : 767}px)`);
    const sync = () => {
      setMobileLayout(article || width.matches);
      setPhoneLayout(window.innerWidth <= 767);
      setPanel((current) => current === (width.matches ? "search" : "mobile") ? null : current);
    };
    sync(); window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [home, article]);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("gsd-theme");
      if (saved === "system" || saved === "light" || saved === "dark") setTheme(saved);
    } catch {}
    let last = window.scrollY, frame = 0;
    const scroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        const y = window.scrollY, delta = y - last;
        if (fixedChrome.current) {
          header.current?.classList.remove("header-hidden");
        } else if (readingDestination.current !== null) {
          header.current?.classList.remove("header-hidden");
          if (Math.abs(y - readingDestination.current) <= 1) readingDestination.current = null;
        } else {
          if (!currentPanel.current && Math.abs(delta) > 5) header.current?.classList.toggle("header-hidden", delta > 0 && y > 56);
          if (y <= 56 || currentPanel.current) header.current?.classList.remove("header-hidden");
        }
        last = y; frame = 0;
      });
    };
    const cancelReadingScroll = () => { readingDestination.current = null; };
    const readingJump = (event: Event) => {
      const top = (event as CustomEvent<{ top: number }>).detail.top;
      if (!Number.isFinite(top)) return;
      readingDestination.current = Math.abs(window.scrollY - top) > 1 ? top : null; last = window.scrollY;
      header.current?.classList.remove("header-hidden");
    };
    const escape = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cancelReadingScroll();
      if (event.key === "Escape" && currentPanel.current && currentPanel.current !== "search" && !document.querySelector("dialog:modal")) { setPanel(null); trigger.current?.focus({ preventScroll: true }); }
    };
    const outside = (event: PointerEvent) => { cancelReadingScroll(); if (!header.current?.contains(event.target as Node)) setPanel(null); };
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("reading-navigation-jump", readingJump);
    window.addEventListener("wheel", cancelReadingScroll, { passive: true });
    window.addEventListener("touchstart", cancelReadingScroll, { passive: true });
    window.addEventListener("resize", cancelReadingScroll);
    document.addEventListener("keydown", escape); document.addEventListener("pointerdown", outside);
    return () => {
      window.clearTimeout(themeTimer.current);
      delete document.documentElement.dataset.themeChanging;
      cancelAnimationFrame(frame); window.removeEventListener("scroll", scroll);
      window.removeEventListener("reading-navigation-jump", readingJump);
      window.removeEventListener("wheel", cancelReadingScroll); window.removeEventListener("touchstart", cancelReadingScroll);
      window.removeEventListener("resize", cancelReadingScroll);
      document.removeEventListener("keydown", escape); document.removeEventListener("pointerdown", outside);
    };
  }, []);

  useLayoutEffect(() => {
    const element = navigation.current;
    if (!article || !readerMenuMounted || !element) return;
    const eventName = mobileOpen ? "glass:entered" : "glass:exited";
    const finish = () => {
      setReaderMenuReady(mobileOpen);
      if (!mobileOpen) setReaderMenuMounted(false);
    };
    if (!mobileOpen && matchMedia("(prefers-reduced-motion: reduce)").matches) { finish(); return; }
    element.addEventListener(eventName, finish, { once: true });
    const timeout = window.setTimeout(finish, 750);
    return () => {
      element.removeEventListener(eventName, finish);
      window.clearTimeout(timeout);
    };
  }, [article, mobileOpen, readerMenuMounted]);

  useEffect(() => {
    if (!mobileOverlay) return;
    const unlock = lockDocumentScroll();
    const outside = Array.from(document.querySelectorAll<HTMLElement>("main, .site-footer, .reading-parent, .article-interaction-wrap"));
    const inert = outside.map((el) => el.inert);
    outside.forEach((el) => { el.inert = true; });
    const previousTrigger = trigger.current;
    return () => {
      unlock();
      outside.forEach((el, i) => { el.inert = inert[i]; });
      requestAnimationFrame(() => {
        if (!currentPanel.current && previousTrigger?.isConnected && !document.querySelector("dialog:modal, #reader-font-panel")) {
          previousTrigger.focus({ preventScroll: true });
        }
      });
    };
  }, [mobileOverlay]);

  useEffect(() => {
    if (!interactiveMenu) return;
    const frame = requestAnimationFrame(() => {
      navigation.current?.querySelector<HTMLElement>(article ? "a[href]" : "input")?.focus({ preventScroll: true });
    });
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(header.current?.querySelectorAll<HTMLElement>("a, button, input, select") || [])
        .filter((el) => el.getClientRects().length && !el.closest("[inert]") && (el.matches(".menu-toggle") || navigation.current?.contains(el)));
      if (!controls.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", trap);
    };
  }, [article, interactiveMenu]);

  function toggle(next: Exclude<Panel, null>, button: HTMLButtonElement) {
    trigger.current = button;
    header.current?.classList.remove("header-hidden");
    if (article && next === "mobile" && !mobileOpen) {
      setReaderMenuReady(false);
      setReaderMenuMounted(true);
    }
    setPanel(panel === next ? null : next);
  }

  function changeTheme(value: Theme) {
    const root = document.documentElement;
    const system = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    const current = root.dataset.theme === "dark" || root.dataset.theme === "light" ? root.dataset.theme : system;
    const appearance = value === "system" ? system : value;
    setTheme(value);
    try { localStorage.setItem("gsd-theme", value); } catch {}
    transitionContent(home ? document.querySelector("[data-home-motion]") : null, () => {
      if (current !== appearance && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        root.dataset.themeChanging = "";
        window.clearTimeout(themeTimer.current);
        themeTimer.current = window.setTimeout(() => { delete root.dataset.themeChanging; }, 240);
      }
      root.dataset.theme = value;
    }, current !== appearance);
  }

  const appearanceOpen = panel === "theme";
  const menuLinks = <>
    <form className="mobile-nav-search" action={`${BASE}/search/`} method="get" role="search" onSubmit={event => {
      const field = event.currentTarget.elements.namedItem("q") as HTMLInputElement;
      if (!searchTerm(field.value)) { event.preventDefault(); field.focus(); return; }
      rememberSearch(field.value);
    }}>
      <Icon name="search" />
      <input name="q" type="search" maxLength={160} placeholder="搜索 horizon…" aria-label="搜索 horizon" />
      <button type="submit" aria-label="提交搜索"><Icon name="arrow" /></button>
    </form>
    {routes.map(({ href, label, icon }) =>
      <Link key={href} href={href} aria-current={pathname.startsWith(href.slice(0, -1)) ? "page" : undefined} onClick={() => setPanel(null)}>
        <span className="mobile-route-icon"><Icon name={icon} /></span>{label}
        <span className="mobile-route-chevron"><Icon name="chevron" /></span>
      </Link>,
    )}
    <div className="topic-navigation">
      <button aria-expanded={panel === "topics"} aria-controls="header-topics" onClick={event => toggle("topics", event.currentTarget)}>主题 <Icon name="chevron" /></button>
      <div className="header-popover topic-popover" id="header-topics" hidden={panel !== "topics"}>
        {TOPICS.map(topic => <Link key={topic.slug} href={`/topics/${topic.slug}/`} onClick={() => setPanel(null)}>{topic.label}</Link>)}
        <Link href="/topics/" onClick={() => setPanel(null)}>全部主题</Link>
      </div>
    </div>
    <div className="mobile-nav-extra">
      <Link href="/topics/" onClick={() => setPanel(null)}><Icon name="layers" />主题<Icon name="chevron" /></Link>
      <Link href="/subscribe/" onClick={() => setPanel(null)}><Icon name="external" />订阅 horizon<Icon name="chevron" /></Link>
      <ReadLaterTrigger className="reader-menu-read-later" onOpen={() => setPanel(null)} />
      <div className="mobile-theme-control">
        <span id="mobile-theme-label">外观</span>
        <div className="mobile-theme-options" role="group" aria-labelledby="mobile-theme-label">
          {themes.map(([value, label]) => <button key={value} aria-pressed={theme === value} onClick={() => changeTheme(value)}>{label}</button>)}
        </div>
      </div>
    </div>
  </>;
  return <>
    {home && <div className="progressive-header-blur" aria-hidden="true"><span/><span/><span/><span/></div>}
    <header ref={header} className={`site-header${home ? " home-header" : ""}${article ? " reader-header" : ""}${collection ? " collection-header" : ""}`}
      data-menu-open={Boolean(panel) || mobileOverlay} data-mobile-open={mobileOpen} data-mobile-layout={mobileLayout}
      data-reader-chrome={immersive} data-reader-scroll-chrome={article ? "" : undefined}>
      <div className="header-inner" data-reading-restart={Boolean(article && reader?.canRestart)}>
        <div className="header-brand-group" inert={mobileLayout && mobileOverlay}>
          {article && <ArticleBack />}
          {!article && <Link href="/" className="brand" aria-label="metaflow horizon 首页" onClick={() => setPanel(null)}><BrandMark /><span>metaflow horizon</span></Link>}
          {home && <div id="home-feed-control" aria-hidden={mobileOpen || undefined} />}
        </div>
        {article ? (readerMenuMounted && <nav ref={navigation} className="reader-more-menu" aria-label="主导航" id="main-nav"
          aria-hidden={!interactiveMenu || undefined}
          data-glass-surface="menu" data-glass-morph-from="header-menu-trigger" data-glass-morph-mode="become"
          data-ending-style={!mobileOpen ? "" : undefined}
          data-menu-opening={mobileOpen && !readerMenuReady ? "" : undefined}>
          <div className="reader-more-content" data-glass-menu-content inert={!interactiveMenu}>{menuLinks}</div>
        </nav>) : <nav ref={navigation} className={mobileOpen ? "is-open" : ""} aria-label="主导航" id="main-nav"
          inert={mobileLayout && !mobileOpen} aria-hidden={mobileLayout && !mobileOpen || undefined}>{menuLinks}</nav>}
        {article && <ReaderRestartReminder available={Boolean(reader?.canRestart)} onRestart={() => reader?.resetReading()}
          inert={mobileOverlay || cardNavigation?.busy || undefined} />}
        <div className="header-actions" inert={cardNavigation?.busy || undefined}>
          {article ? <div className="reader-header-tools" inert={mobileOverlay || undefined}>
            <ReaderFontControl onOpen={() => setPanel(null)}/><ReaderShareControl onOpen={() => setPanel(null)}/>
          </div> : <>
            <button type="button" className="search-link" data-glass-surface={immersive ? "" : undefined} data-glass-interactive={immersive ? "" : undefined}
              aria-label="搜索" aria-haspopup="dialog" aria-expanded={panel === "search" || mobileOpen}
              onClick={event => toggle("search", event.currentTarget)} inert={mobileLayout && mobileOpen}><Icon name="search" /></button>
            <div className="appearance-navigation desktop-action" inert={mobileLayout && mobileOpen} aria-hidden={mobileLayout && mobileOpen || undefined}>
              <button className="appearance-toggle" data-glass-surface={immersive ? "" : undefined} data-glass-interactive={immersive ? "" : undefined}
                aria-label="外观" aria-expanded={appearanceOpen} aria-controls="header-appearance" onClick={event => toggle("theme", event.currentTarget)}><Icon name="theme" /></button>
              <div className="header-popover appearance-popover" id="header-appearance" inert={!appearanceOpen} aria-hidden={!appearanceOpen} data-open={appearanceOpen} aria-label="显示主题">
                {themes.map(([value, label]) => <button key={value} type="button" aria-pressed={theme === value} onClick={() => changeTheme(value)}>{label}<span className="appearance-check"><Icon name="check"/></span></button>)}
                {home && <button type="button" role="switch" aria-checked={autoplay} onClick={() => setCarouselAutoplay(!autoplay)}>自动轮播<span className="appearance-switch" aria-hidden="true"/></button>}
              </div>
            </div>
            <Link className="subscribe-link desktop-action" href="/subscribe/" onClick={() => setPanel(null)} inert={mobileLayout && mobileOpen}>订阅</Link>
          </>}
          <button id="header-menu-trigger" className={`menu-toggle${article ? " lg-surface" : ""}`} data-reader-more-trigger
            data-lg-container-radius="circle" data-glass-surface={immersive ? "" : undefined} data-glass-interactive={immersive ? "" : undefined}
            aria-label={mobileOpen ? "关闭导航" : "打开导航"} aria-expanded={mobileOpen} aria-controls={!article || readerMenuMounted ? "main-nav" : undefined} onClick={(e) => toggle("mobile", e.currentTarget)}>
            <span className="header-menu-glyph" key={mobileOpen ? "close" : immersive ? "more" : "grid"}><Icon name={mobileOpen ? "close" : immersive ? "more" : "grid"} /></span>
          </button>
        </div>
      </div>
      <SearchOverlay open={panel === "search"} onClose={() => setPanel(null)} />
    </header>
  </>;
}

/** Retain the reminder for its short exit after resetReading clears canRestart. */
function ReaderRestartReminder({ available, onRestart, inert }: { available: boolean; onRestart: () => void; inert?: boolean }) {
  const [retained, setRetained] = useState(available);
  useEffect(() => {
    if (available) { setRetained(true); return; }
    const timer = window.setTimeout(() => setRetained(false), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
    return () => window.clearTimeout(timer);
  }, [available]);
  if (!available && !retained) return null;
  return <button type="button" className="reader-restart" onClick={onRestart}
    data-restart-exiting={!available || undefined} inert={inert || !available || undefined}>从头开始阅读</button>;
}
