"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./collection.module.css";

export default function CollectionHeading({ count }: { count: number }) {
  const marker = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const boundary = marker.current;
    if (!boundary) return;
    const headerHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-height")) || 56;
    const update = () => setCompact(boundary.getBoundingClientRect().top <= headerHeight);
    const observer = new IntersectionObserver(update, { rootMargin: `-${headerHeight}px 0px 0px 0px` });
    observer.observe(boundary);
    update();
    return () => observer.disconnect();
  }, []);
  return <>
    <header className={styles.heading}>
      <h1 id="daily-collection-title">高斯日报</h1>
      <p>共 {count} 期</p>
    </header>
    <div ref={marker} className={styles.headingBoundary} aria-hidden="true"/>
    <div className={styles.stickyHeading} data-compact={compact} aria-hidden="true">
      <div><strong>高斯日报</strong><span>共 {count} 期</span></div>
    </div>
  </>;
}
