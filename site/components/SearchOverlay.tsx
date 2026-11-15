"use client";
import { useEffect, useRef, useState } from "react";
import { BASE } from "../lib/catalog";
import { clearSearchHistory, readSearchHistory, rememberSearch, searchTerm } from "../lib/search-history";
import { lockDocumentScroll } from "../lib/scroll-lock";
import Icon from "./Icon";
import SearchHistory from "./SearchHistory";

export default function SearchOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const exit = useRef<Animation | null>(null);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current;
    const previousFocus = element.closest("header")?.querySelector<HTMLElement>(".search-link") ?? (document.activeElement as HTMLElement | null);
    setQuery(""); setRecent(readSearchHistory());
    const unlock = lockDocumentScroll();
    element.showModal();
    const frame = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(frame);
      element.close();
      exit.current?.cancel();
      exit.current = null;
      delete element.dataset.searchClosing;
      unlock();
      if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus({ preventScroll: true });
    };
  }, [open]);
  function dismiss() {
    const element = dialog.current;
    if (!element?.open || exit.current) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !element.animate) { onClose(); return; }
    const { opacity, translate } = getComputedStyle(element);
    element.dataset.searchClosing = "";
    const animation = element.animate([{ opacity, translate }, { opacity: 0, translate: "0 6px" }], {
      duration: 150, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards",
    });
    exit.current = animation;
    animation.onfinish = () => { if (exit.current === animation && element.open) onClose(); };
  }
  return <dialog ref={dialog} className="search-overlay" aria-label="搜索 horizon" onCancel={(event) => { event.preventDefault(); dismiss(); }} onKeyDown={(event) => {
    if (event.key !== "Tab") return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("input, button, a[href]")).filter((element) => element.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismiss();
  }}>
    <div className="search-overlay-content">
      <form className="search-query-bar" action={`${BASE}/search/`} method="get" role="search" onSubmit={(event) => {
        if (!searchTerm(query)) { event.preventDefault(); input.current?.focus(); return; }
        rememberSearch(query); onClose();
      }}>
        <Icon name="search" /><input ref={input} name="q" value={query} onChange={(event) => setQuery(event.target.value)} type="search" maxLength={160} placeholder="搜索 horizon…" aria-label="搜索 horizon" />
        {query && <button type="button" className="search-clear" aria-label="清空关键词" onClick={() => { setQuery(""); input.current?.focus(); }}><Icon name="close" /></button>}
        <button className="search-submit-accessible" type="submit">搜索</button>
      </form>
      <SearchHistory items={recent} onClear={() => { clearSearchHistory(); setRecent([]); input.current?.focus(); }} onNavigate={onClose} />
    </div>
  </dialog>;
}
