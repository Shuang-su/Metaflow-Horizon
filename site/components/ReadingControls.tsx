"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { READER_FONT_MAX, READER_FONT_MIN } from "../lib/reader";
import { useReader } from "./ReaderProvider";
import Icon from "./Icon";

const FONT_PANEL_GAP = 8;
const FONT_PANEL_VIEWPORT_MARGIN = 12;
const FONT_PANEL_MOTION_TIMEOUT = 750;

type FontPanelPhase = "closed" | "opening" | "open" | "closing";
type FontPanelAnchor = Pick<CSSProperties, "top" | "left" | "maxHeight">;

export function ReaderFontControl({ onOpen }: { onOpen?: () => void }) {
  const reader = useReader();
  const [phase, setPhase] = useState<FontPanelPhase>("closed");
  const [mobile, setMobile] = useState(false);
  const [active, setActive] = useState(false);
  const [anchor, setAnchor] = useState<FontPanelAnchor | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const mounted = phase !== "closed";
  const expanded = phase === "opening" || phase === "open";
  const size = reader?.fontSize ?? (mobile ? 15 : 17);
  const progress = (size - READER_FONT_MIN) / (READER_FONT_MAX - READER_FONT_MIN);

  const close = useCallback((restoreFocus: boolean) => {
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
    setActive(false);
    setPhase("closing");
  }, []);

  useEffect(() => {
    const media = matchMedia("(max-width: 767px)");
    const sync = () => setMobile(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    setPhase("closed");
    setActive(false);
    setAnchor(null);
  }, [reader?.article?.id]);

  useLayoutEffect(() => {
    if (!mounted) return;
    const origin = trigger.current;
    const element = panel.current;
    if (!origin || !element) return;

    const place = () => {
      const bounds = origin.getBoundingClientRect();
      const viewport = document.documentElement;
      const top = bounds.bottom + FONT_PANEL_GAP;
      const margin = FONT_PANEL_VIEWPORT_MARGIN;
      const left = Math.max(margin, Math.min(viewport.clientWidth - element.offsetWidth - margin, bounds.right - element.offsetWidth));
      const maxHeight = Math.max(0, viewport.clientHeight - top - margin);
      setAnchor(previous => previous?.top === top && previous.left === left && previous.maxHeight === maxHeight
        ? previous : { top, left, maxHeight });
    };

    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [mounted]);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || (phase !== "opening" && phase !== "closing")) return;
    const entering = phase === "opening";
    const eventName = entering ? "glass:entered" : "glass:exited";
    const finish = () => {
      if (!entering) setAnchor(null);
      setPhase(entering ? "open" : "closed");
    };
    element.addEventListener(eventName, finish, { once: true });
    const timeout = window.setTimeout(finish, FONT_PANEL_MOTION_TIMEOUT);
    return () => {
      element.removeEventListener(eventName, finish);
      window.clearTimeout(timeout);
    };
  }, [phase]);

  useLayoutEffect(() => {
    if (phase === "open") slider.current?.focus({ preventScroll: true });
  }, [phase]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || panel.current?.contains(target) || trigger.current?.contains(target)) return;
      close(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", keydown, true);
    };
  }, [expanded, close]);

  return <div className="reader-font-control">
    <button ref={trigger} id="reader-font-trigger" type="button" className="reader-font-trigger reader-chrome-control lg-surface"
      data-glass-surface data-glass-interactive data-lg-container-radius="circle"
      aria-label="调整字号" aria-haspopup="dialog" aria-expanded={expanded} aria-controls={mounted ? "reader-font-panel" : undefined}
      onClick={() => {
        if (expanded) close(true);
        else {
          onOpen?.();
          setPhase("opening");
        }
      }}><span>字</span></button>
    {mounted && createPortal(
      <div ref={panel} id="reader-font-panel" className="reader-font-panel" role="dialog" aria-labelledby="reader-font-heading"
        aria-hidden={phase !== "open" || undefined} style={anchor ?? undefined}
        data-glass-surface="menu" data-glass-morph-from="reader-font-trigger" data-lg-container-radius="24"
        data-starting-style={anchor ? undefined : ""} data-font-opening={phase === "opening" ? "" : undefined}
        data-ending-style={phase === "closing" ? "" : undefined}>
        <div className="reader-font-content" inert={phase !== "open"}>
          <header>
            <div><h2 id="reader-font-heading">字体大小</h2><output htmlFor="reader-font-size">{size} px</output></div>
            <button type="button" className="reader-dialog-close" aria-label="关闭字号面板" onClick={() => close(true)}><Icon name="close"/></button>
          </header>
          <div className="reader-font-scale">
            <span className="reader-font-a-small" aria-hidden="true">A</span>
            <div className="reader-font-range" data-glass-scope>
              <div className="reader-font-graphics" aria-hidden="true" style={{ "--reader-slider-progress": progress } as CSSProperties}>
                <span className="reader-font-rail" data-glass-source><span/></span>
                <span className="reader-font-thumb" data-glass-surface="slider" data-press-phase={active ? "pressed" : "released"}/>
              </div>
              <div className="reader-font-optics" data-glass-optics-host aria-hidden="true"/>
              <input ref={slider} id="reader-font-size" aria-label="正文字号" aria-valuetext={`${size} 像素`} type="range" min={READER_FONT_MIN} max={READER_FONT_MAX} step={1} value={size}
                onChange={event => reader?.setFontSize(Number(event.currentTarget.value))}
                onPointerDown={event => {
                  if (!event.isPrimary || event.button !== 0) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setActive(true);
                }}
                onPointerUp={() => setActive(false)} onPointerCancel={() => setActive(false)} onLostPointerCapture={() => setActive(false)} onBlur={() => setActive(false)}/>
            </div>
            <span className="reader-font-a-large" aria-hidden="true">A</span>
          </div>
          <footer><button type="button" onClick={() => reader?.setFontSize(null)}>默认字号</button></footer>
        </div>
      </div>, document.body)}
  </div>;
}

export function ReaderShareControl({ onOpen }: { onOpen?: () => void }) {
  const reader = useReader();
  return <button type="button" className="reader-share-trigger reader-chrome-control" data-glass-surface data-glass-interactive aria-label="分享文章" title="分享文章" onClick={event => {
    onOpen?.();
    reader?.share(event.currentTarget);
  }}><Icon name="share"/></button>;
}
