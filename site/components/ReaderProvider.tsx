"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { readerFontSize, readerShareUrl, readerThreadTerm, restoreReaderScroll, READER_FONT_KEY } from "../lib/reader";
import { loadSavedCollections, readSavedCollections, READ_LATER_KEY, SAVED_ARTICLES_KEY, LEGACY_BOOKMARK_PREFIX, writeSavedCollections, addReadLaterId } from "../lib/read-later";
import type { ReadLaterArticle } from "../lib/read-later";
import { useReadingProgress } from "./useReadingProgress";
import ReadLater from "./ReadLater";
import type { ReadingLink } from "../lib/reading-navigation";
import type { ReaderIdentity } from "../lib/reader";
import { DISCUSSIONS } from "../lib/discussions";
import ReaderPanels from "./ReaderPanels";

export interface ReaderThread {
  article: ReaderIdentity;
  term: string;
  eventId?: string;
  anchor?: string;
  sampleIndex?: number;
}

export interface ReaderDirectory {
  items: ReadingLink[];
  active?: string;
  jump: (id: string) => void;
}

type ReaderPanel =
  | { kind: "discussion" | "directory"; thread: ReaderThread; origin: HTMLElement | null }
  | { kind: "share"; url: string; origin: HTMLElement };

interface ReaderState {
  article: ReaderIdentity | null;
  fontSize: number | null;
  setFontSize: (size: number | null) => void;
  share: (origin: HTMLElement) => void;
  openDiscussion: (origin: HTMLElement | null, thread?: Omit<ReaderThread, "term">) => void;
  openDirectory: (origin: HTMLElement | null) => void;
  registerDirectory: (directory: ReaderDirectory) => () => void;
  counts: Record<string, number>;
  savedStorageNotice: string;
  readLaterIds: string[];
  addReadLater: (id: string) => boolean;
  favoriteIds: string[];
  toggleFavorite: (id: string) => boolean;
  openFavorites: (origin: HTMLElement) => void;
  openReadLater: (origin: HTMLElement) => void;
  canRestart: boolean;
  resetReading: () => void;
}

const Reader = createContext<ReaderState | null>(null);
const Register = createContext<(article: ReaderIdentity) => () => void>(() => () => {});

export default function ReaderProvider({ children, catalogue }: { children: ReactNode; catalogue: ReadLaterArticle[] }) {
  const pathname = usePathname();
  const [registered, setRegistered] = useState<ReaderIdentity | null>(null);
  const [fontSize, setFont] = useState<number | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [directory, setDirectory] = useState<ReaderDirectory | null>(null);
  const [panel, setPanel] = useState<ReaderPanel | null>(null);
  const article = registered && registered.url.replace(/\/$/, "") === pathname.replace(/\/$/, "") ? registered : null;

  const [savedStorageNotice, setSavedStorageNotice] = useState("");
  const [readLaterIds, setReadLaterIds] = useState<string[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [favoritesOrigin, setFavoritesOrigin] = useState<HTMLElement | null>(null);
  const [readLaterOrigin, setReadLaterOrigin] = useState<HTMLElement | null>(null);
  const { canRestart, resetReading } = useReadingProgress(article);
  const known = useMemo(() => new Map(catalogue.map(item => [item.id, item])), [catalogue]);

  useEffect(() => {
    const load = () => {
      try {
        const { collections: saved, persisted } = loadSavedCollections(localStorage, catalogue);
        setReadLaterIds(saved.readLaterIds.filter(id => known.has(id)));
        setFavoriteIds(saved.favoriteIds.filter(id => known.has(id)));
        setSavedStorageNotice(persisted ? "" : "浏览器暂时无法保存更新；目前显示旧记录，收藏与稍后阅读的迁移尚未保存。");
      } catch { setSavedStorageNotice("浏览器暂时无法读取收藏与稍后阅读记录。"); }
    };
    load();
    const sync = (event: StorageEvent) => {
      if (event.key === SAVED_ARTICLES_KEY || event.key === READ_LATER_KEY || event.key?.startsWith(LEGACY_BOOKMARK_PREFIX) || event.key === null) load();
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [catalogue, known]);

  const updateCollection = useCallback((kind: "readLaterIds" | "favoriteIds", id: string, update: (current: string[]) => string[]) => {
    if (!known.has(id)) return false;
    try {
      const current = readSavedCollections(localStorage, catalogue);
      const next = { ...current, [kind]: update(current[kind]) };
      writeSavedCollections(localStorage, next);
      setSavedStorageNotice("");
      setReadLaterIds(next.readLaterIds.filter(item => known.has(item)));
      setFavoriteIds(next.favoriteIds.filter(item => known.has(item)));
      return true;
    } catch { setSavedStorageNotice("浏览器暂时无法保存更新；当前修改未保存，原记录保持不变。"); return false; }
  }, [catalogue, known]);
  const updateReadLater = useCallback((id: string, update: (current: string[]) => string[]) =>
    updateCollection("readLaterIds", id, update), [updateCollection]);
  const updateFavorite = useCallback((id: string, update: (current: string[]) => string[]) =>
    updateCollection("favoriteIds", id, update), [updateCollection]);
  const addReadLater = useCallback((id: string) => updateReadLater(id, current => addReadLaterId(current, id)), [updateReadLater]);
  const toggleFavorite = useCallback((id: string) => updateFavorite(id, current =>
    current.includes(id) ? current.filter(item => item !== id) : [id, ...current]), [updateFavorite]);
  const openReadLater = useCallback((origin: HTMLElement) => {
    setPanel(null); setFavoritesOrigin(null); setReadLaterOrigin(origin);
  }, []);
  const openFavorites = useCallback((origin: HTMLElement) => {
    setPanel(null); setReadLaterOrigin(null); setFavoritesOrigin(origin);
  }, []);

  const register = useCallback((identity: ReaderIdentity) => {
    setRegistered(identity);
    return () => setRegistered(current => current === identity ? null : current);
  }, []);

  useEffect(() => {
    let size = null;
    try {
      const stored = localStorage.getItem(READER_FONT_KEY);
      size = readerFontSize(stored);
      if (size !== null && String(size) !== stored) localStorage.setItem(READER_FONT_KEY, String(size));
    } catch {}
    setFont(size);
    if (size !== null) document.documentElement.style.setProperty("--reader-font-size", `${size}px`);
  }, []);

  const setFontSize = useCallback((size: number | null) => {
    const main = document.getElementById("main");
    const anchor = document.elementsFromPoint(innerWidth / 2, Math.min(innerHeight / 3, 220))
      .map(element => element.closest(".prose p, .prose li, .prose h2, .prose h3, .event-title"))
      .find(element => element && main?.contains(element)) || Array.from(main?.querySelectorAll(".prose p, .event-title") || [])
      .find(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.height > 0 && bounds.bottom > 85 && bounds.top < innerHeight;
      });
    const before = anchor?.getBoundingClientRect().top;
    if (size === null) document.documentElement.style.removeProperty("--reader-font-size");
    else document.documentElement.style.setProperty("--reader-font-size", `${size}px`);
    if (anchor && before !== undefined) {
      const offset = anchor.getBoundingClientRect().top - before;
      if (offset) window.scrollBy({ top: offset, behavior: "instant" });
    }
    setFont(size);
    try {
      if (size === null) localStorage.removeItem(READER_FONT_KEY);
      else localStorage.setItem(READER_FONT_KEY, String(size));
    } catch {}
  }, []);

  const openDiscussion = useCallback((origin: HTMLElement | null, target?: Omit<ReaderThread, "term">) => {
    const current = target || (article && { article });
    if (!current) return;
    setReadLaterOrigin(null); setFavoritesOrigin(null);
    setPanel({ kind: "discussion", thread: { ...current, term: readerThreadTerm(current.article, current.eventId) }, origin });
  }, [article]);

  const registerDirectory = useCallback((next: ReaderDirectory) => {
    setDirectory(next);
    return () => setDirectory(current => current === next ? null : current);
  }, []);

  const openDirectory = useCallback((origin: HTMLElement | null) => {
    if (!article) return;
    setReadLaterOrigin(null); setFavoritesOrigin(null);
    setPanel({ kind: "directory", thread: { article, term: readerThreadTerm(article) }, origin });
  }, [article]);

  const share = useCallback(async (origin: HTMLElement) => {
    if (!article) return;
    const current = new URL(location.href);
    const url = readerShareUrl(article, current);
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: article.title, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    if (origin.isConnected && location.pathname === current.pathname) setPanel({ kind: "share", url, origin });
  }, [article]);

  const reportCount = useCallback((term: string, count: number) => {
    setCounts(current => current[term] === count ? current : { ...current, [term]: count });
  }, []);

  useEffect(() => { setPanel(null); setReadLaterOrigin(null); setFavoritesOrigin(null); }, [pathname]);

  useEffect(() => {
    if (!article || !DISCUSSIONS) return;
    try {
      const current = new URL(location.href);
      const session = current.searchParams.get("giscus");
      if (!session) return;
      current.searchParams.delete("giscus");
      history.replaceState(history.state, "", current);
      try { localStorage.setItem("giscus-session", JSON.stringify(session)); } catch {}
      const pending = JSON.parse(sessionStorage.getItem("gsd:giscus-return:v1") || "null");
      sessionStorage.removeItem("gsd:giscus-return:v1");
      if (pending?.id !== article.id || typeof pending.path !== "string") return;
      const path = new URL(pending.path, current);
      if (path.origin !== current.origin || path.pathname !== current.pathname) return;
      history.replaceState(history.state, "", path);
      const candidate = typeof pending.anchor === "string" ? document.getElementById(pending.anchor) : null;
      const eventId = candidate?.getAttribute("data-event-id");
      const thread = { article, ...(eventId ? { eventId, anchor: candidate?.id } : {}) };
      const term = readerThreadTerm(article, eventId || undefined);
      const discussion = Array.from(document.querySelectorAll<HTMLElement>("[data-discussion-term]"))
        .find(element => element.dataset.discussionTerm === term);
      const top = restoreReaderScroll(pending.scrollY, document.documentElement.scrollHeight - innerHeight);
      if (top !== null) window.scrollTo({ top, behavior: "instant" });
      const button = discussion?.querySelector<HTMLButtonElement>("button");
      const bounds = button?.getBoundingClientRect();
      const visible = bounds && bounds.height > 0 && bounds.top >= 0 && bounds.bottom <= innerHeight;
      const target = (visible && button) || document.querySelector<HTMLButtonElement>(".article-comment-entry") ||
        document.querySelector<HTMLElement>("#article-top h1");
      if (target && !target.matches("button, a[href], [tabindex]")) target.tabIndex = -1;
      openDiscussion(target || null, thread);
    } catch {}
  }, [article, openDiscussion]);

  const value = useMemo(() => ({ article, fontSize, setFontSize, share, openDiscussion, openDirectory, registerDirectory, counts, savedStorageNotice, readLaterIds, addReadLater, openReadLater, favoriteIds, toggleFavorite, openFavorites, canRestart, resetReading }),
    [article, fontSize, setFontSize, share, openDiscussion, openDirectory, registerDirectory, counts, savedStorageNotice, readLaterIds, addReadLater, openReadLater, favoriteIds, toggleFavorite, openFavorites, canRestart, resetReading]);
  return <Register.Provider value={register}><Reader.Provider value={value}>
    {children}
    {readLaterOrigin && <ReadLater storageNotice={savedStorageNotice} origin={readLaterOrigin} items={readLaterIds.flatMap(id => {
      const item = known.get(id);
      return item ? [item] : [];
    })} close={() => setReadLaterOrigin(null)}
      removeItem={id => updateReadLater(id, current => current.includes(id) ? current.filter(item => item !== id) : current)}
      restoreItem={(id, previous, next) => updateReadLater(id, current => {
        if (current.includes(id)) return current;
        const previousIndex = previous === undefined ? -1 : current.indexOf(previous);
        const nextIndex = next === undefined ? -1 : current.indexOf(next);
        const index = previousIndex !== -1 ? previousIndex + 1 : nextIndex !== -1 ? nextIndex : current.length;
        return [...current.slice(0, index), id, ...current.slice(index)];
      })}/>}
    {favoritesOrigin && <ReadLater storageNotice={savedStorageNotice} kind="favorites" origin={favoritesOrigin}
      items={favoriteIds.flatMap(id => { const item = known.get(id); return item ? [item] : []; })}
      close={() => setFavoritesOrigin(null)}
      removeItem={id => updateFavorite(id, current => current.filter(item => item !== id))}
      restoreItem={id => updateFavorite(id, current => current.includes(id) ? current : [id, ...current])}/>}
    {panel && <ReaderPanels key={panel.kind === "share" ? "share" : "reading"} panel={panel} directory={directory} close={() => setPanel(null)} reportCount={reportCount}/>}
  </Reader.Provider></Register.Provider>;
}

export function ReaderArticle({ article }: { article: ReaderIdentity }) {
  const register = useContext(Register);
  useLayoutEffect(() => register(article), [register, article]);
  return <span hidden data-reader-article/>;
}

export function useReader() { return useContext(Reader); }

export type { ReaderPanel };
