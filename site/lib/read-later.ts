import type { ReaderIdentity } from "./reader";

export type ReadLaterArticle = ReaderIdentity & { cover?: string; summary?: string };
export const READ_LATER_KEY = "gsd:read-later:v1";
export const SAVED_ARTICLES_KEY = "gsd:saved-articles:v2";
export const LEGACY_BOOKMARK_PREFIX = "gsd:reading-bookmark:v1:";
export type SavedArticles = { version: 2; migrated: true; readLaterIds: string[]; favoriteIds: string[] };
const ids = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))] : [];
function parse(value: string | null) {
  try { return JSON.parse(value || "null"); } catch { return null; }
}

export function loadSavedCollections(storage: Storage, catalogue: readonly ReadLaterArticle[]): { collections: SavedArticles; persisted: boolean } {
  const saved = parse(storage.getItem(SAVED_ARTICLES_KEY));
  if (saved?.version === 2 && saved.migrated === true && Array.isArray(saved.readLaterIds) && Array.isArray(saved.favoriteIds)) {
    return { collections: { version: 2, migrated: true, readLaterIds: ids(saved.readLaterIds), favoriteIds: ids(saved.favoriteIds) }, persisted: true };
  }
  const previous = parse(storage.getItem(READ_LATER_KEY));
  const previousIds = ids(previous?.ids);
  const legacy = catalogue.filter(article => storage.getItem(LEGACY_BOOKMARK_PREFIX + article.id) === "1").map(article => article.id);
  // A v1 record, including an empty list, is authoritative. Old bookmarks must
  // never resurrect a removed queue entry. They are imported only as favorites.
  const readLaterIds = previous && Array.isArray(previous.ids) ? previousIds : legacy;
  const migrated: SavedArticles = { version: 2, migrated: true, readLaterIds,
    favoriteIds: [...new Set([...previousIds, ...legacy])] };
  try {
    writeSavedCollections(storage, migrated);
    return { collections: migrated, persisted: true };
  } catch {
    // Reading old data remains useful even if quota prevents the atomic upgrade.
    // No migration marker is written until both collections can be persisted.
    return { collections: migrated, persisted: false };
  }
}

export function readSavedCollections(storage: Storage, catalogue: readonly ReadLaterArticle[]): SavedArticles {
  const result = loadSavedCollections(storage, catalogue);
  if (!result.persisted) throw new Error("Saved article migration could not be persisted");
  return result.collections;
}

export function writeSavedCollections(storage: Storage, value: SavedArticles) {
  // Both independent collections and the migration guard survive or fail together.
  storage.setItem(SAVED_ARTICLES_KEY, JSON.stringify({ version: 2, migrated: true,
    readLaterIds: ids(value.readLaterIds), favoriteIds: ids(value.favoriteIds) }));
}

export function addReadLaterId(current: readonly string[], id: string): string[] {
  return current.includes(id) ? [...current] : [id, ...current];
}
