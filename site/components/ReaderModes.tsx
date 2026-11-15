"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ReaderDirectory } from "./ReaderProvider";
import { flattenReadingLinks, type ReadingLink } from "../lib/reading-navigation";

type Mode = "directory" | "discussion";
const modes: Mode[] = ["directory", "discussion"];

/** Adapted from Guangcai's consumer-panel / loop-selector: a stationary centre
 * marker, moving labels, and a bottom-anchored rail throughout shell resizing. */
export default function ReaderModes({ initialMode, directory, jump, children }: {
  initialMode: Mode; directory: ReaderDirectory; jump: (id: string) => void; children: ReactNode;
}) {
  const [mode, setMode] = useState(initialMode);
  const [discussionVisited, setDiscussionVisited] = useState(initialMode === "discussion");
  const [height, setHeight] = useState<number>();
  const directoryContent = useRef<HTMLDivElement>(null), discussionContent = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const id = useId();

  const select = (next: Mode, focus = false) => {
    if (next === "discussion") setDiscussionVisited(true);
    setMode(next);
    if (focus) tabs.current?.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    const content = mode === "directory" ? directoryContent.current : discussionContent.current;
    if (!content) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // Leave room for the header, handle, mode rail and safe-area inset.
      const viewport = window.visualViewport?.height || innerHeight;
      setHeight(Math.min(content.scrollHeight, Math.max(80, Math.min(viewport * .65, viewport - 192))));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(content);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [mode]);

  useLayoutEffect(() => {
    if (mode !== "directory") return;
    const current = directoryContent.current?.querySelector<HTMLElement>('[aria-current="location"]');
    const scroller = current?.closest<HTMLElement>(".reader-mode-pane");
    if (current && scroller) scroller.scrollTop = Math.max(0, current.offsetTop - (height || 300) / 3);
  }, [mode, directory.active, height]);

  function list(entries: ReadingLink[]) {
    return <ul>{entries.map(item => {
      const selected = item.id === directory.active;
      const containsActive = selected || flattenReadingLinks(item.children || []).some(child => child.id === directory.active);
      return <li key={item.id}><a href={item.href || `#${item.id}`} aria-current={selected ? "location" : undefined} onClick={event => {
        if (item.href || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); jump(item.id);
      }}>{item.title}</a>{item.children?.length ? <details open={containsActive || undefined}>
        <summary>子目录<span className="sr-only">：{item.title}</span></summary>{list(item.children)}
      </details> : null}</li>;
    })}</ul>;
  }

  return <div className="reader-modes" data-mode={mode}>
    <div className="reader-mode-stage" style={height === undefined ? undefined : { height }}>
      <div id={`${id}-directory`} className="reader-mode-pane" role="tabpanel" aria-labelledby={`${id}-tab-directory`}
        aria-hidden={mode !== "directory"} inert={mode !== "directory"} data-active={mode === "directory"}>
        <div ref={directoryContent} className="reader-mode-content"><nav className="reader-mode-directory" aria-label="快捷跳转">{list(directory.items)}</nav></div>
      </div>
      <div id={`${id}-discussion`} className="reader-mode-pane" role="tabpanel" aria-labelledby={`${id}-tab-discussion`}
        aria-hidden={mode !== "discussion"} inert={mode !== "discussion"} data-active={mode === "discussion"}>
        <div ref={discussionContent} className="reader-mode-content">{discussionVisited ? children : null}</div>
      </div>
    </div>
    <div className="reader-mode-footer">
      <div ref={tabs} className="reader-mode-tabs" role="tablist" aria-label="阅读面板" onKeyDown={event => {
        let next: Mode;
        if (event.key === "ArrowLeft" || event.key === "Home") next = "directory";
        else if (event.key === "ArrowRight" || event.key === "End") next = "discussion";
        else return;
        event.preventDefault(); select(next, true);
      }} onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0) return;
        suppressClick.current = false;
        gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      }} onPointerMove={event => {
        const drag = gesture.current;
        if (!drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (!drag.moved && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) { gesture.current = null; return; }
        if (Math.abs(dx) > 7) { drag.moved = true; event.currentTarget.setPointerCapture(event.pointerId); }
      }} onPointerUp={event => {
        const drag = gesture.current;
        gesture.current = null;
        if (!drag || drag.id !== event.pointerId) return;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (drag.moved) {
          suppressClick.current = true;
          if (Math.abs(event.clientX - drag.x) > 28) select(event.clientX < drag.x ? "discussion" : "directory", true);
        }
      }} onPointerCancel={() => { gesture.current = null; }} onClickCapture={event => {
        if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); }
      }}>
        <span className="reader-mode-indicator" aria-hidden="true"/>
        {modes.map(value => <button key={value} type="button" role="tab" id={`${id}-tab-${value}`} data-mode={value}
          aria-selected={mode === value} aria-controls={`${id}-${value}`} tabIndex={mode === value ? 0 : -1}
          onClick={() => select(value)}>{value === "directory" ? "目录" : "讨论"}</button>)}
      </div>
    </div>
  </div>;
}
