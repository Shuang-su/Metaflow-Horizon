"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent, KeyboardEvent } from "react";
import { flattenReadingLinks, type ReadingLink } from "../lib/reading-navigation";
import { useReader } from "./ReaderProvider";
import Icon from "./Icon";
import { pushArticleHash } from "../lib/card-navigation";
import { closeReaderSheet } from "../lib/reader-sheet";
import { READING_BLOCK_SELECTOR } from "../lib/reading-progress";
import { lockDocumentScroll } from "../lib/scroll-lock";

function headingContentTop(target: Element) {
  const heading = target.matches("h1, h2, h3, h4") ? target : target.querySelector("h1, h2, h3, h4");
  if (!heading) return target.getBoundingClientRect().top;
  const style = getComputedStyle(heading);
  return heading.getBoundingClientRect().top + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0);
}

export default function ReadingNavigator({ items }: { items: ReadingLink[] }) {
  const reader = useReader();
  const openDirectory = reader?.openDirectory;
  const registerDirectory = reader?.registerDirectory;
  const [open, setOpen] = useState(false), [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [compact, setCompact] = useState(false), [active, setActive] = useState(items[0]?.id);
  const panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null), scrollList = useRef<HTMLElement>(null);
  const externalTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const openFromBar = (event: Event) => {
      const origin = (event as CustomEvent<{ origin: HTMLElement }>).detail.origin;
      if (matchMedia("(max-width: 1279px)").matches && openDirectory) { openDirectory(origin); return; }
      externalTrigger.current = origin; setOpen(true);
    };
    window.addEventListener("open-reading-navigation", openFromBar);
    return () => window.removeEventListener("open-reading-navigation", openFromBar);
  }, [openDirectory]);
  const readingPosition = useRef<{ node: Element; top: number; width: number } | null>(null);
  const shown = open || (!compact && (hovered || pinned));
  useEffect(() => {
    const media = matchMedia("(max-width: 1279px)");
    const update = () => { setCompact(media.matches); setOpen(false); setHovered(false); };
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = items[0]?.id;
      for (const item of flattenReadingLinks(items)) {
        if (item.href) continue;
        const target = document.getElementById(item.id);
        if (target && target.getClientRects().length && headingContentTop(target) <= 140) current = item.id;
      }
      setActive(current);
      // Retain a visible paragraph across width changes without animating normal scroll.
      if (!readingPosition.current || readingPosition.current.width === innerWidth) {
        const blocks = document.querySelectorAll(`${READING_BLOCK_SELECTOR}, .article-shell :is(h2,h3,p,figure), .past-daily-card`);
        const node = [...blocks].find(element => { const rect = element.getBoundingClientRect(); return rect.height > 0 && rect.bottom > 100 && rect.top < innerHeight; });
        readingPosition.current = node ? { node, top: node.getBoundingClientRect().top, width: innerWidth } : null;
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    const article = document.getElementById("article-top");
    if (article) observer.observe(article);
    const resize = () => {
      const previous = readingPosition.current;
      if (previous && previous.width !== innerWidth && previous.node.isConnected) {
        window.scrollBy({ top: previous.node.getBoundingClientRect().top - previous.top, behavior: "instant" });
        previous.width = innerWidth;
      }
      schedule();
    };
    addEventListener("scroll", schedule, { passive: true }); addEventListener("resize", resize); update();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); removeEventListener("scroll", schedule); removeEventListener("resize", resize); };
  }, [items]);
  useEffect(() => {
    if (!shown) return;
    const current = scrollList.current?.querySelector<HTMLElement>('[aria-current="location"]');
    if (current && scrollList.current) {
      const list = scrollList.current, rect = current.getBoundingClientRect(), parent = list.getBoundingClientRect();
      if (rect.top < parent.top || rect.bottom > parent.bottom) list.scrollTop += rect.top - parent.top - list.clientHeight / 3;
    }
  }, [active, shown]);
  const closeImmediately = useCallback((afterClose?: () => void) => {
    setOpen(false); setHovered(false); setPinned(false);
    requestAnimationFrame(() => {
      const origin = externalTrigger.current;
      externalTrigger.current = null;
      if (afterClose) afterClose();
      else (origin?.getClientRects().length ? origin : trigger.current)?.focus({ preventScroll: true });
    });
  }, []);
  const close = useCallback((afterClose?: () => void) => {
    if (compact && open) closeReaderSheet(panel.current, () => closeImmediately(afterClose));
    else closeImmediately(afterClose);
  }, [closeImmediately, compact, open]);
  useEffect(() => {
    if (!open) return;
    if (!compact) {
      const outside = (event: PointerEvent) => { if (!pinned && !root.current?.contains(event.target as Node)) closeImmediately(); };
      document.addEventListener("pointerdown", outside);
      return () => document.removeEventListener("pointerdown", outside);
    }
    const unlock = lockDocumentScroll();
    closeButton.current?.focus({ preventScroll: true });
    const outside = Array.from(document.querySelectorAll<HTMLElement>(
      "#main > *, .site-header, .reading-parent, .article-interaction-wrap, .site-footer, .skip-link",
    )).filter(element => !element.contains(root.current) && !element.inert);
    outside.forEach(element => { element.inert = true; });
    const trap = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>("a[href], button") || [])
        .filter(element => element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => {
      outside.forEach(element => { element.inert = false; });
      document.removeEventListener("keydown", trap);
      unlock();
    };
  }, [closeImmediately, open, compact, pinned]);
  function togglePin() { setPinned(value => !value); setOpen(false); }
  useEffect(() => {
    if (!shown) return;
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [shown, close]);
  const goTo = useCallback((id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    let parent = target.parentElement;
    while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
    pushArticleHash(id);
    const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
    const padding = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
    const destination = id === "article-top" ? 0 : window.scrollY + headingContentTop(target) - padding - 16;
    const top = Math.max(0, Math.min(destination, document.documentElement.scrollHeight - window.innerHeight));
    window.dispatchEvent(new CustomEvent("reading-navigation-jump", { detail: { top } }));
    window.scrollTo({ top, behavior });
    target.setAttribute("tabindex", "-1"); target.focus({ preventScroll: true });
    setActive(id);
  }, []);
  useLayoutEffect(() => registerDirectory?.({ items, active, jump: goTo }), [registerDirectory, items, active, goTo]);
  const jump = useCallback((event: MouseEvent<HTMLAnchorElement> | globalThis.MouseEvent, id: string) => {
    if (!document.getElementById(id) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (compact && open) close(() => goTo(id));
    else goTo(id);
  }, [close, compact, open, goTo]);
  useEffect(() => {
    // The server-rendered overview shares the directory's motion, focus, and title inset.
    const overviewJump = (event: globalThis.MouseEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>(".reading-guide a[href^='#']");
      if (!anchor) return;
      let id: string;
      try { id = decodeURIComponent(anchor.hash.slice(1)); } catch { return; }
      jump(event, id);
    };
    document.addEventListener("click", overviewJump);
    return () => document.removeEventListener("click", overviewJump);
  }, [jump]);
  function keys(event: KeyboardEvent) {
    if (event.key === "Escape" && shown) { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== "Tab" || !compact || !open) return;
    const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button, a[href], summary') || [])].filter(control => control.getClientRects().length && getComputedStyle(control).visibility !== "hidden");
    if (!controls?.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function list(entries: ReadingLink[], depth = 0) {
    return <ul className={depth ? "reading-nav-children" : undefined}>{entries.map(item => {
      const hasActive = item.id === active || flattenReadingLinks(item.children || []).some(child => child.id === active);
      return <li key={item.id}><a href={item.href || `#${item.id}`} aria-current={item.id === active ? "location" : undefined} className={hasActive ? "is-current" : undefined} onClick={item.href ? undefined : event => jump(event, item.id)}><span className="reading-nav-prefix" aria-hidden="true" /><span className="reading-nav-text">{item.title}</span></a>{item.children?.length ? <details className="reading-nav-branch" open={hasActive || undefined}><summary aria-label={`展开${item.title}子目录`}>子目录</summary>{list(item.children, depth + 1)}</details> : null}</li>;
    })}</ul>;
  }
  return <div className={`reading-navigator${shown ? " is-open" : ""}`} ref={root} onKeyDown={keys}>
    <button className={`reading-nav-backdrop${compact && open ? " is-open" : ""}`} tabIndex={-1} inert={!compact || !open} aria-hidden={!compact || !open} aria-label="关闭目录" onClick={() => close()} />
    <aside className={`reading-nav-rail${shown ? " is-open" : ""}${pinned ? " is-pinned" : ""}`} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <button className="reading-nav-ticks" aria-label="展开文章目录" aria-expanded={shown} aria-controls="reading-navigation" aria-hidden={shown} inert={shown} onClick={() => setOpen(true)} tabIndex={shown ? -1 : 0} />
      <div className="reading-nav-panel" ref={panel} id="reading-navigation" data-sheet-drag inert={!shown} aria-hidden={!shown} role={compact ? "dialog" : undefined} aria-modal={compact && open ? true : undefined} aria-label="文章目录">
        <div className="reader-sheet-handle" data-sheet-handle aria-hidden="true"/>
        <header><h2>文章目录</h2><div className="reading-nav-controls"><button className="reading-nav-pin" aria-label="固定文章目录" aria-pressed={pinned} title={pinned ? "取消固定目录" : "固定目录"} onClick={togglePin}><Icon name="pin" /></button><button className="reading-nav-close" ref={closeButton} data-sheet-close aria-label="收起文章目录" onClick={() => close()}><Icon name="close" /></button></div></header>
        <nav aria-label="快捷跳转" ref={scrollList}>{list(items)}</nav>
      </div>
    </aside>
    <div className="reading-actions">
      <button ref={trigger} className={shown ? "is-current" : undefined} aria-expanded={compact ? undefined : shown} aria-haspopup={compact ? "dialog" : undefined} aria-controls={compact ? undefined : "reading-navigation"} onClick={event => { if (shown) close(); else if (compact && openDirectory) openDirectory(event.currentTarget); else { setHovered(false); setOpen(true); } }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg><span>目录</span></button>
      <a className="reading-backtop" href="#article-top" aria-label="回到文章开头" onClick={event => jump(event, "article-top")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 11 7-7 7 7M12 4v16" /></svg></a>
    </div>
  </div>;
}
