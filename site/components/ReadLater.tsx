"use client";

import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, PointerEvent } from "react";
import { createPortal } from "react-dom";
import { lockDocumentScroll } from "../lib/scroll-lock";
import { BASE } from "../lib/catalog";
import type { ReadLaterArticle } from "../lib/read-later";
import { readReadingPosition, requestReadingResume } from "../lib/reading-progress";
import { useReader } from "./ReaderProvider";
import Icon from "./Icon";

const labels = { daily: "日报", editorial: "专题文章", weekly: "每周汇总" };
const motionPreference = "(prefers-reduced-motion: reduce)";
const triggerPositions = new WeakMap<HTMLElement, DOMRect>();
const railStep = 68;

export function ReadLaterTrigger({ className, onOpen }: { className?: string; onOpen?: () => void }) {
  const reader = useReader();
  const count = reader?.readLaterIds.length || 0;
  if (!reader || !count) return null;

  return <button type="button" className={`read-later-trigger ${className ?? ""}`} aria-haspopup="dialog"
    aria-label={`稍后阅读，${count} 篇`} title="稍后阅读"
    onClick={event => {
      triggerPositions.set(event.currentTarget, event.currentTarget.getBoundingClientRect());
      reader.openReadLater(event.currentTarget);
      onOpen?.();
    }}>
    <Icon name="bookmark"/><span className="read-later-trigger-label">稍后阅读</span>
    <span className="read-later-count" aria-hidden="true">{count}</span>
  </button>;
}

function Cover({ article }: { article: ReadLaterArticle }) {
  const [failed, setFailed] = useState(false);
  return <span className="read-later-cover" aria-hidden="true">
    {article.cover && !failed ? <img src={article.cover} alt="" draggable={false} onError={() => setFailed(true)}/> :
      <span className="read-later-cover-date"><strong>{article.date.slice(5).replace("-", "/")}</strong><span>{labels[article.kind]}</span></span>}
  </span>;
}

function revealBounds(element: HTMLElement, from?: DOMRect) {
  const { left, top, width, height } = element.getBoundingClientRect();
  const x = from ? from.left + from.width / 2 - left : width;
  const y = from ? from.top + from.height / 2 - top : height;
  const radius = Math.hypot(Math.max(Math.abs(x), Math.abs(width - x)), Math.max(Math.abs(y), Math.abs(height - y)));
  return [`circle(0px at ${x}px ${y}px)`, `circle(${radius + 4}px at ${x}px ${y}px)`];
}

function isVisible(element: HTMLElement | null): element is HTMLElement {
  return !!element?.isConnected && element.getClientRects().length > 0 &&
    !element.closest('[inert], [aria-hidden="true"]') && getComputedStyle(element).visibility === "visible";
}

function focusReturnTarget(origin: HTMLElement) {
  if (isVisible(origin)) return origin;
  const menu = document.querySelector<HTMLElement>("[data-reader-more-trigger]");
  if (isVisible(menu)) return menu;
  const brand = document.querySelector<HTMLAnchorElement>(".home-header .brand[href]");
  return isVisible(brand) ? brand : null;
}

function ReadLaterRow({ item, revealed, reveal, remove, continueReading }: {
  item: ReadLaterArticle; revealed: boolean; reveal: (open: boolean) => void; remove: () => void;
  continueReading: (event: MouseEvent<HTMLAnchorElement>, item: ReadLaterArticle) => void;
}) {
  const action = useId();
  const swipe = useRef<{ id: number; x: number; y: number; horizontal: boolean } | null>(null);
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (event.type === "lostpointercapture" && event.target !== event.currentTarget) return;
    const start = swipe.current;
    if (!start || event.pointerId !== start.id) return;
    swipe.current = null;
    delete event.currentTarget.dataset.swiping;
    event.currentTarget.style.removeProperty("--row-shift");
    if (event.type !== "pointerup" || !start.horizontal) return;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) >= 28) reveal(dx < 0);
  };
  return <li className="read-later-row" data-revealed={revealed}>
    <div className="read-later-row-content" onPointerDown={event => {
      if (!event.isPrimary || event.pointerType === "mouse") return;
      swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY, horizontal: false };
    }} onPointerMove={event => {
      const start = swipe.current;
      if (!start || event.pointerId !== start.id) return;
      const dx = event.clientX - start.x;
      if (!start.horizontal) {
        if (Math.abs(dx) <= 8 || Math.abs(dx) <= Math.abs(event.clientY - start.y)) return;
        start.horizontal = true;
        event.currentTarget.dataset.swiping = "";
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      const position = Math.max(-76, Math.min(0, (revealed ? -76 : 0) + dx));
      event.currentTarget.style.setProperty("--row-shift", `${position}px`);
    }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}>
      <Link href={item.url} onClick={event => continueReading(event, item)}>
        <div><p className="read-later-meta">{labels[item.kind]} · <time dateTime={item.date}>{item.date}</time></p><h3>{item.title}</h3></div>
        <Cover article={item}/>
      </Link>
      <button type="button" className="read-later-row-more" aria-expanded={revealed} aria-controls={action}
        aria-label={`《${item.title}》的操作`} onClick={() => reveal(!revealed)}><Icon name="more"/></button>
    </div>
    <button type="button" id={action} className="read-later-row-remove" aria-label={`移除《${item.title}》`} tabIndex={revealed ? 0 : -1}
      aria-hidden={!revealed} onClick={remove}><Icon name="trash"/>移除</button>
  </li>;
}

export default function ReadLater({ origin, items, close, removeItem, restoreItem, kind = "readLater", storageNotice = "" }: {
  storageNotice?: string;
  kind?: "readLater" | "favorites";
  origin: HTMLElement; items: ReadLaterArticle[]; close: () => void; removeItem: (id: string) => boolean;
  restoreItem: (id: string, previous?: string, next?: string) => boolean;
}) {
  const title = useId();
  const favorites = kind === "favorites";
  const label = favorites ? "收藏" : "稍后阅读";
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const selector = useRef<HTMLDivElement>(null);
  const reveal = useRef<Animation | null>(null);
  const continueHere = useRef<string | null>(null);
  const touch = useRef<{ id: number; x: number; y: number; dragging: boolean } | null>(null);
  const wheel = useRef({ distance: 0, timeout: 0 });
  const [activeId, setActiveId] = useState(items[0]?.id);
  const [all, setAll] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia(motionPreference).matches);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ item: ReadLaterArticle; previous?: string; next?: string } | null>(null);
  const [error, setError] = useState("");
  const activeIndex = Math.max(0, items.findIndex(item => item.id === activeId));
  const active = items[activeIndex];
  const list = favorites || all || reduced;

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const unlock = lockDocumentScroll();
    element.showModal();
    closeButton.current?.focus();
    const rect = triggerPositions.get(origin) || (isVisible(origin) ? origin.getBoundingClientRect() : undefined);
    if (!matchMedia(motionPreference).matches) {
      reveal.current = element.animate({ clipPath: revealBounds(element, rect) }, {
        duration: 320, easing: "cubic-bezier(.2,.8,.2,1)",
      });
    }
    const frame = requestAnimationFrame(() => { element.dataset.revealed = ""; });
    return () => {
      cancelAnimationFrame(frame);
      reveal.current?.cancel();
      element.close();
      unlock();
      if (continueHere.current) { requestReadingResume(continueHere.current); return; }
      focusReturnTarget(origin)?.focus({ preventScroll: true });
    };
  }, [origin]);

  useEffect(() => {
    const preference = matchMedia(motionPreference);
    const change = () => setReduced(preference.matches);
    preference.addEventListener("change", change);
    return () => preference.removeEventListener("change", change);
  }, []);

  useEffect(() => () => {
    window.clearTimeout(wheel.current.timeout);
    wheel.current.distance = 0;
    touch.current = null;
  }, [list]);

  const move = (step: number) => setActiveId(current => {
    const index = Math.max(0, items.findIndex(item => item.id === current));
    return items[Math.max(0, Math.min(items.length - 1, index + step))]?.id;
  });

  const paintRail = (distance: number) => {
    const indexShift = distance / railStep;
    const atEdge = (indexShift < 0 && activeIndex === 0) || (indexShift > 0 && activeIndex === items.length - 1);
    selector.current?.style.setProperty("--rail-shift", String(atEdge ? Math.max(-.25, Math.min(.25, indexShift * .25)) :
      Math.max(-.95, Math.min(.95, indexShift))));
  };

  const settleRail = (distance: number) => {
    const rail = selector.current;
    if (!rail) return;
    delete rail.dataset.scrubbing;
    rail.style.removeProperty("--rail-shift");
    if (Math.abs(distance) >= 25) move(Math.sign(distance));
  };

  const finishTouch = (event: PointerEvent<HTMLDivElement>) => {
    if (event.type === "lostpointercapture" && event.target !== event.currentTarget) return;
    const start = touch.current;
    if (!start || start.id !== event.pointerId) return;
    touch.current = null;
    if (start.dragging) settleRail(event.type === "pointerup" ? start.y - event.clientY : 0);
  };

  const remove = (item: ReadLaterArticle) => {
    if (!removeItem(item.id)) { setError("浏览器暂时无法更新稍后阅读。"); return; }
    const index = items.indexOf(item);
    setError("");
    setRemoved({ item, previous: items[index - 1]?.id, next: items[index + 1]?.id });
    setOpenRow(null);
    if (item.id === active?.id) setActiveId((items[activeIndex + 1] || items[activeIndex - 1])?.id);
    if (list) requestAnimationFrame(() => {
      const links = dialog.current?.querySelectorAll<HTMLElement>(".read-later-row a");
      const next = Math.min(index, (links?.length || 0) - 1);
      (links?.[next] || closeButton.current)?.focus({ preventScroll: true });
    });
    else if (items.length === 1) closeButton.current?.focus({ preventScroll: true });
  };

  function dismiss() {
    const element = dialog.current;
    if (!element || matchMedia(motionPreference).matches || element.hasAttribute("data-sheet-released")) { close(); return; }
    if (element.hasAttribute("data-sheet-closing")) return;
    element.dataset.sheetClosing = "";
    delete element.dataset.revealed;
    const rect = isVisible(origin) ? origin.getBoundingClientRect() : triggerPositions.get(origin);
    const [collapsed, expanded] = revealBounds(element, rect);
    const current = getComputedStyle(element).clipPath;
    reveal.current?.cancel();
    reveal.current = element.animate({ clipPath: [current === "none" ? expanded : current, collapsed] }, {
      duration: 220, easing: "cubic-bezier(.4,0,.7,.4)", fill: "forwards",
    });
    reveal.current.onfinish = close;
  }

  function continueReading(event: MouseEvent<HTMLAnchorElement>, item: ReadLaterArticle) {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const url = BASE + item.url;
    if (url.replace(/\/$/, "") === location.pathname.replace(/\/$/, "")) {
      event.preventDefault();
      continueHere.current = url;
      dismiss();
      return;
    }
    requestReadingResume(url);
    close();
  }

  return createPortal(<dialog ref={dialog} className={`read-later-dialog${favorites ? " favorites-dialog" : ""}`} data-sheet-drag aria-labelledby={title}
    onCancel={event => { event.preventDefault(); dismiss(); }}
    onClick={event => { if (event.target === event.currentTarget) dismiss(); }}>
    <div className="reader-dialog-content read-later-content">
      {!favorites && active?.cover && <img key={active.id} className="read-later-art" src={active.cover} alt="" aria-hidden="true"
        onError={event => { event.currentTarget.hidden = true; }}/>}
      <div className="read-later-handle" data-sheet-handle aria-hidden="true"/>
      <header className="reader-dialog-header">
        <h2 id={title}>{label} {items.length > 0 && <span className="read-later-count">{items.length}</span>}</h2>
        <button ref={closeButton} type="button" className="reader-dialog-close" aria-label={`关闭${label}`} data-sheet-close onClick={dismiss}><Icon name="close"/></button>
      </header>
      {storageNotice && <p className="saved-storage-notice" role="status">{storageNotice}</p>}
      {!active ? <div className="read-later-empty"><Icon name="bookmark"/><p>{favorites ? "还没有收藏的文章" : "还没有待阅读的文章"}</p><span>{favorites ? "点击文章底部的书签，将它加入收藏。" : "从文章更多菜单加入，或侧滑返回时拖入右下角托盘。"}</span></div> : list ? (
        <ol className="read-later-list">{items.map(item => <ReadLaterRow key={item.id} item={item}
          revealed={openRow === item.id} reveal={open => setOpenRow(open ? item.id : null)} remove={() => remove(item)} continueReading={continueReading}/>)}</ol>
      ) : (
        <div className="read-later-carousel">
          <div className="read-later-detail">
            <div aria-live="polite"><p className="read-later-meta">{labels[active.kind]} · <time dateTime={active.date}>{active.date}</time></p><h3>{active.title}</h3>
              {active.summary && <p className="read-later-summary">{active.summary}</p>}
            </div>
            <div className="read-later-actions">
              <Link href={active.url} onClick={event => continueReading(event, active)}>{readReadingPosition(active.id) ? "继续阅读" : "阅读文章"}<Icon name="arrow"/></Link>
              <button type="button" aria-label={`移除《${active.title}》`} onClick={() => remove(active)}><Icon name="trash"/></button>
            </div>
            {items.length > 1 && <div className="read-later-paging">
              <button type="button" aria-label="上一篇" disabled={activeIndex === 0} onClick={() => move(-1)}><Icon name="chevron"/></button>
              <span>{activeIndex + 1} / {items.length}</span>
              <button type="button" aria-label="下一篇" disabled={activeIndex === items.length - 1} onClick={() => move(1)}><Icon name="chevron"/></button>
            </div>}
          </div>
          <div ref={selector} tabIndex={0} className="read-later-track" role="group" aria-label="稍后阅读封面，用上下方向键浏览"
            onKeyDown={event => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              move(event.key === "ArrowDown" ? 1 : -1);
              selector.current?.focus({ preventScroll: true });
            }}
            onWheel={event => {
              if (event.ctrlKey || touch.current?.dragging || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
              const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? event.currentTarget.clientHeight : 1;
              wheel.current.distance += event.deltaY * unit;
              event.currentTarget.dataset.scrubbing = "";
              const steps = Math.trunc(wheel.current.distance / railStep);
              if (steps) {
                move(steps);
                wheel.current.distance -= steps * railStep;
              }
              paintRail(wheel.current.distance);
              window.clearTimeout(wheel.current.timeout);
              wheel.current.timeout = window.setTimeout(() => {
                settleRail(wheel.current.distance);
                wheel.current.distance = 0;
              }, 90);
            }}
            onPointerDown={event => {
              if (!event.isPrimary || event.button !== 0) return;
              window.clearTimeout(wheel.current.timeout);
              wheel.current.distance = 0;
              settleRail(0);
              touch.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
            }}
            onPointerMove={event => {
              const start = touch.current;
              if (!start || start.id !== event.pointerId) return;
              const distance = start.y - event.clientY;
              if (!start.dragging) {
                if (Math.abs(distance) <= 7 || Math.abs(distance) <= Math.abs(event.clientX - start.x)) return;
                start.dragging = true;
                event.currentTarget.dataset.scrubbing = "";
                event.currentTarget.setPointerCapture(event.pointerId);
              }
              paintRail(distance);
            }}
            onPointerLeave={() => { if (!touch.current?.dragging) touch.current = null; }}
            onPointerUp={finishTouch} onPointerCancel={finishTouch} onLostPointerCapture={finishTouch}>
            {items.slice(Math.max(0, activeIndex - 3), activeIndex + 4).map((item, index) => {
              const step = Math.max(0, activeIndex - 3) + index - activeIndex;
              return <button key={item.id} type="button" className="read-later-thumbnail" aria-pressed={step === 0}
                tabIndex={-1} aria-label={item.title} style={{ "--step": step, zIndex: 4 - Math.abs(step) } as CSSProperties}
                onClick={() => { setActiveId(item.id); selector.current?.focus({ preventScroll: true }); }}><Cover article={item}/></button>;
            })}
          </div>
        </div>
      )}
      <footer className="read-later-footer">
        <div role="status">{error || (removed ? `已移除《${removed.item.title}》` : "")}</div>
        {removed && <button type="button" onClick={() => {
          if (!restoreItem(removed.item.id, removed.previous, removed.next)) { setError("浏览器暂时无法撤销移除。"); return; }
          setActiveId(removed.item.id);
          setRemoved(null);
          setError("");
          closeButton.current?.focus({ preventScroll: true });
        }}>撤销</button>}
        {items.length > 0 && !reduced && !favorites && <button type="button" onClick={() => { setAll(!all); setOpenRow(null); }}>{all ? "返回封面" : "查看全部"}</button>}
      </footer>
    </div>
  </dialog>, document.body);
}
